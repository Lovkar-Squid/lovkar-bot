/**
 * votes.js - a vote on Discadia, answered in Discord.
 *
 * Discadia lets people vote for a listed server once a day, and can call a URL of ours for every
 * vote with a small JSON body: user_id, guild_id, server_title, server_slug, vote_url (see
 * https://discadia.com/help/vote-webhooks/). This is that URL. For each vote Sentinel says thank
 * you in #votes, hands the voter the Voter role, and writes the vote into the book, so the count
 * per person and per month exists somewhere Discadia does not keep it.
 *
 * The URL carries a token - Discadia signs nothing and sends no header, so the address itself
 * has to be the secret. It lives in VOTE_HOOK_TOKEN (the env file, never the repo) and the full
 * address is shown on the dashboard's Bot tab to whoever is signed in there; it is pasted into
 * Discadia by hand and never appears in a log line or a chat. Without a token the endpoint does
 * not exist. A call with the wrong token, another server's guild_id or a body that is not a vote
 * is a 404/400 and one line in the log, never a crash.
 *
 * Settings (environment):
 *   VOTE_HOOK_TOKEN   the secret part of the URL (required to switch this on)
 *   VOTE_CHANNEL      where thanks go (default votes)
 *   VOTE_ROLE         the role a voter gets (default Voter; empty = none)
 *   VOTE_ROLE_DAYS    how long they keep it after their last vote (default 7; 0 = for good)
 *   VOTE_QUIET        1 = count and reward, but post nothing
 *
 * Discadia can hand out a role itself, but its role picker never listed the roles this bot had
 * created (Voter, OG), so the role is Sentinel's job: given on the vote, and taken back by a sweep
 * once VOTE_ROLE_DAYS have passed since the person last voted - so a Voter is somebody who voted
 * this week, not somebody who voted once in spring.
 */

'use strict';

const crypto = require('node:crypto');
const { ChannelType } = require('discord.js');
const db = require('./db');

const CONF = {
  token: (process.env.VOTE_HOOK_TOKEN || '').trim(),
  channel: (process.env.VOTE_CHANNEL || 'votes').trim(),
  role: (process.env.VOTE_ROLE ?? 'Voter').trim(),
  roleDays: Math.max(0, Number(process.env.VOTE_ROLE_DAYS ?? 7) || 0),
  quiet: (process.env.VOTE_QUIET || '').trim() === '1',
};

/** How often the sweep looks for Voter roles whose week is up. */
const SWEEP_MS = 10 * 60 * 1000;

/** Two calls for the same person inside this window are one vote (Discadia retries on a slow answer). */
const DUPLICATE_MS = 60 * 1000;
const PATH = '/hooks/discadia/';

