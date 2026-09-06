/**
 * The optional second opinion.
 *
 * Off unless LLM_PROVIDER is set. Everything it returns passes back through triage.reconcile(),
 * so the worst a bad answer can do is move a report one bucket - never below the evidence.
 * One call per new post, a 12-second budget, and any failure falls back to the keywords silently.
 *
 * GEMINI_API_KEY may hold several keys (comma, semicolon, whitespace or newline separated), one
 * per Google project. A key that answers 429 or "quota" is stood down for GEMINI_COOLDOWN_MIN
 * minutes and the next one is tried; when they are all cooling, the pass is skipped and the
 * keywords decide on their own. Keys are only ever named by position in the log, never printed.
 */

'use strict';

const RUBRIC = `You triage bug reports for Minecraft mods. Answer with JSON only.

severity:
  "critical" - the game or server will not run, a world or items are lost or corrupted, or an
               exploit duplicates items. Anything with a crash or a stack trace.
  "major"    - the game runs but something is properly broken: a feature does not work, a player
               cannot progress, bad performance, an entity or structure never appears.
  "minor"    - cosmetic or textual: typos, textures, sounds, tooltips, wording, small UI issues.

project: one of "The Waking World", "Colonist Errands", "Voyager", "Modpack", or null if unclear.

Reports may be in any language. Judge the described symptom, not the tone: a calm report of a
crash is still critical, and an angry report of a typo is still minor.

Reply exactly: {"severity":"...","project":"..." or null,"reason":"under 20 words"}`;

const COOLDOWN_MS = (Number(process.env.GEMINI_COOLDOWN_MIN) || 60) * 60 * 1000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- the key ring ---------------------------------------------------------------------------

const keys = (process.env.GEMINI_API_KEY || '')
  .split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean)
  .map((key, i) => ({ key, n: i + 1, coolUntil: 0, model: null }));
let cursor = 0;

/** The next key that is not standing down, starting where the last call left off. */
function nextKey() {
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(cursor + i) % keys.length];
    if (k.coolUntil <= now) { cursor = (cursor + i + 1) % keys.length; return k; }
  }
  return null;
}

function standDown(k, why) {
  k.coolUntil = Date.now() + COOLDOWN_MS;
  log(`[triage] gemini key ${k.n}/${keys.length} stood down for ${COOLDOWN_MS / 60000} min (${why})`);
}

// ---- picking a model ------------------------------------------------------------------------

// in order of preference: the cheap fast ones first, and never a preview or a thinking model
const WANTED = [/flash-lite/, /flash/, /pro/];

/** Ask the account which models it actually has, rather than guessing a name that may be gone. */
async function pickModel(k, signal) {
  if (k.model) return k.model;
  if (process.env.GEMINI_MODEL) { k.model = process.env.GEMINI_MODEL; return k.model; }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${k.key}&pageSize=200`, { signal });
  if (!r.ok) throw new Error(`models ${r.status}`);
  const j = await r.json();
  const usable = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''))
    .filter((n) => !/preview|exp|thinking|tts|image|embedding|vision/i.test(n));
  for (const want of WANTED) {
    const hit = usable.filter((n) => want.test(n)).sort().reverse()[0];   // newest of that family
    if (hit) { k.model = hit; log(`[triage] gemini key ${k.n}: using ${hit}`); return hit; }
  }
  throw new Error('no usable model on this key');
}

// ---- the call -------------------------------------------------------------------------------

async function gemini(input) {
  if (!keys.length) return null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const k = nextKey();
    if (!k) { log('[triage] every gemini key is cooling - keywords only'); return null; }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    try {
      const model = await pickModel(k, ac.signal);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k.key}`,
        { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: RUBRIC }] },
            contents: [{ role: 'user', parts: [{ text: input }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json' },
          }) });
      if (r.status === 429) { standDown(k, 'rate limited'); continue; }
      if (r.status === 403) {
        const body = await r.text();
        if (/quota|exhaust|billing/i.test(body)) { standDown(k, 'quota'); continue; }
        throw new Error('403');
      }
      if (!r.ok) throw new Error(`gemini ${r.status}`);
      const j = await r.json();
      return j?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) {
      if (e.name === 'AbortError') { log(`[triage] gemini key ${k.n} timed out`); return null; }
      log(`[triage] gemini key ${k.n}: ${e.message}`);
      if (/models |no usable model/.test(e.message)) { standDown(k, 'bad key'); continue; }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function anthropic(input) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
        max_tokens: 200, temperature: 0, system: RUBRIC,
        messages: [{ role: 'user', content: input }],
      }) });
    if (!r.ok) throw new Error(`anthropic ${r.status}`);
    const j = await r.json();
    return j?.content?.[0]?.text || null;
  } catch (e) {
    log('[triage] anthropic pass skipped:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ask(title, body) {
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (!provider || provider === 'none') return null;
  const input = `Title: ${title || '(none)'}\n\nBody:\n${(body || '').slice(0, 6000)}`;
  const text = provider === 'gemini' ? await gemini(input)
             : provider === 'anthropic' ? await anthropic(input)
             : null;
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    log('[triage] model answered something that is not JSON');
    return null;
  }
}

/** For the startup line: how many keys are on the ring. */
function describe() {
  const p = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (!p || p === 'none') return 'off';
  if (p === 'gemini') return `gemini (${keys.length} key${keys.length === 1 ? '' : 's'})`;
  return p;
}

module.exports = { ask, describe };
