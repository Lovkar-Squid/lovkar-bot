// node test-boosts.js - the boost cards, the look back that must never say a boost twice, and who
// gains and loses the Supporter role.
'use strict';
process.env.BOOST_SETTLE_MS = '1';
const assert = require('node:assert');
const boosts = require('./boosts');

// ---- reading Discord's boost messages -------------------------------------------------------------
assert.ok(boosts.isBoost({ type: 8 }) && boosts.isBoost({ type: 11 }), 'types 8-11 are boosts');
assert.ok(!boosts.isBoost({ type: 0 }) && !boosts.isBoost({ type: 7 }) && !boosts.isBoost(null), 'nothing else is');
assert.strictEqual(boosts.levelReached(8), 0, 'a plain boost reaches no level');
assert.strictEqual(boosts.levelReached(9), 1);
assert.strictEqual(boosts.levelReached(11), 3);
assert.strictEqual(boosts.boostCount('2'), 2, 'the content is the count');
assert.strictEqual(boosts.boostCount(''), 1, 'empty content is one boost');
assert.strictEqual(boosts.boostCount('rubbish'), 1, 'anything unreadable is one boost');

// ---- levels ---------------------------------------------------------------------------------------
assert.strictEqual(boosts.levelFor(0), 0);
assert.strictEqual(boosts.levelFor(1), 0);
assert.strictEqual(boosts.levelFor(2), 1);
assert.strictEqual(boosts.levelFor(6), 1);
assert.strictEqual(boosts.levelFor(7), 2);
assert.strictEqual(boosts.levelFor(14), 3);
assert.deepStrictEqual(boosts.nextLevel(4), { level: 2, need: 3 });
assert.deepStrictEqual(boosts.nextLevel(0), { level: 1, need: 2 });
assert.strictEqual(boosts.nextLevel(14), null, 'nothing above level 3');

// ---- totals worked out backwards ------------------------------------------------------------------
// today: 4 boosts; the newest boost was 2, the one before it 2 -> after them: 4 and 2
assert.deepStrictEqual(boosts.totalsAfter(4, [2, 2]), [4, 2]);
// a boost that expired in between cannot push a total below the boost it describes
assert.deepStrictEqual(boosts.totalsAfter(2, [1, 2, 1]), [2, 2, 1]);

// ---- the card -------------------------------------------------------------------------------------
const perks = ['**#behind-the-scenes**', '**#dev-builds**'];
const t = boosts.text({ userId: '42', count: 2, reached: 1, total: 4, perks });
assert.ok(t.startsWith('<@42> just boosted the server **×2**! Thank you 💜'), 'who and how many first');
assert.ok(t.includes('🎉 That took the server to **Level 1**!'), 'the level it reached');
assert.ok(t.includes('The server now has **4 boosts** · Level 1 · 3 more for Level 2'), 'where it stands');
assert.ok(t.includes('Boosters get the **Supporter** role: **#behind-the-scenes** and **#dev-builds**'), 'what it buys');
assert.strictEqual(boosts.list(['a', 'b', 'c', 'd']), 'a, b, c and d', 'a list reads like a sentence');
assert.strictEqual(boosts.list(['a']), 'a');
assert.strictEqual(boosts.list([]), '');
const one = boosts.text({ userId: '7', count: 1, reached: 0, total: 1, perks: [] });
assert.ok(one.startsWith('<@7> just boosted the server! Thank you'), 'no ×1');
assert.ok(!one.includes('🎉'), 'no level line when the level did not change');
assert.ok(one.includes('**1 boost** · Level 0 · 1 more for Level 1'), 'singular');
assert.ok(one.endsWith('Boosters get the **Supporter** role.'), 'the role even with no channels found');
const unknown = boosts.text({ userId: '7', count: null, total: null, supporter: false });
assert.strictEqual(unknown, '<@7> just boosted the server! Thank you 💜', 'the fallback witness knows only who');
assert.ok(boosts.text({ userId: '1', count: 1, total: 14 }).includes('· Level 3 · the top level'), 'the top');

const quiet = boosts.message({ userId: '42', count: 2, reached: 0, total: 4, at: 1700000000000 }, { ping: false });
assert.deepStrictEqual(quiet.allowedMentions, { parse: [] }, 'nobody pinged by default');
assert.strictEqual(quiet.content, undefined);
const json = quiet.embeds[0].toJSON();
assert.strictEqual(json.timestamp, new Date(1700000000000).toISOString(), 'stamped with the boost, not the post');
assert.strictEqual(json.color, 0xf47fff, 'booster pink');
const loud = boosts.message({ userId: '42', count: 1, at: 1 }, { ping: true });
assert.deepStrictEqual(loud.allowedMentions, { users: ['42'] }, 'a ping reaches only the booster');
assert.strictEqual(loud.content, '<@42>');

