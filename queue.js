/**
 * The queue: pictures dropped in now, posted one at a time over the coming weeks.
 *
 * <p>A server goes quiet between releases, and the fix is not to make more work - it is to spread
 * out the work already done. Twenty screenshots taken in one good evening, dropped on the
 * dashboard at once, become a sneak peek every few days for a month.</p>
 *
 * <p>There are two ways of deciding when the next one goes out, and only one of them runs at a
 * time. Out of the box it is the spacing rule: each picture is given a date
 * {@code QUEUE_EVERY_HOURS} (72) after the one in front of it, and the sweep posts whichever is
 * owed, as long as the hour is inside the waking window {@code QUEUE_FROM_HOUR}..{@code
 * QUEUE_TO_HOUR} (9..22) so that nothing goes out at four in the morning. It needs no setting up,
 * and it posts at whatever minute the sweep happens to land on.</p>
 *
 * <p>Set {@code QUEUE_AT} to a list of times - {@code 18:00}, or {@code 12:30,19:00} - and the
 * clock takes over. The spacing is then dropped altogether: everything in the queue is simply due,
 * and one picture goes out at each named time, oldest first, on the days named in {@code
 * QUEUE_DAYS} ({@code mon,tue,...}; empty means every day). The sweep only looks every {@code
 * QUEUE_SWEEP_MINUTES} (15) and so rarely lands on the minute itself, so a named time stays owed
 * until {@code QUEUE_CATCHUP_MINUTES} (90) after it and is then missed rather than served late.
 * That last part is the whole point of the window: a bot switched off for two days should come
 * back and post one picture, not three in a row.</p>
 *
 * <p>Which named times have already been served is a line in the book ({@code queue:fired}, the
 * moment of the last one). It has to be, because this bot restarts on every deploy, and a mark
 * held only in memory would let the six o'clock picture go out again at a quarter past.</p>
 *
 * <p>The files live on the same volume as the book, under {@code /data/queue}, because a picture
 * waiting three weeks has to survive every redeploy in between; the book holds the order, the
 * caption and the date each one may go out. When one is posted it goes through {@link ./packs.js}
 * like any other pack, so there is one code path to the channel and one place that decides what
 * may be posted.</p>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const packs = require('./packs');

/** Where the waiting pictures sit. Beside the book, on the same volume, for the same reason. */
const STORE = process.env.QUEUE_DIR || path.join(path.dirname(process.env.DB_PATH || '/data/x'), 'queue');
/** Where the note lives that says which named time was served last. */
const FIRED = 'queue:fired';
/** The days of the week as they are written in QUEUE_DAYS, in the order Date.getDay() counts them. */
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** A number out of the environment, or the default when somebody has typed "an hour and a half". */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The settings, read once at startup. They sit in one object rather than in loose constants so
 * that a test can put the queue on a clock without setting the environment before requiring the
 * file; the three the dashboard prints are exported under their old names at the bottom.
 */
const CONF = {
  /** How long between one going out and the next, when the queue is on the spacing rule. */
  everyHours: Number(process.env.QUEUE_EVERY_HOURS || 72),
  /** Only post between these hours (server local time), so nothing goes out at four in the morning. */
  fromHour: Number(process.env.QUEUE_FROM_HOUR || 9),
  toHour: Number(process.env.QUEUE_TO_HOUR || 22),
  /** Times of day to post at, "18:00" or "12:30,19:00". Empty leaves the spacing rule in charge. */
  at: process.env.QUEUE_AT || '',
  /** Which days those times count on, "mon,fri". Empty means every day. */
  days: process.env.QUEUE_DAYS || '',
  /** How long after a named time it may still go out before the slot counts as missed. */
  catchupMinutes: num(process.env.QUEUE_CATCHUP_MINUTES, 90),
  /** How often the clock is looked at. */
  sweepMinutes: Number(process.env.QUEUE_SWEEP_MINUTES || 15),
  enabled: process.env.QUEUE_ENABLED !== '0',
};

