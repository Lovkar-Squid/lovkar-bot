/**
 * The optional second opinion.
 *
 * Off unless LLM_PROVIDER is set. Everything it returns passes back through triage.reconcile(),
 * so the worst a bad answer can do is move a report one bucket - never below the evidence.
 * One call per new post, a 12-second budget, and any failure falls back to the keywords silently.
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

async function ask(title, body) {
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (!provider || provider === 'none') return null;
  const input = `Title: ${title || '(none)'}\n\nBody:\n${(body || '').slice(0, 6000)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    let text;
    if (provider === 'gemini') {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return null;
      const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: RUBRIC }] },
            contents: [{ role: 'user', parts: [{ text: input }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json' },
          }) });
      if (!r.ok) throw new Error(`gemini ${r.status}`);
      const j = await r.json();
      text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    } else if (provider === 'anthropic') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return null;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key,
                   'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
          max_tokens: 200, temperature: 0, system: RUBRIC,
          messages: [{ role: 'user', content: input }],
        }) });
      if (!r.ok) throw new Error(`anthropic ${r.status}`);
      const j = await r.json();
      text = j?.content?.[0]?.text;
    } else {
      return null;
    }
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn('[triage] model pass skipped:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ask };
