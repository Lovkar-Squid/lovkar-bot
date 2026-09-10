// node test-notify.js - the notice text, and that nothing but the named person is ever pinged.
process.env.BUG_NOTIFY = 'both';
const assert = require('node:assert');
const notify = require('./notify');

const thread = { name: 'Astronomer stuck on the lookout', url: 'https://discord.com/channels/1/2/3', guildId: '1', id: '3' };
const verdict = { severity: 'critical', project: 'voyager', needsLog: true };
const starter = { author: { tag: 'genwill' }, content: '\n  when i update it crashes @everyone <@&123>\nsecond line' };

const text = notify.card(thread, verdict, starter);
assert.ok(text.startsWith('🐛 **New bug report** - 🔴 Critical'), 'severity first');
assert.ok(text.includes('**Astronomer stuck on the lookout** by genwill'), 'title and reporter');
assert.ok(text.includes('project: voyager · log: still needed'), 'meta line');
assert.ok(text.includes('> when i update it crashes @everyone <@&123>'), 'first non-empty line quoted');
assert.ok(!text.includes('second line'), 'only the first line');
assert.ok(text.endsWith(thread.url), 'link last');

const mentioned = notify.card(thread, verdict, starter, { mention: '<@42>' });
assert.ok(mentioned.startsWith('<@42> 🐛'), 'mention goes first');

const bare = notify.card({ name: 'x', guildId: '9', id: '8' }, { severity: 'minor' }, null);
assert.ok(bare.includes('🟡 Minor') && bare.includes('by somebody') && bare.includes('log: attached or not needed'), 'defaults');
assert.ok(bare.endsWith('https://discord.com/channels/9/8'), 'link built when the thread has none');

assert.strictEqual(notify.firstLine('a'.repeat(300)).length, 240, 'trimmed');
assert.strictEqual(notify.firstLine(''), '', 'empty');

// a closed inbox and a missing channel are logged, not thrown, and the report does not stop
(async () => {
  const lines = [];
  const fakeThread = {
    name: 't', url: 'u', guildId: '1', id: '2',
    guild: { name: 'g', ownerId: '77', channels: { cache: new Map() } },
    client: { users: { fetch: async () => ({ tag: 'owner', send: async () => { throw new Error('Cannot send messages to this user'); } }) } },
  };
  const out = await notify.bugReport(fakeThread, verdict, starter, { log: (l) => lines.push(l) });
  assert.deepStrictEqual(out, { dm: false, channel: false });
  assert.ok(lines.some((l) => l.includes('could not DM 77')), 'DM failure logged');
  assert.ok(lines.some((l) => l.includes('no #moderator-only')), 'missing channel logged');

  // the happy path pings exactly the owner in the channel
  let sent = null;
  const chan = { name: 'moderator-only', isTextBased: () => true, isThread: () => false, send: async (m) => { sent = m; } };
  fakeThread.guild.channels.cache = new Map([['c', chan]]);
  fakeThread.client.users.fetch = async () => ({ tag: 'owner', send: async () => {} });
  const ok = await notify.bugReport(fakeThread, verdict, starter, { log: () => {} });
  assert.deepStrictEqual(ok, { dm: true, channel: true });
  assert.deepStrictEqual(sent.allowedMentions, { users: ['77'] }, 'only the owner is pinged');
  assert.ok(sent.content.startsWith('<@77> 🐛'), 'owner mentioned in the channel card');
  console.log('test-notify: all good');
})().catch((e) => { console.error(e); process.exit(1); });
