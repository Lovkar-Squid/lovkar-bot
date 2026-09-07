/** No Discord, no network: what counts as an idea, what the votes come to, and the weekly digest. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sug-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const db = require('./db');
const sug = require('./suggestions');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const quiet = () => {};
const DAY = 86400000;

/** A message, in as much of its shape as this module ever looks at. */
const msg = (over = {}) => ({
  id: '1',
  content: '',
  attachments: [],
  author: { bot: false, tag: 'someone' },
  channel: { id: 'c1', name: 'ideas-and-feedback' },
  channelId: 'c1',
  url: 'https://discord.com/channels/1/2/3',
  createdTimestamp: Date.now(),
  react: async () => {},
  ...over,
});

// ---- what is worth a pair of reactions ---------------------------------------------------------
const worth = [
  ['a real suggestion', msg({ content: 'Could the map screen remember where I left it?' }), true],
  ['a suggestion with a link in it', msg({ content: 'Something like this would work https://example.com/x' }), true],
  ['exactly the minimum', msg({ content: 'add a hotkey' }), true],                      // 12 characters
  ['one short of it', msg({ content: 'add a hotke' }), false],
  ['another bot', msg({ content: 'Could the map remember where I left it?', author: { bot: true } }), false],
  ['nothing at all', msg({ content: '' }), false],
  ['whitespace', msg({ content: '   \n  ' }), false],
  ['too short to be an idea', msg({ content: 'lol' }), false],
  ['a bare link', msg({ content: 'https://example.com/a/very/long/path/that/is/long' }), false],
  ['a bare link in angle brackets', msg({ content: '<https://example.com/a/very/long/path>' }), false],
  ['a short line with a screenshot', msg({ content: 'like this?', attachments: [{ name: 'shot.png' }] }), true],
  ['a picture and nothing said', msg({ content: '', attachments: [{ name: 'shot.png' }] }), true],
  ['a screenshot in a Collection', msg({ content: 'like this?', attachments: { size: 1 } }), true],
];
for (const [what, m, want] of worth) {
  if (sug.worthVotingOn(m) !== want) fail(`${what} should be ${want ? '' : 'not '}worth voting on`);
}
if (sug.worthVotingOn(null) !== false) fail('nothing at all is not a suggestion');

// ---- when a digest is owed ---------------------------------------------------------------------
const t0 = Date.parse('2026-03-01T12:00:00Z');
if (!sug.due(0, t0, 7)) fail('never having posted one should be owed');
if (!sug.due(null, t0, 7)) fail('no date at all should be owed');
if (!sug.due(t0 - 7 * DAY, t0, 7)) fail('exactly seven days should be owed');
if (sug.due(t0 - 6 * DAY, t0, 7)) fail('six days is not a week');
if (sug.due(t0 - 6.99 * DAY, t0, 7)) fail('an hour short of a week is not a week');
if (!sug.due(t0 - 8 * DAY, t0, 7)) fail('eight days is overdue');
if (!sug.due(t0 - 30 * DAY, t0, 7)) fail('a month away should be owed on the way back');
if (sug.due(t0, t0, 7)) fail('one posted this second is not owed again');

// ---- the arithmetic ----------------------------------------------------------------------------
const t = sug.tally({ up: 4, down: 2, mineUp: true, mineDown: true });
if (t.up !== 3) fail('the bot\'s own thumb up should come off: ' + t.up);
if (t.down !== 1) fail('the bot\'s own thumb down should come off: ' + t.down);
if (t.score !== 2) fail('the score should be 2, is ' + t.score);
const box = sug.tally({ up: 1, down: 1, mineUp: true, mineDown: true });
if (box.up !== 0 || box.down !== 0 || box.score !== 0) fail('the ballot box on its own is nobody voting');
if (sug.tally({ up: 0, down: 0, mineUp: true, mineDown: true }).up !== 0) fail('a count must not go below zero');
if (sug.tally({ up: 3, down: 0 }).score !== 3) fail('votes the bot never joined should all count');
if (sug.tally({}).score !== 0) fail('a message nobody touched scores nothing');
if (sug.tally({ up: 1, down: 4, mineUp: true, mineDown: true }).score !== -3) fail('a disliked idea should go negative');