function usable() {
  try {
    fs.mkdirSync(STORE, { recursive: true });
    fs.accessSync(STORE, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A name that cannot collide and cannot climb out of the store. */
function keep(name, data) {
  const safe = String(name).replace(/[/\\]/g, '_').slice(-80);
  const file = path.join(STORE, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
  fs.writeFileSync(file, data);
  return file;
}

// ---- the pure half, so the test can check it without a clock or Discord anywhere near it --------

/**
 * "18:00", or "12:30,19:00", as minutes past midnight, in order and without repeats.
 *
 * <p>Anything that is not a time of day is dropped rather than argued with, so a stray "25:00"
 * leaves the readable times alone. A setting with nothing readable in it at all comes back empty,
 * and empty is what puts the queue back on the spacing rule - a typo should slow the queue down,
 * never stop it.</p>
 */
function slots(text = CONF.at) {
  const found = [];
  for (const part of String(text ?? '').split(',')) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    found.push(h * 60 + min);
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/**
 * "mon,fri" as the numbers Date.getDay() gives. Nothing named means every day, and so does a
 * setting with nothing readable in it: a misspelt day should not quietly switch the queue off.
 */
function days(text = CONF.days) {
  const found = [];
  for (const part of String(text ?? '').split(',')) {
    const i = WEEK.indexOf(part.trim().slice(0, 3).toLowerCase());
    if (i >= 0) found.push(i);
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/** Whether the queue is on a clock at all, or still on the spacing rule. */
function onClock() {
  return slots().length > 0;
}

/** The named times as they are written, for the one line this prints at startup. */
function written(mins = slots()) {
  return mins.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
}

/** The mark in the book as a moment. It may have been written as an ISO date or as a plain epoch. */
function marked(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Which named time, if any, is owed at this moment.
 *
 * <p>A time is owed when it has passed, when it is no more than the catch-up window behind, and
 * when nothing at or after it has already been served. Yesterday's times are looked at as well as
 * today's, so a slot late in the evening can still be caught a few minutes after midnight.</p>
 *
 * <p>When several are owed at once - the bot came back an hour into the evening and both the six
 * and the seven o'clock times are behind it - the latest one wins and the rest are left. That is
 * what keeps a bot that has been away from emptying half the queue in a quarter of an hour.</p>
 *
 * @param now         the moment being asked about, as a Date or an epoch
 * @param lastFired   what the book says about the last one served, ISO or epoch, null if never
 * @returns the moment of the time that is owed, in epoch milliseconds, or null if none is
 */
function dueSlot(now = Date.now(), lastFired = null,
  { at = CONF.at, on = CONF.days, catchup = CONF.catchupMinutes } = {}) {
  const mins = slots(at);
  if (!mins.length) return null;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return null;

  const allowed = days(on);
  const grace = num(catchup, 90) * 60000;
  const since = marked(lastFired);
  let owed = null;

  for (const back of [1, 0]) {
    const day = new Date(t);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - back);
    if (allowed.length && !allowed.includes(day.getDay())) continue;
    for (const m of mins) {
      // setHours does the arithmetic in local time, which is the only way an hour named as 18:00
      // stays 18:00 on the day the clocks go back.
      const slot = new Date(day).setHours(0, m, 0, 0);
      if (slot > t) continue;                       // not yet
      if (t - slot > grace) continue;               // long gone: missed, rather than served late
      if (since && slot <= since) continue;         // this one has already had its picture
      if (owed === null || slot > owed) owed = slot;
    }
  }
  return owed;
}

/** Whether the hour of the day is one this server posts at. */
function awake(now = new Date()) {
  const h = now.getHours();
  if (CONF.fromHour <= CONF.toHour) return h >= CONF.fromHour && h < CONF.toHour;
  return h >= CONF.fromHour || h < CONF.toHour;         // a window that crosses midnight
}

/**
 * Put pictures in the queue.
 *
 * @param kind   'sneak' or 'bts'
 * @param files  [{ name, data: Buffer }]
 * @param when   the first one may go out at this time; on the spacing rule the rest follow at
 *               EVERY_HOURS apart, and on a clock they are all simply due
 * @returns { queued, waiting, first }
 */
function add(kind, files, { caption, who, when, log = () => {} } = {}) {
  if (!packs.about(kind)) throw new Error(`no such pack: ${kind}`);
  if (!files || !files.length) throw new Error('no files');
  if (!db.ready) throw new Error('the bot is not keeping a book, so nothing can wait in a queue');
  if (!usable()) throw new Error(`there is nowhere to keep them (${STORE} is not writable)`);

  // On the spacing rule whatever is already waiting decides when the new ones may go: they join
  // the back of the line. On a clock there is no line to work out - every picture is simply due,
  // and the named times decide which of them goes and when.
  const waiting = db.queueWaiting();
  const clock = onClock();
  const spacing = clock ? 0 : CONF.everyHours * 3600 * 1000;
  const last = waiting.reduce((t, row) => Math.max(t, row.due || 0), 0);
  let at = Math.max(Number(when) || Date.now(), clock ? 0 : last + spacing);

  for (const f of files) {
    if (f.data.length > packs.MAX_BYTES) {
      throw new Error(`${f.name} is ${(f.data.length / 1048576).toFixed(1)} MB; `
        + `${packs.MAX_BYTES / 1048576} MB is the most`);
    }
    db.queueAdd({
      kind, file: keep(f.name, f.data), name: f.name, bytes: f.data.length,
      caption: caption || null, who, due: at,
    });
    at += spacing;
  }
  log(`[queue] ${who || 'someone'} queued ${files.length} picture(s) as ${kind}; `
    + `${db.queueWaiting().length} waiting`);
  db.bump('queued', files.length);
  return { queued: files.length, waiting: db.queueWaiting().length, first: waiting.length ? null : Date.now() };
}

/** Post the next one, if there is one and the time is right. */
async function tick(guild, { log = () => {}, now = Date.now(), force = false } = {}) {
  if (!CONF.enabled && !force) return null;
  const row = db.queueNext(now);
  if (!row) return null;

  // Two ways of asking whether it is time, and which one answers depends on QUEUE_AT. The slot is
  // worked out even when the picture was asked for by hand, and claimed below if one is owed, so
  // that /queue now at ten past six does not leave the six o'clock slot to fire again at a quarter
  // past. Nothing is claimed until a picture has actually gone out: a slot whose picture turned
  // out to be missing from the store is still owed, and the next sweep offers it the one behind.
  const clock = onClock();
  const slot = clock ? dueSlot(now, db.get(FIRED)) : null;
  if (!force && (clock ? slot === null : !awake(new Date(now)))) return null;

  let data;
  try {
    data = fs.readFileSync(row.file);
  } catch (e) {
    log(`[queue] ${row.name} is gone from the store, dropping it: ${e.message}`);
    db.queueTaken(row.id, null);
    return null;
  }

  const out = await packs.post(guild, row.kind, [{ name: row.name, data }],
    row.caption || '', row.who ? `${row.who} (queued)` : 'the queue', log);
  db.queueTaken(row.id, out.urls[0]);
  if (slot !== null) db.set(FIRED, new Date(slot).toISOString());
  db.bump('queuePosted');
  try { fs.unlinkSync(row.file); } catch { /* the row is what matters */ }
  log(`[queue] posted ${row.name} to #${out.channel}; ${db.queueWaiting().length} still waiting`);
  return { ...out, name: row.name, id: row.id };
}

/** Take one back out before it goes. */
function drop(id, log = () => {}) {
  const row = db.queueList(500).find((r) => r.id === Number(id));
  if (!row) throw new Error('no such picture in the queue');
  if (row.posted_at) throw new Error('that one has already gone out');
  db.queueDrop(row.id);
  try { fs.unlinkSync(row.file); } catch { /* it may already be gone */ }
  log(`[queue] ${row.name} taken back out of the queue`);
  return { id: row.id, name: row.name };
}

/** What is waiting and what has gone, for the dashboard. */
function list(n = 60) {
  return db.queueList(n);
}

/** Watch the clock. */
function watch(client, { log = console.log, guildId } = {}) {
  if (!db.ready) return null;
  const guild = () => (guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first());

  const sweep = async () => {
    const g = guild();
    if (!g) return;
    await tick(g, { log }).catch((e) => log(`[queue] ${e.message}`));
  };
  const waiting = db.queueWaiting();
  if (waiting.length && onClock()) {
    const on = days().length ? `on ${days().map((d) => WEEK[d]).join(', ')}` : 'every day';
    log(`[queue] ${waiting.length} picture(s) waiting, one at ${written().join(', ')} ${on}`);
  } else if (waiting.length) {
    log(`[queue] ${waiting.length} picture(s) waiting, next one due `
      + `${new Date(waiting[0].due || Date.now()).toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  sweep().catch(() => {});
  const timer = setInterval(() => sweep().catch(() => {}), CONF.sweepMinutes * 60 * 1000);
  timer.unref?.();
  return { sweep, tick, stop: () => clearInterval(timer) };
}

module.exports = {
  add, tick, drop, list, watch, awake, keep, slots, days, onClock, dueSlot,
  CONF, STORE, FIRED,
  // The dashboard prints these three on the Packs page, under the names it has always used.
  EVERY_HOURS: CONF.everyHours, FROM_HOUR: CONF.fromHour, TO_HOUR: CONF.toHour,
};
