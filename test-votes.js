// node test-votes.js - reading a Discadia vote, the count, the thank-you, the role, and the door.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'votes-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.VOTE_HOOK_TOKEN = 'testtoken0123456789abcdef';
process.env.VOTE_ROLE = 'Voter';
process.env.VOTE_ROLE_DAYS = '7';
process.env.VOTE_CHANNEL = 'votes';
process.env.VOTE_QUIET = '';

const assert = require('node:assert');
const db = require('./db');
const votes = require('./votes');

const quiet = () => {};

// ---- reading ------------------------------------------------------------------------------------
assert.deepStrictEqual(votes.reading({ user_id: '213698532983570432', guild_id: '1', vote_url: 'https://discadia.com/vote/x', server_title: 'X' }, '1'),
  { userId: '213698532983570432', voteUrl: 'https://discadia.com/vote/x', title: 'X' });
assert.strictEqual(votes.reading({ user_id: '213698532983570432', guild_id: '2' }, '1'), null, 'another server\'s vote');
assert.strictEqual(votes.reading({ user_id: 'bob' }, '1'), null, 'no user id');
assert.strictEqual(votes.reading('nonsense', '1'), null);
assert.strictEqual(votes.reading({ user_id: '213698532983570432', vote_url: 'https://evil.example/x' }, '1').voteUrl, null, 'only discadia links are repeated');

// ---- the door -----------------------------------------------------------------------------------
assert.strictEqual(votes.matches('/hooks/discadia/testtoken0123456789abcdef'), true);
assert.strictEqual(votes.matches('/hooks/discadia/testtoken0123456789abcdef/'), true, 'trailing slash');
assert.strictEqual(votes.matches('/hooks/discadia/testtoken0123456789abcdeX'), false);
assert.strictEqual(votes.matches('/hooks/discadia/'), false);
assert.strictEqual(votes.matches('/hooks/other/testtoken0123456789abcdef'), false);
assert.strictEqual(votes.url('https://sentinel.example/'), 'https://sentinel.example/hooks/discadia/testtoken0123456789abcdef');

// ---- the words ----------------------------------------------------------------------------------
assert.ok(votes.line('5', { thisMonth: 1, allTime: 1, total: 1 }, null).includes('their first vote this month'));
assert.ok(votes.line('5', { thisMonth: 3, allTime: 12, total: 40 }, 'https://discadia.com/vote/x').includes('their 3rd vote this month, 12 all time. Vote too: <https://discadia.com/vote/x>'));
assert.ok(votes.line('5', { thisMonth: 22, allTime: 22, total: 1 }, null).includes('22nd'));

// ---- one vote, then the same person again -------------------------------------------------------
db.open(quiet);

const sent = [];
const given = [];
const role = { id: 'r1', name: 'Voter' };
const member = { user: { tag: 'alice' }, roles: { cache: new Set(), add: async (r) => { given.push(r.name); member.roles.cache.add(r.id); } } };
const channel = { id: 'c1', name: 'votes', type: 0, send: async (p) => { sent.push(p); return { id: 'm' }; } };
const guild = {
  id: '1',
  roles: { cache: new Map([['r1', role]]) },
  channels: { cache: new Map([['c1', channel]]) },
  members: { fetch: async (id) => { if (id === '213698532983570432') return member; throw new Error('Unknown Member'); } },
};
guild.roles.cache.find = function (f) { return [...this.values()].find(f); };
guild.channels.cache.find = function (f) { return [...this.values()].find(f); };

(async () => {
  const body = { user_id: '213698532983570432', guild_id: '1', vote_url: 'https://discadia.com/vote/x', server_title: 'X' };
  const t0 = 1_700_000_000_000;
  const first = await votes.vote(guild, body, { log: quiet, now: t0 });
  assert.deepStrictEqual(first, { counted: true, duplicate: false, thanked: true, role: true, userId: '213698532983570432' });
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].content.includes('<@213698532983570432>') && sent[0].content.includes('first vote this month'), sent[0].content);
  assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] }, 'a thank-you pings nobody');
  assert.deepStrictEqual(given, ['Voter']);

  // a retry ten seconds later is the same vote
  const again = await votes.vote(guild, body, { log: quiet, now: t0 + 10_000 });
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(sent.length, 1, 'not thanked twice');
  assert.strictEqual(db.get('votes:total'), '1');

  // the next day: counted, second this month, the role already there so not given again
  const next = await votes.vote(guild, body, { log: quiet, now: t0 + 86_400_000 });
  assert.strictEqual(next.counted, true);
  assert.strictEqual(next.role, false);
  assert.ok(sent[1].content.includes('2nd vote this month, 2 all time'));
  assert.strictEqual(db.get('votes:total'), '2');

  // a voter who is not in the server: counted, nobody to reward, still thanked by id
  const stranger = await votes.vote(guild, { user_id: '999999999999999999', guild_id: '1' }, { log: quiet, now: t0 + 5 });
  assert.deepStrictEqual([stranger.counted, stranger.role, stranger.thanked], [true, false, true]);

  // the role goes when the week is up, and only the role a vote gave
  const gone = [];
  member.id = '213698532983570432';
  member.roles.remove = async (r) => { gone.push(r.name); member.roles.cache.delete(r.id); };
  role.members = new Map([['213698532983570432', member]]);
  assert.deepStrictEqual(await votes.sweep(guild, { log: quiet, now: t0 + 86_400_000 + 1000 }), [], 'six days to go');
  const week = t0 + 86_400_000 + 7 * 86_400_000 + 1000;   // seven days after the SECOND vote
  assert.deepStrictEqual(await votes.sweep(guild, { log: quiet, now: week }), ['alice'], 'taken back');
  assert.deepStrictEqual(gone, ['Voter']);
  assert.deepStrictEqual(await votes.sweep(guild, { log: quiet, now: week + 1000 }), [], 'once');

  // the HTTP door
  const calls = [];
  const send = (res, status, body2) => calls.push({ status, body: body2 });
  const readJson = async () => ({ user_id: '213698532983570432', guild_id: '1' });
  const req = (method) => ({ method });
  assert.strictEqual(await votes.handle(req('POST'), {}, '/api/status', {}), false, 'not a hook path');
  await votes.handle(req('POST'), {}, '/hooks/discadia/wrong', { guild, log: quiet, send, readJson });
  assert.strictEqual(calls.pop().status, 404, 'wrong token is a 404');
  await votes.handle(req('GET'), {}, '/hooks/discadia/testtoken0123456789abcdef', { guild, log: quiet, send, readJson });
  assert.strictEqual(calls.pop().status, 405);
  await votes.handle(req('POST'), {}, '/hooks/discadia/testtoken0123456789abcdef', { guild: () => guild, log: quiet, send, readJson });
  const ok = calls.pop();
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.ok, true);
  await votes.handle(req('POST'), {}, '/hooks/discadia/testtoken0123456789abcdef', { guild, log: quiet, send, readJson: async () => ({ hello: 'world' }) });
  assert.strictEqual(calls.pop().status, 400, 'not a vote');

  const st = votes.status('https://sentinel.example');
  assert.strictEqual(st.on, true);
  assert.ok(st.total >= 3);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('test-votes: ok');
})().catch((e) => { console.error(e); process.exit(1); });