// ---- the book, the digest and the handlers ------------------------------------------------------
(async () => {
  db.open(quiet);
  const now = Date.parse('2026-03-08T09:00:00Z');
  const board = {
    id: 'c1',
    name: 'ideas-and-feedback',
    sent: [],
    async send(payload) { this.sent.push(payload); return { id: 'm1', url: 'https://discord.com/m1' }; },
  };
  const idea = (id, up, down, at = now - DAY) => {
    db.suggestionNew({ id, channelId: 'c1', author: 'someone', excerpt: 'idea ' + id, url: 'https://discord.com/' + id, at });
    db.suggestionScore(id, up, down);
  };

  // nothing anybody wanted: no digest, and the clock still moves on
  idea('a', 0, 0);
  idea('b', 1, 1);
  idea('c', 0, 3);
  db.set('suggestions:digest', String(now - 8 * DAY));
  await sug.digest(board, { log: quiet, now });
  if (board.sent.length) fail('a digest with nothing in it should not have been posted');
  if (Number(db.get('suggestions:digest')) !== now) fail('a silent week should still wind the clock on');

  // and now some that people voted for
  idea('f', 9, 0);                       // +9
  idea('e', 7, 1);                       // +6
  idea('d', 5, 0);                       // +5
  idea('g', 4, 1);                       // +3
  idea('h', 3, 1);                       // +2, and above i on the same score for having more votes
  idea('i', 2, 0);                       // +2, sixth, so it does not make the list
  idea('old', 99, 0, now - 30 * DAY);    // last month's, and none of this week's business

  // the clock was wound a moment ago, so nothing is owed yet
  await sug.digest(board, { log: quiet, now: now + 3600000 });
  if (board.sent.length) fail('a digest an hour after the last one should not have gone out');

  db.set('suggestions:digest', String(now - 8 * DAY));
  const out = await sug.digest(board, { log: quiet, now });
  if (board.sent.length !== 1) fail('the digest should have gone out once, went ' + board.sent.length);
  if (!out || out.posted !== 5) fail('five ideas should have been posted, got ' + out?.posted);

  const text = String(board.sent[0]?.content || '');
  const at = (id) => text.indexOf('idea ' + id);
  for (const id of ['f', 'e', 'd', 'g', 'h']) if (at(id) < 0) fail(`"idea ${id}" should be in the digest`);
  for (const id of ['i', 'a', 'b', 'c']) if (at(id) >= 0) fail(`"idea ${id}" should not be in the digest`);
  if (at('old') >= 0) fail('something from last month should have fallen out of the window');
  if (!(at('f') < at('e') && at('e') < at('d') && at('d') < at('g') && at('g') < at('h'))) {
    fail('the digest is in the wrong order:\n' + text);
  }
  if (!text.includes('+9')) fail('the best score should be on the line: ' + text);
  if (!text.includes('(https://discord.com/f)')) fail('each line should link to the original');
  if (!text.includes('someone')) fail('each line should name the author');
  if (board.sent[0]?.allowedMentions?.parse?.length !== 0) fail('the digest must not be able to ping anybody');
  if (text.split('\n').length !== 6) fail('a heading and five lines: ' + text.split('\n').length);

  for (const id of ['f', 'e', 'd', 'g', 'h']) {
    if (!db.suggestionSeen(id)?.digested) fail(`"idea ${id}" was not marked digested`);
  }
  if (db.suggestionSeen('i')?.digested) fail('one that missed the list should not be marked digested');
  if (Number(db.get('suggestions:digest')) !== now) fail('the clock was not wound on after posting');

  // switched off, the reactions stay and the channel is left alone
  board.sent.length = 0;
  sug.CONF.digest = false;
  db.set('suggestions:digest', String(now - 8 * DAY));
  await sug.digest(board, { log: quiet, now });
  if (board.sent.length) fail('SUGGESTION_DIGEST=0 should post nothing');
  await sug.digest(board, { log: quiet, now, force: true });
  if (board.sent.length !== 1) fail('asking for one by hand should post it anyway');
  sug.CONF.digest = true;

  // ---- a message anywhere in the server ---------------------------------------------------------
  const elsewhere = msg({
    id: '900',
    content: 'A perfectly good suggestion, in the wrong room',
    channel: { id: 'c9', name: 'general' },
    channelId: 'c9',
    react: async () => fail('it reacted in #general'),
  });
  await sug.onMessage(elsewhere, quiet);
  if (db.suggestionSeen('900')) fail('a message in another channel was written down');

  const reacted = [];
  const posted = msg({
    id: '901',
    content: 'Could the map screen remember where I left it?',
    react: async (e) => { reacted.push(e); },
  });
  await sug.onMessage(posted, quiet);
  if (reacted.join(' ') !== `${sug.CONF.up} ${sug.CONF.down}`) fail('the pair went on wrong: ' + reacted.join(' '));
  const row = db.suggestionSeen('901');
  if (!row) fail('the suggestion was not written down');
  if (row?.excerpt !== posted.content) fail('the excerpt is wrong: ' + row?.excerpt);
  if (row?.author !== 'someone') fail('the author was not kept');

  // the same message a second time must not get a second pair
  reacted.length = 0;
  await sug.onMessage(posted, quiet);
  if (reacted.length) fail('the same message was opened for votes twice');

  // a long one is cut down to something the digest can carry
  await sug.onMessage(msg({ id: '902', content: 'x'.repeat(900) }), quiet);
  if ((db.suggestionSeen('902')?.excerpt || '').length > 300) fail('the excerpt was not cut to 300');

  // a reaction the bot is not allowed to add must not take the handler down with it
  await sug.onMessage(msg({ id: '903', content: 'A suggestion in a locked channel', react: async () => { throw new Error('missing permissions'); } }), quiet);
  if (!db.suggestionSeen('903')) fail('the record should be written before the reactions are tried');

  // ---- a reaction anywhere in the server --------------------------------------------------------
  const voted = (id, up, down, mineUp = true, mineDown = true) => msg({
    id,
    content: 'A suggestion worth voting on',
    reactions: { cache: new Map([
      ['u', { emoji: { name: sug.CONF.up }, count: up, me: mineUp }],
      ['d', { emoji: { name: sug.CONF.down }, count: down, me: mineDown }],
    ]) },
  });

  const away = {
    partial: true,
    emoji: { name: sug.CONF.up },
    message: msg({ id: '904', channel: { id: 'c9', name: 'general' }, channelId: 'c9' }),
    async fetch() { fail('a reaction in another channel was fetched from Discord'); return this; },
  };
  await sug.onReaction(away, { bot: false, id: 'u1' }, quiet);

  const mine = { partial: false, emoji: { name: sug.CONF.up }, message: voted('905', 1, 1) };
  await sug.onReaction(mine, { bot: true, id: 'me' }, quiet);
  if (db.suggestionSeen('905')) fail('the bot putting out the ballot box is not a vote');

  const on = voted('906', 4, 2);
  await sug.onMessage(on, quiet);
  const vote = {
    partial: true,
    fetched: 0,
    emoji: { name: sug.CONF.up },
    message: on,
    async fetch() { this.fetched++; this.partial = false; return this; },
  };
  await sug.onReaction(vote, { bot: false, id: 'u1' }, quiet);
  if (!vote.fetched) fail('a partial reaction should have been fetched before it was counted');
  const scored = db.suggestionSeen('906');
  if (scored?.up !== 3 || scored?.down !== 1) fail(`the count is wrong: ${scored?.up}/${scored?.down}`);

  // a vote on something posted while the bot was away still counts
  const missed = voted('907', 5, 1, false, false);
  await sug.onReaction({ partial: false, emoji: { name: sug.CONF.up }, message: missed }, { bot: false }, quiet);
  const late = db.suggestionSeen('907');
  if (!late) fail('a vote on a message from before the bot woke up should write it down');
  if (late?.up !== 5 || late?.down !== 1) fail(`the late count is wrong: ${late?.up}/${late?.down}`);

  // an emoji nobody voted with changes nothing
  const shrug = voted('908', 1, 1);
  await sug.onReaction({ partial: false, emoji: { name: '🎉' }, message: shrug }, { bot: false }, quiet);
  if (db.suggestionSeen('908')) fail('a party popper is not a vote');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all suggestion cases pass');
  process.exit(bad ? 1 : 0);
})();
