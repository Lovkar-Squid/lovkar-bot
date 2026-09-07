/**
 * The dashboard's session cookie, held to account.
 *
 * Everything the dashboard protects sits behind unseal(), so these are the checks that matter:
 * a cookie nobody signed, a cookie signed with the wrong key, one that has been edited, and one
 * that has run out. Run with: node test-web.js
 */
'use strict';

const assert = require('node:assert');
const { _internals: w } = require('./web');

const SECRET = 'a-secret-only-the-server-knows';
const OTHER = 'not-that-secret';
const soon = () => Date.now() + 60_000;

let checks = 0;
const check = (name, fn) => { fn(); checks++; };

check('a sealed session comes back the same', () => {
  const t = w.seal({ id: '42', name: 'Lovkar', exp: soon() }, SECRET);
  const back = w.unseal(t, SECRET);
  assert.equal(back.id, '42');
  assert.equal(back.name, 'Lovkar');
});

check('another key does not open it', () => {
  const t = w.seal({ id: '42', exp: soon() }, SECRET);
  assert.equal(w.unseal(t, OTHER), null);
});

check('an edited payload is refused', () => {
  const t = w.seal({ id: '42', exp: soon() }, SECRET);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ id: '1', exp: soon() })).toString('base64url');
  assert.equal(w.unseal(`${forged}.${sig}`, SECRET), null);
});

check('an expired session is refused', () => {
  const t = w.seal({ id: '42', exp: Date.now() - 1 }, SECRET);
  assert.equal(w.unseal(t, SECRET), null);
});

check('a session with no expiry is refused', () => {
  const t = w.seal({ id: '42' }, SECRET);
  assert.equal(w.unseal(t, SECRET), null);
});

check('rubbish in the cookie is refused, not thrown', () => {
  for (const junk of ['', 'x', 'x.y', 'not.base64!!', undefined, null, 42, {}]) {
    assert.equal(w.unseal(junk, SECRET), null);
  }
});

check('signatures of different lengths compare false, not throw', () => {
  assert.equal(w.sameSig('short', 'a-much-longer-signature'), false);
  assert.equal(w.sameSig('same', 'same'), true);
});

check('cookies are parsed, including values with = in them', () => {
  const c = w.cookies({ headers: { cookie: 'sid=abc.def==; st=zz; other=1' } });
  assert.equal(c.sid, 'abc.def==');
  assert.equal(c.st, 'zz');
  assert.equal(c.other, '1');
});

check('no cookie header is an empty bag', () => {
  assert.deepEqual(w.cookies({ headers: {} }), {});
});

check('the dashboard refuses to start without its OAuth settings', () => {
  const said = [];
  const out = require('./web').start({}, { log: (m) => said.push(m), llm: {}, recent: () => [], stats: () => ({}), retriage: async () => {},
    clientId: '', clientSecret: '', baseUrl: '' });
  assert.equal(out, null);
  assert.ok(said.some((m) => m.includes('not started')));
});

console.log(`dashboard: all ${checks} checks pass`);
