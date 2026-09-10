/**
 * bump.js - "the bump is free again".
 *
 * Server-listing bots (DISBOARD and its kind) push the server to the top of their list when a
 * person types /bump, and then make everyone wait two hours before the next one. The bots may not
 * bump for you - an automated bump is against their rules and Discord's, and gets a server delisted -
 * so the most Sentinel can do is remember the moment the last bump landed and tap Lovkar on the
 * shoulder when the two hours are up. That is this file.
 *
 * How it knows: the listing bot answers every /bump in the channel it was typed in, with "Bump done"
 * when it worked and "please wait another N minutes" when it was too early. Both are read here - the
 * first sets the clock, the second corrects it - and the reminder goes to the same channel, where
 * /bump has to be typed anyway. The clock is written into the book, so a restart in the middle of
 * the two hours still reminds on time, and a bot that was down when the time came reminds as soon
 * as it is back. One reminder per bump; if it goes unanswered, a nudge every so often, never more
 * than one an hour.
 *
 * Settings (environment, all optional):
 *   BUMP_BOTS       which listing bots to watch, "name:botId:cooldownMinutes" separated by commas.
 *                   Default: disboard:302050872383242240:120,discadia:*:120
 *                   A "*" for the id matches any bot account whose username contains the name, so
 *                   a listing bot can be added without looking its id up; the cooldown is the
 *                   fallback - what the bot itself says ("next bump in 6 hours") always wins.
 *   BUMP_CHANNEL    ping here instead of where the bump was typed (a channel name or id)
 *   BUMP_USER       Discord user id to ping; default: the server's owner
 *   BUMP_DM         1 to also send a DM (reaches a phone even with channel pings muted); default off
 *   BUMP_NUDGE_MIN  minutes between nudges while a free bump stays unused; default 180, 0 = never nudge
 *   BUMP_ENABLED    0 to switch the whole thing off
 */

'use strict';

const { ChannelType } = require('discord.js');
const db = require('./db');

const DEFAULT_BOTS = 'disboard:302050872383242240:120,discadia:*:120';

function parseBots(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const [name, id, minutes] = part.split(':').map((s) => (s || '').trim());
    if (!name || !(id === '*' || /^\d{15,22}$/.test(id))) continue;
    const cooldown = Math.max(1, Number(minutes) || 120);
    out.push({ name: name.toLowerCase(), id, cooldownMs: cooldown * 60 * 1000 });
  }
  return out;
}

const CONF = {
  enabled: (process.env.BUMP_ENABLED || '1').trim() !== '0',
  bots: parseBots(process.env.BUMP_BOTS || DEFAULT_BOTS),
  channel: (process.env.BUMP_CHANNEL || '').trim(),
  userId: (process.env.BUMP_USER || '').trim(),
  dm: (process.env.BUMP_DM || '').trim() === '1',
  nudgeMs: Math.max(0, Number(process.env.BUMP_NUDGE_MIN ?? 180) || 0) * 60 * 1000,
};

/** Never nudge more often than this, whatever the setting says. */
const NUDGE_FLOOR_MS = 60 * 60 * 1000;
/** How often the clock is looked at. A minute late is fine; a poll every second is not. */
const CHECK_MS = 30 * 1000;

/** All the text a message carries, for the pattern match: content plus every embed's words. */
function textOf(message) {
  const bits = [message?.content || ''];
  for (const e of message?.embeds || []) {
    bits.push(e?.title || '', e?.description || '');
    for (const f of e?.fields || []) bits.push(f?.name || '', f?.value || '');
    bits.push(e?.footer?.text || '');
  }
  return bits.join('\n').toLowerCase();
}

/**
 * What a listing bot's message means: 'done' when a bump just landed, { waitMs } when it said
 * how long is left, null when it is something else (help text, an error, a listing card).
 * Pure, so the test can read it.
 */
function reading(text) {
  const t = String(text || '').toLowerCase();
  // DISBOARD: "Please wait another 1 hours 23 minutes until the server can be bumped"
  // others:   "you can bump again in 45 minutes" / "next bump in 2 hours" / "bumped! next bump in 6h"
  const m = t.match(/(?:wait(?: another)?|again in|next bump(?: is)? in|try again in|cooldown[^\d]{0,20})\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/);
  const waitMs = m && (m[1] || m[2]) ? ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60 * 1000 : 0;
  const done = /bump\s*(done|successful|succeeded|complete)/.test(t) || /successfully bumped/.test(t)
    || /(server|has been|was)\s+bumped/.test(t) || /\bbumped!/.test(t);
  if (done) return waitMs > 0 ? { done: true, waitMs } : 'done';
  if (waitMs > 0) return { waitMs };
  return null;
}

/** The listing bot a message came from, by id or - for a "*" entry - by the bot's username. */
function matchBot(author) {
  if (!author) return null;
  const name = String(author.username || author.tag || '').toLowerCase();
  return CONF.bots.find((b) => b.id === author.id || (b.id === '*' && author.bot && name.includes(b.name))) || null;
}

function key(bot, what) {
  return `bump:${bot.name}:${what}`;
}