/** The address to paste into Discadia, or null while there is no token. */
function url(baseUrl) {
  if (!CONF.token || !baseUrl) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}${PATH}${CONF.token}`;
}

/** Constant-time check of the token in a request path. */
function matches(path) {
  if (!CONF.token || typeof path !== 'string' || !path.startsWith(PATH)) return false;
  const given = Buffer.from(path.slice(PATH.length).replace(/\/+$/, ''));
  const want = Buffer.from(CONF.token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function month(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

function findChannel(guild, name) {
  const want = String(name || '').replace(/^#/, '').toLowerCase();
  if (!want || !guild) return null;
  return guild.channels.cache.find(
    (c) => (c.id === want || String(c.name || '').toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

/** What the vote looks like, or null when it is not one. Pure, for the test. */
function reading(body, guildId) {
  if (!body || typeof body !== 'object') return null;
  const userId = String(body.user_id || '').trim();
  if (!/^\d{15,22}$/.test(userId)) return null;
  const forGuild = String(body.guild_id || '').trim();
  if (guildId && forGuild && forGuild !== String(guildId)) return null;
  return {
    userId,
    voteUrl: typeof body.vote_url === 'string' && /^https:\/\/discadia\.com\//.test(body.vote_url) ? body.vote_url : null,
    title: typeof body.server_title === 'string' ? body.server_title.slice(0, 100) : '',
  };
}

/** Counts in the book: this vote's number for the person this month and all time. */
function tally(userId, now = Date.now()) {
  const m = month(now);
  const monthKey = `votes:month:${m}:${userId}`;
  const allKey = `votes:user:${userId}`;
  const thisMonth = (Number(db.get(monthKey)) || 0) + 1;
  const allTime = (Number(db.get(allKey)) || 0) + 1;
  const total = (Number(db.get('votes:total')) || 0) + 1;
  db.set(monthKey, String(thisMonth));
  db.set(allKey, String(allTime));
  db.set('votes:total', String(total));
  db.set(`votes:last:${userId}`, String(now));
  return { thisMonth, allTime, total };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** The thank-you line. Pure, for the test. */
function line(userId, counts, voteUrl) {
  const who = `<@${userId}>`;
  const nth = counts.thisMonth === 1 ? 'their first vote this month' : `their ${ordinal(counts.thisMonth)} vote this month`;
  const all = counts.allTime > 1 ? `, ${counts.allTime} all time` : '';
  const link = voteUrl ? ` Vote too: <${voteUrl}>` : '';
  return `🗳️ ${who} voted for the server on Discadia - thank you! That is ${nth}${all}.${link}`;
}

/**
 * One vote: count it, thank them, give the role. Returns what was done. Never throws - a
 * voter who left the server, a missing channel or a role the bot cannot give are each one log
 * line, and the vote is still counted.
 */
async function vote(guild, body, { log = console.log, now = Date.now() } = {}) {
  const out = { counted: false, duplicate: false, thanked: false, role: false, userId: null };
  const v = reading(body, guild?.id);
  if (!v) return out;
  out.userId = v.userId;
  const last = Number(db.get(`votes:last:${v.userId}`)) || 0;
  if (now - last < DUPLICATE_MS) {
    out.duplicate = true;
    log(`[votes] ${v.userId} again within a minute - counted once`);
    return out;
  }
  const counts = tally(v.userId, now);
  out.counted = true;

  let member = null;
  try {
    member = await guild.members.fetch(v.userId);
  } catch (e) {
    log(`[votes] ${v.userId} voted but is not in the server (${e.message})`);
  }
  const tag = member?.user?.tag || v.userId;
  db.event('vote', tag, `${ordinal(counts.thisMonth)} this month, ${counts.allTime} all time`);
  log(`[votes] ${tag} voted on Discadia - ${ordinal(counts.thisMonth)} this month, ${counts.allTime} all time (${counts.total} in all)`);

  if (member && CONF.role) {
    const role = guild.roles.cache.find((r) => r.name.toLowerCase() === CONF.role.toLowerCase());
    if (!role) {
      log(`[votes] no role called "${CONF.role}" - nothing to give`);
    } else {
      // every vote renews the week, whether or not the role has to be given again
      if (CONF.roleDays > 0) db.set(`votes:roleuntil:${v.userId}`, String(now + CONF.roleDays * 86_400_000));
      if (!member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role, 'voted for the server on Discadia');
          out.role = true;
        } catch (e) {
          log(`[votes] could not give ${tag} ${role.name}: ${e.message}`);
        }
      }
    }
  }

  if (!CONF.quiet) {
    const channel = findChannel(guild, CONF.channel);
    if (!channel) {
      log(`[votes] no #${CONF.channel} - the thank-you has nowhere to go`);
    } else {
      try {
        // the name renders as a mention, but nobody is pinged for saying thank you
        await channel.send({ content: line(v.userId, counts, v.voteUrl), allowedMentions: { parse: [] } });
        out.thanked = true;
      } catch (e) {
        log(`[votes] could not post in #${channel.name}: ${e.message}`);
      }
    }
  }
  return out;
}

