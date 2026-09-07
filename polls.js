/**
 * Polls: a question with buttons Discord counts itself.
 *
 * <p>Discord has had a real poll of its own since 2024 - it renders properly on every client,
 * counts the votes server-side, hides the tally until you have voted and closes itself at the
 * hour you asked for. Building one out of reactions or buttons would be worse in every way, so
 * this module does not: it sends Discord's poll and stays out of the way.</p>
 *
 * <p>What Discord will not do is remember. A poll's numbers live in the message and nowhere else,
 * and a message can be deleted. So the book keeps the question, where it was asked and, once the
 * poll has closed, what people actually said - which is the part worth having a year later.</p>
 *
 * <p>Two kinds, because supporters and the wider server are not always being asked the same
 * thing: a supporters poll goes to the private channel, a public one to the open channel.</p>
 */

'use strict';

const { PollLayoutType } = require('discord.js');
const db = require('./db');

/** Where each kind is asked. Both are channel names, and both can be moved from the environment. */
const KINDS = {
  supporters: {
    channel: process.env.POLL_SUPPORTER_CHANNEL || 'polls',
    label: 'Supporters poll',
  },
  public: {
    channel: process.env.POLL_PUBLIC_CHANNEL || 'community-polls',
    label: 'Poll',
  },
};

/** Discord's own limits, which are not worth discovering by having a send refused. */
const MAX_ANSWERS = 10;
const MAX_QUESTION = 300;
const MAX_ANSWER = 55;
const MIN_HOURS = 1;
const MAX_HOURS = 768;                                  // thirty-two days
/** How often a poll that has run out of time is looked at, to write down what it said. */
const SWEEP_MS = Number(process.env.POLL_SWEEP_SECONDS || 60) * 1000;

function kinds() {
  return Object.keys(KINDS);
}

function about(kind) {
  return KINDS[kind] || null;
}

/**
 * Read the answers out of one line.
 *
 * <p>`Yes | No | Not sure` is the shape, because a poll typed into a slash command is one field.
 * A newline works too, for anyone pasting from somewhere else. An answer may start with an emoji,
 * which is then the answer's emoji rather than part of its text.</p>
 */
function answers(text) {
  return String(text ?? '')
    .split(/\s*[|\n]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ANSWERS)
    .map((raw) => {
      // one leading emoji, then a space, then the words
      const m = /^(\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?|<a?:\w+:\d+>)\s+(.+)$/u.exec(raw);
      const text_ = (m ? m[2] : raw).slice(0, MAX_ANSWER);
      return m ? { text: text_, emoji: m[1] } : { text: text_ };
    })
    .filter((a) => a.text);
}

/** Discord counts in whole hours, and refuses anything outside its own range. */
function hours(value, fallback = 24) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.round(n)));
}

function findChannel(guild, name) {
  const want = String(name || '').replace(/^#/, '').toLowerCase();
  return guild.channels.cache.find(
    (c) => (c.id === want || c.name.toLowerCase() === want) && typeof c.send === 'function') || null;
}

/**
 * Ask one.
 *
 * @param what  { kind, question, answers, hours, multi, host }
 * @returns { id, url, channel, ends }
 */
async function ask(guild, what, log = () => {}) {
  const kind = about(what.kind);
  if (!kind) throw new Error(`no such poll: ${what.kind}`);

  const question = String(what.question || '').trim().slice(0, MAX_QUESTION);
  if (!question) throw new Error('a poll needs a question');

  const list = Array.isArray(what.answers) ? what.answers : answers(what.answers);
  if (list.length < 2) throw new Error('a poll needs at least two answers, separated by |');

  const channel = findChannel(guild, what.channel || kind.channel);
  if (!channel) throw new Error(`there is no #${what.channel || kind.channel} in this server`);

  const runFor = hours(what.hours);
  const msg = await channel.send({
    poll: {
      question: { text: question },
      answers: list,
      duration: runFor,
      allowMultiselect: Boolean(what.multi),
      layoutType: PollLayoutType.Default,
    },
    allowedMentions: { parse: [] },
  });

  const ends = Date.now() + runFor * 3600 * 1000;
  db.pollNew({
    id: msg.id, kind: what.kind, channelId: channel.id, question,
    answers: list.map((a) => a.text), host: what.host, ends,
  });
  db.event('poll', question, `${what.host || 'someone'} asked in #${channel.name}, ${runFor}h`);
  db.bump('pollsAsked');
  log(`[poll] ${what.host || 'someone'} asked "${question}" in #${channel.name} - `
    + `${list.length} answers, ${runFor}h`);
  return { id: msg.id, url: msg.url, channel: channel.name, ends };
}

/** What a finished poll said, in the shape the book keeps. */
function result(poll) {
  if (!poll) return [];
  const out = [];
  for (const [, a] of poll.answers) {
    out.push({ text: a.text ?? a.poll_media?.text ?? '', votes: a.voteCount ?? 0 });
  }
  return out.sort((x, y) => y.votes - x.votes);
}

/** Close one early. Discord finalises the numbers itself. */
async function close(client, id, log = () => {}) {
  const row = db.polls(200).find((p) => p.id === String(id));
  if (!row) throw new Error('no such poll');
  if (row.result) throw new Error('that one is already closed');
  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  const msg = channel && await channel.messages.fetch(row.id).catch(() => null);
  if (!msg || !msg.poll) throw new Error('the poll message is gone');
  if (!msg.poll.resultsFinalized) await msg.poll.end();
  const said = result(msg.poll);
  db.pollClose(row.id, said);
  log(`[poll] "${row.question}" closed - ${said.map((s) => `${s.text} ${s.votes}`).join(', ')}`);
  return said;
}

/**
 * Watch for polls whose time is up, and write down what they said.
 *
 * <p>Discord closes the poll on its own; this only reads the final numbers into the book so they
 * survive the message. A poll whose message has been deleted is written off rather than retried
 * for ever.</p>
 */
function watch(client, { log = console.log } = {}) {
  if (!db.ready) return null;

  const sweep = async () => {
    const now = Date.now();
    for (const p of db.polls(100)) {
      if (p.result || !p.ends || p.ends > now + 5000) continue;
      try {
        const channel = await client.channels.fetch(p.channel_id).catch(() => null);
        const msg = channel && await channel.messages.fetch(p.id).catch(() => null);
        if (!msg || !msg.poll) {
          db.pollClose(p.id, []);                       // the message is gone; stop asking
          continue;
        }
        if (!msg.poll.resultsFinalized) continue;       // Discord has not finished counting yet
        const said = result(msg.poll);
        db.pollClose(p.id, said);
        log(`[poll] "${p.question}" ended - ${said.map((s) => `${s.text} ${s.votes}`).join(', ')}`);
      } catch (e) {
        log(`[poll] could not close ${p.id}: ${e.message}`);
      }
    }
  };

  sweep().catch((e) => log(`[poll] ${e.message}`));
  const timer = setInterval(() => sweep().catch((e) => log(`[poll] ${e.message}`)), SWEEP_MS);
  timer.unref?.();
  return { sweep, stop: () => clearInterval(timer) };
}

/** Everything the dashboard shows. */
function list(n = 25) {
  return db.polls(n).map((p) => ({
    ...p,
    answers: p.answers ? JSON.parse(p.answers) : [],
    result: p.result ? JSON.parse(p.result) : null,
  }));
}

module.exports = {
  KINDS, MAX_ANSWERS, MAX_QUESTION, MAX_ANSWER, MIN_HOURS, MAX_HOURS,
  kinds, about, answers, hours, ask, close, watch, list, result,
};