// ---- saying it once -------------------------------------------------------------------------------
const botId = '999';
const at = Date.parse('2026-09-11T18:48:54.450Z');
const card = { author: { id: botId }, embeds: [{ timestamp: new Date(at).toISOString(), description: '<@713> just boosted the server **×2**! Thank you 💜' }] };
assert.ok(boosts.alreadyPosted([card], { userId: '713', at }, botId), 'the same boost is recognised');
assert.ok(!boosts.alreadyPosted([card], { userId: '548', at }, botId), 'somebody else boosting at the same moment is not');
assert.ok(!boosts.alreadyPosted([card], { userId: '713', at: at + 60000 }, botId), 'a later boost by the same person is not');
assert.ok(!boosts.alreadyPosted([{ ...card, author: { id: '1' } }], { userId: '713', at }, botId), 'only our own cards count');
assert.ok(!boosts.alreadyPosted([], { userId: '713', at }, botId), 'an empty channel has nothing');

// ---- the Supporter role ---------------------------------------------------------------------------
// a new booster without the role gets it and goes on the list
let p = boosts.plan([{ id: 'a', boosting: true, supporter: false }], []);
assert.deepStrictEqual(p, { give: ['a'], take: [], auto: ['a'] });
// still boosting: nothing to do, stays on the list
p = boosts.plan([{ id: 'a', boosting: true, supporter: true }], ['a']);
assert.deepStrictEqual(p, { give: [], take: [], auto: ['a'] });
// the boost ended: the role the boost gave goes, and so does the entry
p = boosts.plan([{ id: 'a', boosting: false, supporter: true }], ['a']);
assert.deepStrictEqual(p, { give: [], take: ['a'], auto: [] });
// a Supporter by hand who boosts is never put on the list - and so never loses it
p = boosts.plan([{ id: 'h', boosting: true, supporter: true }], []);
assert.deepStrictEqual(p, { give: [], take: [], auto: [] });
p = boosts.plan([{ id: 'h', boosting: false, supporter: true }], []);
assert.deepStrictEqual(p, { give: [], take: [], auto: [] }, 'hand-given role untouched after the boost');
// somebody who left, or whose role was already taken off by hand, just leaves the list
p = boosts.plan([{ id: 'b', boosting: false, supporter: false }], ['a', 'b']);
assert.deepStrictEqual(p, { give: [], take: [], auto: [] });
// the real server on 11 Sep: two boosters, one hand-made Supporter who is not boosting
p = boosts.plan([
  { id: '548817292839092298', boosting: true, supporter: false },
  { id: '713754223271084042', boosting: true, supporter: false },
  { id: '206842581382856705', boosting: false, supporter: true },
], []);
assert.deepStrictEqual(p.give, ['548817292839092298', '713754223271084042']);
assert.deepStrictEqual(p.take, [], 'gen.will keeps the role Lovkar gave him');

// ---- the live path: a boost message becomes one card, a second copy of it none ---------------------
(async () => {
  const sent = [];
  const channelMessages = [];
  const boostsChannel = {
    id: 'c1', name: 'boosts', type: 0,
    send: async (m) => { const msg = { author: { id: botId }, embeds: m.embeds.map((e) => e.toJSON()) }; sent.push(m); channelMessages.unshift(msg); return msg; },
    messages: { fetch: async () => new Map(channelMessages.map((m, i) => [String(i), m])) },
  };
  const roleAdds = [];
  const supporter = { id: 'r1', name: 'Supporter', position: 14 };
  const member = {
    id: '713', user: { tag: 'laraeic', bot: false }, premiumSince: new Date(at), premiumSinceTimestamp: at,
    roles: { cache: new Map(), add: async (r) => { roleAdds.push(r.id); member.roles.cache.set(r.id, r); } },
  };
  const guild = {
    id: 'g1', premiumSubscriptionCount: 4, systemChannelId: 'sys', systemChannelFlags: 0,
    channels: { cache: { find: (fn) => [boostsChannel].find(fn) } },
    roles: { cache: { find: (fn) => [supporter].find(fn) } },
    members: {
      me: { roles: { highest: { position: 21 } } },
      cache: new Map([['713', member]]),
      fetch: async (id) => (id ? member : null),
    },
    fetch: async () => guild,
  };
  const client = { user: { id: botId }, guilds: { cache: { get: () => guild, first: () => guild } } };
  const lines = [];
  const ctl = boosts.start(client, { log: (l) => lines.push(l), guildId: 'g1', perkChannels: ['boosts'] });
  ctl.stop();

  const boostMessage = { guild, type: 9, content: '2', createdTimestamp: at, author: { id: '713', tag: 'laraeic', displayAvatarURL: () => 'https://cdn/avatar.png' } };
  boosts.onMessage(boostMessage);
  boosts.onMessage(boostMessage);          // Discord, or a reconnect, delivering the same thing twice
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(sent.length, 1, 'one card for one boost, however often it is heard');
  const d = sent[0].embeds[0].toJSON().description;
  assert.ok(d.includes('<@713> just boosted the server **×2**!'), 'the card names the booster and the count');
  assert.ok(d.includes('Level 1**!'), 'and the level it reached');
  assert.deepStrictEqual(roleAdds, ['r1'], 'the booster was given Supporter exactly once');
  assert.ok(lines.some((l) => l.includes('thanked laraeic in #boosts')), 'logged');
  console.log('test-boosts: all good');
})().catch((e) => { console.error(e); process.exit(1); });
