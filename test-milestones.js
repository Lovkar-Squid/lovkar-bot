/** No Discord, no network: which round numbers have been reached, and which were already said. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-ms-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const db = require('./db');
const mil = require('./milestones');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const quiet = () => {};
const MEMBERS = mil.CONF.members;

// ---- which marks a number has reached -----------------------------------------------------------
if (mil.crossed(10, MEMBERS, []).length) fail('ten members has reached nothing');
if (mil.crossed(0, MEMBERS, []).length) fail('an empty server has reached nothing');
if (mil.crossed(24, MEMBERS, []).length) fail('one short of the first mark is still nothing');

const upTo = mil.crossed(137, MEMBERS, []);
if (upTo.join(',') !== '25,50,100') fail('137 has reached 25, 50 and 100, in that order: ' + upTo.join(','));
if (!mil.crossed(25, MEMBERS, []).includes(25)) fail('exactly the mark counts as reached');
// the marks may arrive in any order; what comes back is always smallest first
if (mil.crossed(300, [500, 25, 250, 100], []).join(',') !== '25,100,250') fail('the answer should be in order');

// nothing already written down is ever handed back a second time
if (mil.crossed(137, MEMBERS, new Set([25, 50])).join(',') !== '100') fail('only the unsaid ones come back');
if (mil.crossed(137, MEMBERS, new Set([25, 50, 100])).length) fail('all three said means nothing to say');
if (mil.crossed(137, MEMBERS, [25, 50, 100]).length) fail('a plain list of done marks counts too');
for (const junk of [null, undefined, 'lots', NaN]) {
  if (mil.crossed(junk, MEMBERS, []).length) fail(`"${junk}" is not a member count`);
}

// ---- the wording ---------------------------------------------------------------------------------
const first = mil.line('boosts', 1);
const second = mil.line('boosts', 2);
if (!first.trim()) fail('the first boost needs words');
if (first === second) fail('the first boost should not read like the second');
if (!/unlock/i.test(first)) fail('the first boost is the one that unlocks the channels, and should say so');
if (mil.line('members', 100) === mil.line('members', 250)) fail('two milestones should not read alike');
// a number nobody wrote a line for still gets one
for (const [kind, value] of [['members', 137], ['boosts', 7], ['tier', 9], ['nonsense', 3]]) {
  const said = mil.line(kind, value);
  if (typeof said !== 'string' || !said.trim()) fail(`${kind} ${value} was left without words`);
}
if (!mil.line('members', 1234).includes('1,234')) fail('a big number should be readable: ' + mil.line('members', 1234));

// ---- one server, in the order it would actually happen ---------------------------------------------
db.open(quiet);

const sent = [];
const channel = {
  id: 'c1',
  name: 'general',
  type: 0,
  send: async (payload) => { sent.push(payload); return { id: 'm' + sent.length }; },
};
const guild = {
  memberCount: 137,
  premiumSubscriptionCount: 0,
  premiumTier: 0,
  channels: { cache: new Map([['c1', channel]]) },
};
guild.channels.cache.find = function (f) { return [...this.values()].find(f); };

const said = (list) => list.map((m) => `${m.kind} ${m.value}`).join(', ');

(async () => {
  // the first look at a server that is already past three of them says nothing at all
  const seeded = await mil.check(guild, channel, { log: quiet });
  if (seeded.length) fail('the first look should announce nothing: ' + said(seeded));
  if (sent.length) fail('the first look should post nothing: ' + sent.length + ' message(s)');
  for (const m of [25, 50, 100]) {
    if (!db.get(`milestone:members:${m}`)) fail(`${m} members should have been noted silently`);
  }
  if (db.get('milestone:members:250')) fail('250 has not been reached, and should not be noted');
  if (!db.get('milestone:seeded')) fail('the first look should say in the book that it happened');

  // and then a crossing that really is new
  guild.memberCount = 250;
  const hit = await mil.check(guild, channel, { log: quiet });
  if (hit.length !== 1 || hit[0].kind !== 'members' || hit[0].value !== 250) fail('250 members should be announced, once: ' + said(hit));
  if (sent.length !== 1) fail('one message expected, got ' + sent.length);
  const embed = sent[0].embeds[0].data;
  if (embed.color !== 0xe2b24a) fail('the wrong colour: ' + embed.color);
  if (embed.description !== mil.line('members', 250)) fail('the message should carry the line: ' + embed.description);
  if (sent[0].content) fail('nothing should be pinged unless MILESTONE_MENTION says so');
  if (sent[0].allowedMentions?.parse?.length !== 0) fail('nothing should be parsed as a mention');

  // people leave, and come back. Neither is worth a second message.
  guild.memberCount = 200;
  const down = await mil.check(guild, channel, { log: quiet });
  if (down.length) fail('dropping below a mark announces nothing: ' + said(down));
  guild.memberCount = 250;
  const again = await mil.check(guild, channel, { log: quiet });
  if (again.length) fail('reaching 250 a second time announces nothing: ' + said(again));
  if (sent.length !== 1) fail('still one message expected, got ' + sent.length);

  // the first boost, in its own words
  guild.premiumSubscriptionCount = 1;
  const boosted = await mil.check(guild, channel, { log: quiet });
  if (boosted.length !== 1 || boosted[0].kind !== 'boosts' || boosted[0].value !== 1) fail('the first boost should be announced: ' + said(boosted));
  if (sent[1].embeds[0].data.description !== mil.line('boosts', 1)) fail('the first boost should get the first-boost line');
  if (sent[1].embeds[0].data.description === mil.line('boosts', 2)) fail('the first boost read like the second');

  // a second boost and the level it bought, in one pass
  guild.premiumSubscriptionCount = 2;
  guild.premiumTier = 1;
  const up = await mil.check(guild, channel, { log: quiet });
  if (up.length !== 2) fail('the second boost and level 1 should both be announced: ' + said(up));
  if (said(up) !== 'boosts 2, tier 1') fail('members, then boosts, then the level: ' + said(up));
  // a level that goes back down when a boost expires is not announced again on the way up
  guild.premiumSubscriptionCount = 1;
  guild.premiumTier = 0;
  await mil.check(guild, channel, { log: quiet });
  guild.premiumSubscriptionCount = 2;
  guild.premiumTier = 1;
  const relevel = await mil.check(guild, channel, { log: quiet });
  if (relevel.length) fail('level 1 a second time announces nothing: ' + said(relevel));

  // a channel that refuses is a line in the log, not a milestone that comes round for ever
  const broken = { id: 'c2', name: 'general', type: 0, send: async () => { throw new Error('missing access'); } };
  guild.memberCount = 500;
  const lost = await mil.check(guild, broken, { log: quiet });
  if (lost.length) fail('a message that could not be sent was not announced: ' + said(lost));
  const retried = await mil.check(guild, channel, { log: quiet });
  if (retried.length) fail('a failed announcement should not come round again: ' + said(retried));

  // four went out, and the book has an account of each
  if (sent.length !== 4) fail('four messages expected in all, got ' + sent.length);
  if (db.counters().milestones !== 4) fail('the counter is wrong: ' + db.counters().milestones);
  const events = db.events(50).filter((e) => e.kind === 'milestone');
  if (events.length !== 4) fail('four events expected, got ' + events.length);
  if (!events.some((e) => e.subject === 'members' && e.detail === '250')) fail('250 members was not written down as an event');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all milestone cases pass');
  process.exit(bad ? 1 : 0);
})();
