/** No Discord: the parsing, the clamping, and what the book keeps about a question. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-poll-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const db = require('./db');
const polls = require('./polls');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const quiet = () => {};

// ---- reading the answers ----------------------------------------------------------------------
const a1 = polls.answers('Yes | No | Not sure');
if (a1.length !== 3) fail('three answers expected, got ' + a1.length);
if (a1[0].text !== 'Yes' || a1[2].text !== 'Not sure') fail('the answers came out wrong: ' + JSON.stringify(a1));
if (a1[0].emoji) fail('there was no emoji to find');

const a2 = polls.answers('🔥 Volcano | 🌪 Tornado');
if (a2[0].emoji !== '🔥' || a2[0].text !== 'Volcano') fail('a leading emoji should become the emoji: ' + JSON.stringify(a2[0]));
if (a2.length !== 2) fail('two answers expected');

const a3 = polls.answers('One\nTwo\n  Three  \n\n');
if (a3.length !== 3) fail('newlines should separate too, got ' + a3.length);
if (a3[2].text !== 'Three') fail('whitespace should be trimmed: ' + JSON.stringify(a3[2]));

if (polls.answers(Array.from({ length: 20 }, (_, i) => 'a' + i).join('|')).length !== polls.MAX_ANSWERS) {
  fail('more than ten answers should be cut to ten');
}
for (const junk of ['', null, undefined, '   ', '|||']) {
  if (polls.answers(junk).length) fail(`"${junk}" is not a list of answers`);
}
const long = polls.answers('x'.repeat(200));
if (long[0].text.length !== polls.MAX_ANSWER) fail('a long answer should be cut to what Discord takes');

// ---- the clock ---------------------------------------------------------------------------------
if (polls.hours(undefined) !== 24) fail('the default should be a day');
if (polls.hours(0) !== 24) fail('nought hours is not a poll');
if (polls.hours(-5) !== 24) fail('a negative is not a poll');
if (polls.hours(1) !== 1) fail('an hour is allowed');
if (polls.hours(100000) !== polls.MAX_HOURS) fail('longer than Discord allows should be clamped');
if (polls.hours(2.6) !== 3) fail('it should round to a whole hour');
if (polls.hours('48') !== 48) fail('a string of digits is a number');

// ---- what a finished poll said ------------------------------------------------------------------
const said = polls.result({ answers: new Map([
  [1, { text: 'No', voteCount: 2 }],
  [2, { text: 'Yes', voteCount: 9 }],
  [3, { text: 'Maybe', voteCount: 5 }],
]) });
if (said.map((s) => s.text).join(',') !== 'Yes,Maybe,No') fail('the result should come back best first: ' + JSON.stringify(said));
if (polls.result(null).length) fail('no poll is no result');

// ---- the two kinds --------------------------------------------------------------------------------
if (!polls.about('supporters') || !polls.about('public')) fail('both kinds should exist');
if (polls.about('nope')) fail('an unknown kind is nothing');
if (polls.about('supporters').channel === polls.about('public').channel) {
  fail('the two kinds must not share a channel');
}

// ---- asking one, with a guild that is not Discord --------------------------------------------------
const sent = [];
const channel = { id: '1', name: 'community-polls', send: async (p) => { sent.push(p); return { id: 'm1', url: 'https://x/m1' }; } };
const guild = { channels: { cache: new Map([['1', channel]]) } };
guild.channels.cache.find = function (f) { return [...this.values()].find(f); };

async function refuses(what, fn) {
  try {
    await fn();
    fail(`${what} should have been refused`);
  } catch (e) {
    if (/needs a question|two answers|no such poll|there is no #/.test(e.message)) return;
    fail(`${what} was refused for the wrong reason: ${e.message}`);
  }
}

(async () => {
  db.open(quiet);
  await refuses('no question', () => polls.ask(guild, { kind: 'public', question: '', answers: 'a|b' }));
  await refuses('one answer', () => polls.ask(guild, { kind: 'public', question: 'q', answers: 'only one' }));
  await refuses('an unknown kind', () => polls.ask(guild, { kind: 'nobody', question: 'q', answers: 'a|b' }));
  await refuses('a channel that is not there', () => polls.ask(guild, { kind: 'supporters', question: 'q', answers: 'a|b' }));

  const out = await polls.ask(guild, {
    kind: 'public', question: 'Which cataclysm next?', answers: '🌋 Volcano | 🌪 Tornado | ☄ Meteor',
    hours: 48, multi: true, host: 'a test',
  }, quiet);
  if (out.id !== 'm1') fail('the message id should come back');
  const payload = sent[0].poll;
  if (payload.question.text !== 'Which cataclysm next?') fail('the question did not reach Discord');
  if (payload.answers.length !== 3) fail('three answers should have reached Discord');
  if (payload.duration !== 48) fail('the duration is wrong: ' + payload.duration);
  if (payload.allowMultiselect !== true) fail('multiselect was not passed on');
  if (sent[0].allowedMentions.parse.length) fail('a poll should not be allowed to ping');

  const kept = polls.list(5)[0];
  if (!kept || kept.question !== 'Which cataclysm next?') fail('the book did not keep the question');
  if (kept.kind !== 'public') fail('the kind was not kept');
  if (kept.answers.length !== 3) fail('the answers were not kept: ' + JSON.stringify(kept.answers));
  if (kept.result !== null) fail('an open poll has no result yet');
  if (!kept.ends || kept.ends < Date.now()) fail('the end time was not kept');

  db.pollClose('m1', said);
  if (polls.list(5)[0].result[0].text !== 'Yes') fail('the result was not kept');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all poll cases pass');
  process.exit(bad ? 1 : 0);
})();
