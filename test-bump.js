// node test-bump.js - reading the listing bot's replies, keeping the clock, reminding once and nudging.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.BUMP_BOTS = 'disboard:302050872383242240:120,other:123456789012345678:60,discadia:*:120';
process.env.BUMP_NUDGE_MIN = '180';

const assert = require('node:assert');
const db = require('./db');
const bump = require('./bump');

const quiet = () => {};

// ---- reading the replies --------------------------------------------------------------------------
assert.strictEqual(bump.reading('Bump done! :thumbsup: Check it on DISBOARD: https://disboard.org/'), 'done');
assert.strictEqual(bump.reading('Server successfully bumped'), 'done');
assert.deepStrictEqual(bump.reading('Please wait another 1 hours 23 minutes until the server can be bumped'),
  { waitMs: (60 + 23) * 60 * 1000 });
assert.deepStrictEqual(bump.reading('Please wait another 45 minutes until the server can be bumped'),
  { waitMs: 45 * 60 * 1000 });
assert.deepStrictEqual(bump.reading('You can bump again in 2 hours'), { waitMs: 120 * 60 * 1000 });
assert.strictEqual(bump.reading('DISBOARD - the public server list. Type /bump to bump.'), null, 'help text is not a bump');
assert.deepStrictEqual(bump.reading('Server bumped! Next bump in 6 hours'), { done: true, waitMs: 6 * 60 * 60 * 1000 }, 'a done that names its own cooldown');
assert.strictEqual(bump.reading('Your server has been bumped.'), 'done');
assert.strictEqual(bump.reading('You already bumped recently. Please wait another 2 hours 5 minutes').waitMs, (120 + 5) * 60 * 1000);
assert.strictEqual(bump.matchBot({ id: '5', bot: true, username: 'Discadia' })?.name, 'discadia', 'wildcard matches by username');
assert.strictEqual(bump.matchBot({ id: '5', bot: false, username: 'discadia fan' }), null, 'people are not bots');
assert.strictEqual(bump.matchBot({ id: '302050872383242240', bot: true, username: 'DISBOARD.org' })?.name, 'disboard');
assert.strictEqual(bump.reading(''), null);

assert.strictEqual(bump.parseBots('disboard:302050872383242240:120, bad:12:5,,x:999999999999999999,star:*:30').length, 3, 'ids are checked, * allowed');
assert.strictEqual(bump.CONF.bots[1].cooldownMs, 60 * 60 * 1000);

const embed = { embeds: [{ description: 'Bump done! :thumbsup:', title: '' }], content: '' };
assert.ok(bump.textOf(embed).includes('bump done'), 'embeds are read');

assert.ok(bump.line(bump.CONF.bots[0], '<@1>', false).startsWith('<@1> the DISBOARD bump is free again'));
assert.ok(bump.line(bump.CONF.bots[0], '', true).includes('still free'));

// ---- one bump, in the order it would happen -------------------------------------------------------
db.open(quiet);

const sent = [];
const channel = {
  id: 'c1', name: 'bump', type: 0,
  send: async (payload) => { sent.push(payload); return { id: 'm' + sent.length }; },
};
const guild = { ownerId: '77', channels: { cache: new Map([['c1', channel]]) } };
guild.channels.cache.find = function (f) { return [...this.values()].find(f); };
const client = { users: { fetch: async () => { throw new Error('no DMs in the test'); } } };

(async () => {
  const t0 = 1_700_000_000_000;
  // nothing seen yet: the clock has nothing to say
  await bump.check(client, guild, { log: quiet, now: t0 });
  assert.strictEqual(sent.length, 0, 'no bump seen, no reminder');

  // somebody else's message is ignored, the listing bot's "done" starts the clock
  assert.strictEqual(bump.onMessage({ author: { id: '1' }, content: 'bump done', channelId: 'c1' }, quiet), false);
  const realNow = Date.now();
  assert.strictEqual(bump.onMessage({ author: { id: '302050872383242240' }, channelId: 'c1', channel,
    embeds: [{ description: 'Bump done! :thumbsup:' }] }, quiet), true);
  const due = Number(db.get('bump:disboard:due'));
  assert.ok(due >= realNow + 120 * 60 * 1000 - 5 && due <= realNow + 120 * 60 * 1000 + 5000, 'due in two hours');
  assert.strictEqual(db.get('bump:disboard:channel'), 'c1');

  // an hour in: quiet
  await bump.check(client, guild, { log: quiet, now: due - 60 * 60 * 1000 });
  assert.strictEqual(sent.length, 0, 'too early');
  // two hours in: one reminder, in the bump channel, pinging the owner only
  await bump.check(client, guild, { log: quiet, now: due + 1000 });
  assert.strictEqual(sent.length, 1, 'reminded once');
  assert.ok(sent[0].content.startsWith('<@77> the DISBOARD bump is free again'), sent[0].content);
  assert.deepStrictEqual(sent[0].allowedMentions, { users: ['77'] });
  // a minute later: still one
  await bump.check(client, guild, { log: quiet, now: due + 61_000 });
  assert.strictEqual(sent.length, 1, 'not repeated');
  // three hours later with no bump: a nudge
  await bump.check(client, guild, { log: quiet, now: due + 1000 + 180 * 60 * 1000 });
  assert.strictEqual(sent.length, 2, 'nudged');
  assert.ok(sent[1].content.includes('still free'));
  // ten minutes after the nudge: nothing (the hour floor)
  await bump.check(client, guild, { log: quiet, now: due + 1000 + 190 * 60 * 1000 });
  assert.strictEqual(sent.length, 2, 'nudges are at least an hour apart');

  // an early /bump ("wait another 30 minutes") corrects the clock and re-arms the reminder
  assert.strictEqual(bump.onMessage({ author: { id: '302050872383242240' }, channelId: 'c1', channel,
    content: 'Please wait another 30 minutes until the server can be bumped' }, quiet), true);
  const due2 = Number(db.get('bump:disboard:due'));
  assert.ok(due2 > Date.now() + 29 * 60 * 1000 && due2 < Date.now() + 31 * 60 * 1000, 'corrected to 30 min');
  assert.strictEqual(db.get('bump:disboard:reminded'), '0');
  await bump.check(client, guild, { log: quiet, now: due2 + 1000 });
  assert.strictEqual(sent.length, 3, 'reminded again after the correction');

  // a bot that names its own cooldown sets the clock from the message, not from the config
  assert.strictEqual(bump.onMessage({ author: { id: '9', bot: true, username: 'Discadia' }, channelId: 'c1', channel,
    embeds: [{ description: 'Server bumped! Next bump in 6 hours' }] }, quiet), true);
  const due3 = Number(db.get('bump:discadia:due'));
  assert.ok(due3 > Date.now() + 359 * 60 * 1000 && due3 < Date.now() + 361 * 60 * 1000, 'six hours from the message');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('test-bump: ok');
})().catch((e) => { console.error(e); process.exit(1); });
