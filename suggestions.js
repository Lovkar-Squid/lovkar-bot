/**
 * The suggestion board: a pair of reactions on every idea, and one count of them a week.
 *
 * <p>#ideas-and-feedback is an ordinary text channel, so an idea posted there arrives as a message
 * like any other and nothing about it says "vote on this". The bot puts the 👍 and the 👎 on it
 * itself, which is the whole of the trick: a poll nobody had to set up, on a message nobody had to
 * format. Those two reactions are the ballot box rather than votes, so the bot's own are taken back
 * off the count before anything is written down.</p>
 *
 * <p>Discord keeps the votes. They sit on the message where everyone can see them and change their
 * mind, and they can be read back off the gateway at any time, so the book is not the record here -
 * it holds the tally as at the last recount, which is only what the digest sorts on. The one thing
 * that could not be worked out again from Discord is the date the last digest went out: without it
 * a restart posts the week's digest a second time, and a bot that spent the week switched off never
 * posts it at all. That date is the whole reason this file touches the book.</p>
 *
 * <p>Nothing here wires an event handler. bot.js does that, and hands {@link onMessage} every
 * message in the server and {@link onReaction} every reaction in it; both begin by asking whether
 * it was their channel and go back where they came from when it was not. Neither ever throws:
 * a suggestion that could not be reacted to is a line in the log, not a dead handler.</p>
 */

'use strict';

const db = require('./db');

/**
 * How often the clock is looked at. The digest itself is due once a week - checking hourly only
 * decides whether the week is up, and that costs one read of the book.
 */
const CHECK_MS = 3600 * 1000;
/** As much of a suggestion as the book keeps: enough to recognise it in the digest a week later. */
const EXCERPT = 300;
/** ...and as much of it as fits on one line of the digest without pushing the score off the end. */
const LINE = 90;
const DAY = 86400000;
/** Where the date of the last digest lives. */
const CLOCK = 'suggestions:digest';

const CONF = {
  channel: process.env.SUGGESTION_CHANNEL || 'ideas-and-feedback',
  up: process.env.SUGGESTION_UP || '👍',
  down: process.env.SUGGESTION_DOWN || '👎',
  minChars: Number(process.env.SUGGESTION_MIN_CHARS || 12),
  top: Number(process.env.SUGGESTION_TOP || 5),
  digestDays: Number(process.env.SUGGESTION_DIGEST_DAYS || 7),
  // The reactions are the useful half and cost nothing; SUGGESTION_DIGEST=0 keeps them and leaves
  // the channel alone otherwise.
  digest: process.env.SUGGESTION_DIGEST !== '0',
};

/** A link, in the shapes one is actually pasted into Discord - bare, or in the <angle> form. */
const LINK = /<?\bhttps?:\/\/\S+>?|<?\bwww\.\S+>?/gi;

// ---- the pure half, so the test can check it without Discord anywhere near it -------------------

/** What is left when the links are taken out: what the person actually said. */
function said(content) {
  return String(content ?? '').replace(LINK, ' ').replace(/\s+/g, ' ').trim();
}

/** How many files came with a message, whether that is a discord.js Collection or a plain array. */
function attached(message) {
  const a = message?.attachments;
  if (!a) return 0;
  if (typeof a.size === 'number') return a.size;
  if (typeof a.length === 'number') return a.length;
  return 0;
}

/** As much of a piece of text as is worth keeping, on one line, with the cut marked. */
function excerpt(text, n = EXCERPT) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

/**
 * Is this a suggestion, or is it somebody talking?
 *
 * <p>The bot has to guess, because the channel is used for both, and it should guess in the
 * direction of leaving people alone: a pair of reactions on "lol" reads as the bot being obtuse.
 * So a link with nothing said about it and anything shorter than a sentence are left as they are.
 * A picture is the exception - "like this?" with a screenshot under it is how half of the good
 * ones arrive, and the words in that case are not where the idea is.</p>
 *
 * @param message  { author: { bot }, content, attachments }
 */
function worthVotingOn(message) {
  if (!message || message.author?.bot) return false;    // its own messages included: it is a bot
  if (attached(message)) return true;
  const words = said(message.content);
  if (!words) return false;                             // nothing at all, or a bare link
  return words.length >= CONF.minChars;
}

/**
 * What the votes come to, with the bot's own two reactions taken back off.
 *
 * <p>Discord's own counts are used rather than the list of who voted: fetching the users behind
 * two reactions on every click would be a request per vote, to learn a number Discord already
 * sent. The bot's are the only ones that have to come off, and {@code reaction.me} says so.</p>
 *
 * @param counts  { up, down, mineUp, mineDown }
 */
function tally(counts = {}) {
  const off = (n, mine) => Math.max(0, (Number(n) || 0) - (mine ? 1 : 0));
  const up = off(counts.up, counts.mineUp);
  const down = off(counts.down, counts.mineDown);
  return { up, down, score: up - down };
}