/**
 * Take the role back from everyone whose week is up. Members wearing the role with no date in
 * the book (given by hand, or before there were dates) are left alone - the sweep only undoes
 * what a vote did. Returns the tags it took the role from.
 */
async function sweep(guild, { log = console.log, now = Date.now() } = {}) {
  const taken = [];
  if (!CONF.role || CONF.roleDays <= 0 || !guild) return taken;
  const role = guild.roles.cache.find((r) => r.name.toLowerCase() === CONF.role.toLowerCase());
  if (!role) return taken;
  for (const member of role.members.values()) {
    const until = Number(db.get(`votes:roleuntil:${member.id}`)) || 0;
    if (!until || now < until) continue;
    try {
      await member.roles.remove(role, `the ${CONF.roleDays} days after their last Discadia vote are up`);
      db.set(`votes:roleuntil:${member.id}`, '0');
      taken.push(member.user?.tag || member.id);
      log(`[votes] ${member.user?.tag || member.id}: ${role.name} taken back - ${CONF.roleDays} days since their last vote`);
    } catch (e) {
      log(`[votes] could not take ${role.name} from ${member.user?.tag || member.id}: ${e.message}`);
    }
  }
  return taken;
}

/** Start the sweep. Nothing to do without a token, a role, or a book. */
function start(client, { log = console.log, guildId } = {}) {
  if (!CONF.token) { log('[votes] off (no VOTE_HOOK_TOKEN) - no vote webhook, no Voter sweep'); return null; }
  const guild = () => (guildId ? client?.guilds?.cache?.get(guildId) : client?.guilds?.cache?.first());
  if (!guild()) { log('[votes] no guild - off'); return null; }
  if (!db.ready) { log('[votes] no book - votes are answered but not counted, and the Voter role is not timed'); return null; }
  log(`[votes] on: thanks in #${CONF.channel}${CONF.role ? `, ${CONF.role} role${CONF.roleDays ? ` for ${CONF.roleDays} days` : ''}` : ''}`
    + `, ${Number(db.get('votes:total')) || 0} counted so far`);
  const run = () => sweep(guild(), { log }).catch((e) => log(`[votes] sweep: ${e.message}`));
  run();
  const timer = setInterval(run, SWEEP_MS);
  timer.unref?.();
  return { sweep: (opts) => sweep(guild(), { log, ...opts }), stop: () => clearInterval(timer) };
}

/**
 * The HTTP side: called by the dashboard's server for every path under /hooks/. Answers the
 * request itself and returns true; false means "not mine" and the caller carries on.
 */
async function handle(req, res, path, { guild, log = console.log, send, readJson } = {}) {
  if (!path.startsWith('/hooks/')) return false;
  if (!CONF.token || !matches(path)) {
    send(res, 404, { error: 'no such thing here' });
    return true;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'POST a vote' });
    return true;
  }
  let body;
  try {
    body = await readJson(req, 8 * 1024);
  } catch (e) {
    send(res, 400, { error: 'that is not JSON' });
    return true;
  }
  const g = typeof guild === 'function' ? guild() : guild;
  if (!g) {
    send(res, 503, { error: 'the bot is not in the server yet' });
    return true;
  }
  const out = await vote(g, body, { log });
  if (!out.userId) {
    log(`[votes] a call that was not a vote: ${JSON.stringify(body).slice(0, 200)}`);
    send(res, 400, { error: 'not a vote' });
    return true;
  }
  send(res, 200, { ok: true, counted: out.counted, duplicate: out.duplicate });
  return true;
}

/** What the dashboard shows. */
function status(baseUrl) {
  const m = month();
  return {
    on: Boolean(CONF.token),
    url: url(baseUrl),
    total: Number(db.get('votes:total')) || 0,
    month: m,
    channel: CONF.channel,
    role: CONF.role,
  };
}

module.exports = { handle, vote, sweep, start, reading, tally, line, url, matches, status, CONF, PATH };
