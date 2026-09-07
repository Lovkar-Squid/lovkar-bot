/** No Discord, no network: the clock, the hat, and what the book keeps between the two. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-gw-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const db = require('./db');
const gw = require('./giveaways');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const quiet = () => {};

// ---- reading a length of time ---------------------------------------------------------------
const times = [
  ['30s', 30000], ['10m', 600000], ['2h', 7200000], ['3d', 259200000], ['1w', 604800000],
  ['1h30m', 5400000], ['  2H ', 7200000], ['45', 2700000],
];
for (const [text, ms] of times) {
  if (gw.duration(text) !== ms) fail(`"${text}" should be ${ms}, got ${gw.duration(text)}`);
}
for (const junk of ['', null, undefined, 'soon', 'tomorrow', '0', '-5m', 'h']) {
  if (gw.duration(junk) !== null) fail(`"${junk}" should mean nothing, got ${gw.duration(junk)}`);
}
if (!/^2d/.test(gw.left(2 * 86400000 + 3600000))) fail('two days should read as days: ' + gw.left(2 * 86400000 + 3600000));
if (gw.left(0) !== 'now') fail('nothing left should read as now');

// ---- the hat --------------------------------------------------------------------------------
const pool = ['a', 'b', 'c', 'd', 'e'];
for (let i = 0; i < 200; i++) {
  const w = gw.draw(pool, 3);
  if (w.length !== 3) fail('three places should draw three: ' + w.length);
  if (new Set(w).size !== w.length) fail('somebody was drawn twice: ' + w.join(','));
  if (w.some((x) => !pool.includes(x))) fail('somebody who was not in the hat won');
}
if (gw.draw(['a', 'b'], 5).length !== 2) fail('two entrants cannot fill five places');
if (gw.draw([], 3).length !== 0) fail('an empty hat draws nobody');
if (gw.draw(['a', 'a', 'a'], 2).length !== 1) fail('the same person entered thrice is still one name');
// a reroll must not hand it to the same person again
for (let i = 0; i < 50; i++) {
  const again = gw.draw(pool, 2, ['a', 'b']);
  if (again.includes('a') || again.includes('b')) fail('a reroll gave it back to a previous winner');
}
// every name must be reachable - a draw that always picks the first entrant would pass everything above
const everSeen = new Set();
for (let i = 0; i < 500; i++) for (const x of gw.draw(pool, 1)) everSeen.add(x);
if (everSeen.size !== pool.length) fail('some entrants can never win: saw ' + [...everSeen].join(','));

// ---- what the book keeps --------------------------------------------------------------------
db.open(quiet);
const ends = Date.now() + 60000;
db.giveawayNew({ id: 'g1', channelId: '111', prize: 'A key', winners: 2, roleId: null, host: 'a test', ends });
db.giveawaySent('g1', '222');
const g = db.giveawayGet('g1');
if (!g || g.prize !== 'A key') fail('the giveaway did not come back');
if (g.message_id !== '222') fail('the message id was not written');
if (g.state !== 'running') fail('it should be running');

if (db.giveawayEnter('g1', 'u1', 'one') !== true) fail('the first entry should be new');
if (db.giveawayEnter('g1', 'u1', 'one') !== false) fail('entering twice should not count twice');
db.giveawayEnter('g1', 'u2', 'two');
if (db.giveawayCount('g1') !== 2) fail('two entrants expected, got ' + db.giveawayCount('g1'));
if (db.giveawayLeave('g1', 'u2') !== true) fail('leaving should say so');
if (db.giveawayLeave('g1', 'u2') !== false) fail('leaving twice should not');
if (db.giveawayCount('g1') !== 1) fail('one entrant should be left');

// nothing is due yet, and then it is
if (db.giveawayDue().length) fail('a giveaway with a minute to run is not due');
if (db.giveawayDue(ends + 1).length !== 1) fail('past its end it is due');
if (db.giveawayLive().length !== 1) fail('it should be the one running');

db.giveawayClose('g1', 'ended', ['u1']);
if (db.giveawayGet('g1').state !== 'ended') fail('it did not close');
if (db.giveawayDue(ends + 1).length) fail('a closed giveaway is never due again');
if (JSON.parse(db.giveawayGet('g1').drawn)[0] !== 'u1') fail('the winner was not kept');
const listed = gw.list(5)[0];
if (listed.entries !== 1) fail('the list should carry the entry count');
if (listed.won.length !== 1) fail('the list should name the winner');
if (listed.won[0].tag !== 'one') fail('the winner should be named from their own entry: ' + listed.won[0].tag);
// somebody drawn whose entry was taken back out is still shown, by id
db.giveawayClose('g1', 'ended', ['u1', 'u2']);
if (gw.list(5)[0].won[1].tag !== null) fail('an entrant with no tag left should fall back to the id');
db.giveawayClose('g1', 'ended', ['u1']);

// ---- what start() refuses, with no Discord anywhere near it -----------------------------------
const guild = {
  channels: { cache: new Map([['1', { id: '1', name: 'giveaways', type: 0, send: async () => ({ id: 'm', url: 'u' }) }]]) },
  roles: { cache: new Map() },
};
for (const c of [guild.channels.cache, guild.roles.cache]) {
  c.find = function (f) { return [...this.values()].find(f); };
}

async function refuses(what_, fn) {
  try {
    await fn();
    fail(`${what_} should have been refused`);
  } catch (e) {
    if (/prize|length of time|shortest|longest|no role|there is no #|not keeping a book/.test(e.message)) return;
    fail(`${what_} was refused for the wrong reason: ${e.message}`);
  }
}

(async () => {
  await refuses('no prize', () => gw.start(guild, { prize: '', lasts: '1h' }));
  await refuses('nonsense for a length', () => gw.start(guild, { prize: 'x', lasts: 'soon' }));
  await refuses('two seconds', () => gw.start(guild, { prize: 'x', lasts: '2s' }));
  await refuses('a year', () => gw.start(guild, { prize: 'x', lasts: '400d' }));
  await refuses('a role nobody has', () => gw.start(guild, { prize: 'x', lasts: '1h', role: 'Nobody' }));

  // and one that should work
  const out = await gw.start(guild, { prize: 'A test', lasts: '1h', winners: 3, host: 'a test' }, quiet);
  const made = db.giveawayGet(out.id);
  if (!made) fail('the giveaway was not written down');
  if (made.winners !== 3) fail('the winner count was not kept: ' + made.winners);
  if (made.message_id !== 'm') fail('the message id was not written back');
  // more places than the ceiling is clamped, never refused
  const many = await gw.start(guild, { prize: 'Another', lasts: '1h', winners: 999 }, quiet);
  if (db.giveawayGet(many.id).winners !== gw.MAX_WINNERS) fail('the winner count was not clamped');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all giveaway cases pass');
  process.exit(bad ? 1 : 0);
})();