/**
 * Is a digest owed?
 *
 * <p>Never having posted one counts as owed, so a fresh install posts its first at the first
 * check rather than a week later. The comparison is "at least this long ago" rather than "longer
 * than", because the hourly check will otherwise miss the exact moment and wait another hour.</p>
 */
function due(lastAt, now = Date.now(), days = CONF.digestDays) {
  const last = Number(lastAt) || 0;
  if (!last) return true;
  return now - last >= Math.max(0, days) * DAY;
}

/** Two emoji are the same one whether it arrives as a name, an id, or the <:name:id> form. */
function sameEmoji(emoji, want) {
  if (!emoji || !want) return false;
  const w = String(want);
  if (typeof emoji === 'string') return emoji === w;
  if (emoji.name === w) return true;
  if (emoji.id && (emoji.id === w || emoji.identifier === w)) return true;
  return Boolean(emoji.id) && (`<:${emoji.name}:${emoji.id}>` === w || `<a:${emoji.name}:${emoji.id}>` === w);
}

/** How long ago, in words, for the one line this prints at startup. */
function ago(ms) {
  const d = Math.floor(ms / DAY);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'} ago`;
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `${h} hour${h === 1 ? '' : 's'} ago` : 'less than an hour ago';
}

// ---- the board ----------------------------------------------------------------------------------

/**
 * The channel's id once start() has found it. Both handlers are called for everything that happens
 * in the server, so they need to answer "is this mine?" without a lookup; matching on the id is
 * that, and it keeps working if the channel is renamed while the bot is up.
 */
let boardId = null;