function findChannel(guild, name) {
  const want = String(name || '').replace(/^#/, '').toLowerCase();
  if (!want || !guild) return null;
  return guild.channels.cache.find(
    (c) => (c.id === want || String(c.name || '').toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

/** The moment the next bump is allowed, or null when no bump has been seen yet. */
function dueAt(bot) {
  const due = Number(db.get(key(bot, 'due')));
  return Number.isFinite(due) && due > 0 ? due : null;
}

/**
 * A message arrived. Only the listing bots' own messages matter; everything else is dropped in
 * the first line, which is what keeps this cheap on a busy server.
 */
function onMessage(message, log = console.log) {
  if (!CONF.enabled || !message?.author) return false;
  const bot = matchBot(message.author);
  if (!bot) return false;
  const what = reading(textOf(message));
  if (!what) return false;
  const now = Date.now();
  const isDone = what === 'done' || what.done === true;
  const due = now + (what.waitMs > 0 ? what.waitMs : bot.cooldownMs);
  db.set(key(bot, 'due'), String(due));
  db.set(key(bot, 'channel'), message.channelId);
  db.set(key(bot, 'reminded'), '0');
  if (isDone) {
    db.event('bump', bot.name, `bumped in #${message.channel?.name || message.channelId}`);
    log(`[bump] ${bot.name}: bumped - the next one is free at ${new Date(due).toLocaleTimeString()}`);
  } else {
    log(`[bump] ${bot.name}: not yet - free at ${new Date(due).toLocaleTimeString()}`);
  }
  return true;
}

/** The reminder text. Pure, for the test. */
function line(bot, mention, nudge) {
  const who = mention ? `${mention} ` : '';
  return nudge
    ? `${who}the ${bot.name.toUpperCase()} bump is still free - \`/bump\` when you have a second. 🚀`
    : `${who}the ${bot.name.toUpperCase()} bump is free again - \`/bump\` 🚀`;
}

async function remind(client, guild, bot, { log = console.log, nudge = false } = {}) {
  const userId = CONF.userId || guild.ownerId;
  const channel = findChannel(guild, CONF.channel || db.get(key(bot, 'channel')));
  const mention = userId ? `<@${userId}>` : '';
  let sent = false;
  if (channel) {
    try {
      await channel.send({ content: line(bot, mention, nudge), allowedMentions: { users: userId ? [userId] : [] } });
      sent = true;
      log(`[bump] ${bot.name}: ${nudge ? 'nudged' : 'reminded'} in #${channel.name}`);
    } catch (e) {
      log(`[bump] ${bot.name}: could not post in #${channel.name}: ${e.message}`);
    }
  } else {
    log(`[bump] ${bot.name}: no channel to remind in - waiting for a first /bump to learn it`);
  }
  if (CONF.dm && userId) {
    try {
      const user = await client.users.fetch(userId);
      await user.send({ content: line(bot, '', nudge), allowedMentions: { parse: [] } });
      sent = true;
    } catch (e) {
      log(`[bump] ${bot.name}: could not DM ${userId}: ${e.message}`);
    }
  }
  return sent;
}

/**
 * The clock. For each bot: if the bump is free and nobody has been told, tell them; if they were
 * told and did nothing for a good while, tell them again - but never more than once an hour.
 */
async function check(client, guild, { log = console.log, now = Date.now() } = {}) {
  for (const bot of CONF.bots) {
    const due = dueAt(bot);
    if (!due || now < due) continue;
    const reminded = Number(db.get(key(bot, 'reminded'))) || 0;
    if (!reminded) {
      if (await remind(client, guild, bot, { log })) db.set(key(bot, 'reminded'), String(now));
      continue;
    }
    if (CONF.nudgeMs > 0 && now - reminded >= Math.max(CONF.nudgeMs, NUDGE_FLOOR_MS)) {
      if (await remind(client, guild, bot, { log, nudge: true })) db.set(key(bot, 'reminded'), String(now));
    }
  }
}

function start(client, { log = console.log, guildId } = {}) {
  if (!CONF.enabled) { log('[bump] off (BUMP_ENABLED=0)'); return null; }
  if (!CONF.bots.length) { log('[bump] no listing bots configured (BUMP_BOTS) - off'); return null; }
  const guild = guildId ? client?.guilds?.cache?.get(guildId) : client?.guilds?.cache?.first();
  if (!guild) { log('[bump] no guild - off'); return null; }
  if (!db.ready) { log('[bump] no book to keep the clock in - off'); return null; }
  const names = CONF.bots.map((b) => {
    const due = dueAt(b);
    return `${b.name} (${b.cooldownMs / 60000}m${due ? `, next free ${new Date(due).toLocaleTimeString()}` : ', no bump seen yet'})`;
  });
  log(`[bump] watching ${names.join(', ')}; reminders go to ${CONF.channel ? `#${CONF.channel}` : 'the channel the bump was typed in'}`
    + `${CONF.dm ? ' and by DM' : ''}`);
  const run = () => check(client, guild, { log }).catch((e) => log(`[bump] ${e.message}`));
  run();
  const timer = setInterval(run, CHECK_MS);
  timer.unref?.();
  return { check: (opts) => check(client, guild, { log, ...opts }), stop: () => clearInterval(timer) };
}

module.exports = { start, check, onMessage, reading, textOf, line, parseBots, matchBot, CONF };
