/**
 * The queue: pictures dropped in now, posted one at a time over the coming weeks.
 *
 * <p>A server goes quiet between releases, and the fix is not to make more work - it is to spread
 * out the work already done. Twenty screenshots taken in one good evening, dropped on the
 * dashboard at once, become a sneak peek every few days for a month.</p>
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
/** How long between one going out and the next. */
const EVERY_HOURS = Number(process.env.QUEUE_EVERY_HOURS || 72);
/** Only post between these hours (server local time), so nothing goes out at four in the morning. */
const FROM_HOUR = Number(process.env.QUEUE_FROM_HOUR || 9);
const TO_HOUR = Number(process.env.QUEUE_TO_HOUR || 22);
/** How often the clock is looked at. */
const SWEEP_MS = Number(process.env.QUEUE_SWEEP_MINUTES || 15) * 60 * 1000;
const ENABLED = process.env.QUEUE_ENABLED !== '0';

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

/**
 * Put pictures in the queue.
 *
 * @param kind   'sneak' or 'bts'
 * @param files  [{ name, data: Buffer }]
 * @param when   the first one may go out at this time; the rest follow at EVERY_HOURS apart
 * @returns { queued, waiting, first }
 */
function add(kind, files, { caption, who, when, log = () => {} } = {}) {
  if (!packs.about(kind)) throw new Error(`no such pack: ${kind}`);
  if (!files || !files.length) throw new Error('no files');
  if (!db.ready) throw new Error('the bot is not keeping a book, so nothing can wait in a queue');
  if (!usable()) throw new Error(`there is nowhere to keep them (${STORE} is not writable)`);

  // Whatever is already waiting decides when the new ones may go: they join the back of the line.
  const waiting = db.queueWaiting();
  const last = waiting.reduce((t, row) => Math.max(t, row.due || 0), 0);
  let at = Math.max(Number(when) || Date.now(), last + EVERY_HOURS * 3600 * 1000);

  for (const f of files) {
    if (f.data.length > packs.MAX_BYTES) {
      throw new Error(`${f.name} is ${(f.data.length / 1048576).toFixed(1)} MB; `
        + `${packs.MAX_BYTES / 1048576} MB is the most`);
    }
    db.queueAdd({
      kind, file: keep(f.name, f.data), name: f.name, bytes: f.data.length,
      caption: caption || null, who, due: at,
    });
    at += EVERY_HOURS * 3600 * 1000;
  }
  log(`[queue] ${who || 'someone'} queued ${files.length} picture(s) as ${kind}; `
    + `${db.queueWaiting().length} waiting`);
  db.bump('queued', files.length);
  return { queued: files.length, waiting: db.queueWaiting().length, first: waiting.length ? null : Date.now() };
}

/** Whether the hour of the day is one this server posts at. */
function awake(now = new Date()) {
  const h = now.getHours();
  if (FROM_HOUR <= TO_HOUR) return h >= FROM_HOUR && h < TO_HOUR;
  return h >= FROM_HOUR || h < TO_HOUR;                 // a window that crosses midnight
}

/** Post the next one, if there is one and the time is right. */
async function tick(guild, { log = () => {}, now = Date.now(), force = false } = {}) {
  if (!ENABLED && !force) return null;
  const row = db.queueNext(now);
  if (!row) return null;
  if (!force && !awake(new Date(now))) return null;

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
  if (waiting.length) {
    log(`[queue] ${waiting.length} picture(s) waiting, next one due `
      + `${new Date(waiting[0].due || Date.now()).toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  sweep().catch(() => {});
  const timer = setInterval(() => sweep().catch(() => {}), SWEEP_MS);
  timer.unref?.();
  return { sweep, tick, stop: () => clearInterval(timer) };
}

module.exports = { add, tick, drop, list, watch, awake, keep, STORE, EVERY_HOURS, FROM_HOUR, TO_HOUR };