function isBoard(channel) {
  if (!channel) return false;
  if (boardId && channel.id === boardId) return true;
  const want = String(CONF.channel).replace(/^#/, '').toLowerCase();
  return channel.id === want || String(channel.name || '').toLowerCase() === want;
}

function inBoard(message) {
  if (!message) return false;
  if (boardId && (message.channelId === boardId || message.channel?.id === boardId)) return true;
  return isBoard(message.channel);
}

/** Write the message down as a suggestion. Doing it before reacting means a refused reaction still leaves a record. */
function record(message) {
  const text = String(message.content ?? '').trim();
  db.suggestionNew({
    id: message.id,
    channelId: message.channelId || message.channel?.id || null,
    author: message.author?.tag || message.author?.username || null,
    excerpt: excerpt(text) || `(${attached(message)} attachment${attached(message) === 1 ? '' : 's'})`,
    url: message.url || null,
    at: Number(message.createdTimestamp) || Date.now(),
  });
}

/**
 * Somebody posted. If it looks like an idea, it gets a ballot box.
 *
 * <p>Called for every message in the server, so the cheap question - was this even my channel -
 * is asked first.</p>
 */
async function onMessage(message, log = () => {}) {
  try {
    if (!message || !isBoard(message.channel)) return false;
    if (!worthVotingOn(message)) return false;
    if (db.suggestionSeen(message.id)) return false;    // already has its pair; a redelivery

    record(message);
    db.bump('suggestions');
    // One after the other rather than both at once: in parallel they land in whichever order
    // Discord answers, and a 👎 sitting first reads like the bot has an opinion.
    await message.react(CONF.up);
    await message.react(CONF.down);
    return true;
  } catch (e) {
    log(`[suggestions] could not open ${message?.id} for votes: ${e.message}`);
    return false;
  }
}

/** The 👍 and 👎 on a message as Discord currently has them. */
function countOn(message) {
  const out = { up: 0, down: 0, mineUp: false, mineDown: false };
  const cache = message?.reactions?.cache;
  const all = typeof cache?.values === 'function' ? [...cache.values()] : (Array.isArray(cache) ? cache : []);
  for (const r of all) {
    if (sameEmoji(r.emoji, CONF.up)) { out.up = Number(r.count) || 0; out.mineUp = Boolean(r.me); }
    else if (sameEmoji(r.emoji, CONF.down)) { out.down = Number(r.count) || 0; out.mineDown = Boolean(r.me); }
  }
  return out;
}

/**
 * Somebody voted, or took their vote back. Both events land here and both do the same thing:
 * count what is on the message now.
 *
 * <p>Recounting rather than adding and subtracting is deliberate. A vote can be removed while the
 * bot is down, two can arrive in the same second, and a reaction event can be delivered twice;
 * every one of those breaks a running total and none of them breaks a recount.</p>
 *
 * <p>The order of the checks is the point of this function: it is called for every reaction
 * anywhere in the server, and the two that would cost a request - fetching a partial reaction and
 * a partial message - come after the two that cost nothing.</p>
 */
async function onReaction(reaction, user, log = () => {}) {
  try {
    if (!reaction) return false;
    // The bot's own pair is the ballot box being set out, not somebody voting on anything.
    if (user?.bot) return false;
    if (!sameEmoji(reaction.emoji, CONF.up) && !sameEmoji(reaction.emoji, CONF.down)) return false;
    if (!inBoard(reaction.message)) return false;

    if (reaction.partial) await reaction.fetch();
    let message = reaction.message;
    if (!message) return false;
    if (message.partial) message = await message.fetch();
    if (!isBoard(message.channel)) return false;

    // A vote on something posted while the bot was away: the message is not in the book, but the
    // votes on it are real. Write it down now rather than throwing the count away.
    if (!db.suggestionSeen(message.id)) {
      if (!worthVotingOn(message)) return false;
      record(message);
    }
    const { up, down } = tally(countOn(message));
    db.suggestionScore(message.id, up, down);
    return true;
  } catch (e) {
    log(`[suggestions] could not count the votes on ${reaction?.message?.id}: ${e.message}`);
    return false;
  }
}

/**
 * The week's best ideas, in the channel they were posted in.
 *
 * <p>Nothing is posted unless something was actually voted for. An empty digest - or one made of
 * ideas nobody wanted - is worse than silence, because it teaches the channel to ignore the
 * digest. The clock is wound on either way: the week did pass, and leaving it unwound would mean
 * the first upvote of the new week triggers a "top ideas" of one item at some hour of the night.</p>
 *
 * <p>Already-digested ideas are not filtered out, because they cannot come round again: the window
 * is the same length as the gap between digests, so anything old enough to have been in the last
 * one has already fallen out of the back of the window.</p>
 *
 * @param channel  where to post, and the same channel the suggestions were posted in
 * @param force    post now whatever the clock says (and whether or not the digest is switched off)
 */
async function digest(channel, { log = () => {}, now = Date.now(), force = false } = {}) {
  if (!channel) return null;
  if (!CONF.digest && !force) return null;
  if (!force && !due(db.get(CLOCK), now, CONF.digestDays)) return null;

  const days = Math.max(1, CONF.digestDays);
  const top = db.suggestionsSince(now - days * DAY, Math.max(1, CONF.top))
    .map((s) => ({ ...s, score: (Number(s.up) || 0) - (Number(s.down) || 0) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (Number(b.up) || 0) - (Number(a.up) || 0));

  if (!top.length) {
    db.set(CLOCK, String(now));
    return null;
  }

  const lines = top.map((s, i) => {
    // Square brackets inside the text of a masked link break it, so they come out of the excerpt.
    const what = excerpt(s.excerpt || 'a suggestion', LINE).replace(/[[\]]/g, '');
    return `${i + 1}.  **+${s.score}**  ${s.url ? `[${what}](${s.url})` : what}`
      + (s.author ? `  ·  ${s.author}` : '');
  });
  const heading = days === 7 ? 'Top ideas this week' : `Top ideas of the last ${days} days`;

  // Nothing in here may ping anybody: the text is other people's words, and a name or a stray
  // @everyone in an excerpt would otherwise go off once a week for the whole server.
  await channel.send({
    content: `**${heading}**\n${lines.join('\n')}`,
    allowedMentions: { parse: [] },
  });

  for (const s of top) db.suggestionDigested(s.id);
  db.set(CLOCK, String(now));
  db.event('suggestions', 'digest', `${top.length} idea(s), best +${top[0].score}`);
  db.bump('digests');
  log(`[suggestions] digest posted in #${channel.name || CONF.channel} - ${top.length} idea(s),`
    + ` best +${top[0].score}`);
  return { posted: top.length, top };
}

function findChannel(guild, name) {
  const want = String(name || '').replace(/^#/, '').toLowerCase();
  if (!want || !guild) return null;
  return guild.channels.cache.find(
    (c) => (c.id === want || String(c.name || '').toLowerCase() === want)
      && typeof c.send === 'function') || null;
}

/**
 * Find the board, say what is on it, and start watching the clock.
 *
 * <p>This wires no event handler - bot.js owns those - so all it leaves running is the hourly
 * look at the date of the last digest. The first look happens straight away, which is what makes a
 * bot that was off for a week post that week's digest as soon as it is back.</p>
 */
function start(client, { log = console.log, guildId } = {}) {
  const say = log;
  const guild = guildId ? client?.guilds?.cache?.get(guildId) : client?.guilds?.cache?.first();
  if (!guild) { say('[suggestions] no guild - no board'); return null; }
  const channel = findChannel(guild, CONF.channel);
  if (!channel) { say(`[suggestions] no #${CONF.channel} - no board`); return null; }
  boardId = channel.id;

  const days = Math.max(1, CONF.digestDays);
  const recent = db.suggestionsSince(Date.now() - days * DAY, 100).length;
  const last = Number(db.get(CLOCK)) || 0;
  say(`[suggestions] #${channel.name}: ${CONF.up}${CONF.down} on anything of ${CONF.minChars}`
    + ` characters or more, ${recent} in the last ${days} days, `
    + (CONF.digest
      ? `last digest ${last ? ago(Date.now() - last) : 'never'}`
      : 'digest off (SUGGESTION_DIGEST=0)'));

  const check = () => digest(channel, { log: say }).catch((e) => say(`[suggestions] digest: ${e.message}`));
  check();
  const timer = setInterval(check, CHECK_MS);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    digest: (opts) => digest(channel, { log: say, ...opts }),
  };
}

module.exports = { start, onMessage, onReaction, digest, worthVotingOn, tally, due, CONF };
