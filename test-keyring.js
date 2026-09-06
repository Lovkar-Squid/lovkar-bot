/** The key ring, offline: a fake fetch, three keys, and no network anywhere. */
process.env.LLM_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'k1, k2\nk3';
process.env.GEMINI_MODEL = 'test-model';
process.env.GEMINI_COOLDOWN_MIN = '1';

const calls = [];
let mode = 'ok';
global.fetch = async (url, opts) => {
  const key = new URL(url).searchParams.get('key');
  calls.push(key);
  if (mode === 'all429') return { ok: false, status: 429, text: async () => 'quota' };
  if (mode === 'first429' && key === 'k1') return { ok: false, status: 429, text: async () => 'quota' };
  return { ok: true, status: 200, json: async () => ({
    candidates: [{ content: { parts: [{ text: '{"severity":"minor","project":null,"reason":"a typo"}' }] } }] }) };
};

const llm = require('./llm.js');
let bad = 0;
const check = (what, ok) => { if (!ok) { bad++; console.log('FAIL ', what); } };

(async () => {
  check('describe names three keys', llm.describe() === 'gemini (3 keys)');

  let r = await llm.ask('t', 'b');
  check('the first key answers', r && r.severity === 'minor' && calls[0] === 'k1');

  calls.length = 0;
  await llm.ask('t', 'b');
  check('the next call uses the next key', calls[0] === 'k2');

  calls.length = 0; mode = 'first429';
  r = await llm.ask('t', 'b');
  check('a rate-limited key is skipped, not fatal', r && r.severity === 'minor' && !calls.includes('k1'));

  calls.length = 0; mode = 'all429';
  r = await llm.ask('t', 'b');
  check('all keys limited -> null, so the keywords decide', r === null && calls.length === 3);

  calls.length = 0;
  r = await llm.ask('t', 'b');
  check('while every key cools, no request is made at all', r === null && calls.length === 0);

  console.log(bad ? `\n${bad} failing` : 'key ring: all 5 checks pass');
  process.exit(bad ? 1 : 0);
})();
