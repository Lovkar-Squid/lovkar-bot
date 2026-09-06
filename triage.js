/**
 * Reading a bug report and deciding how loud it is.
 *
 * Two passes. The first is keywords - free, instant, and easy for a human to argue with, which
 * matters more than being clever: every decision here can be traced back to a word in this file.
 * The second (optional) is a language model, for reports the keywords do not cover - a bug
 * described in Slovene, or in a roundabout way, or by someone who never says "crash".
 *
 * The model can only ever move a report between the same three buckets. If the text carries a
 * stack trace or a crash report, nothing is allowed to call it Minor.
 */

'use strict';

const SEVERITIES = ['critical', 'major', 'minor'];

// weight, then the words. Higher weight = stronger evidence. Matching is on lowercased text
// with punctuation kept, so "won't" and "wont" both need listing.
const RULES = {
  critical: [
    [5, ['crash', 'crashes', 'crashing', 'crashed', 'crash-report', 'crash report', 'crashlog']],
    [5, ['stack trace', 'java.lang.', 'exception in thread', 'nullpointerexception',
         'classnotfoundexception', 'nosuchmethoderror', 'noclassdeffounderror',
         'mixin apply failed', 'exit code 1', 'exit code -1', 'fatal error']],
    [5, ['lost my world', 'world is gone', 'world corrupt', 'corrupted world', 'save corrupt',
         'lost all my', 'lost everything', 'wiped my']],
    [4, ["won't launch", 'wont launch', "won't start", 'wont start', 'does not start',
         "doesn't start", "won't load", 'wont load', 'does not load', 'stuck on loading',
         'stuck at loading', 'black screen', 'infinite loading']],
    [4, ['dupe', 'duping', 'duplication', 'duplicates items', 'item duplication']],
    [3, ['server crash', 'server wont start', "server won't start", 'kicked from server',
         'disconnect', 'connection lost', 'watchdog', 'server thread dump']],
    [3, ['data loss', 'lost items', 'lost my inventory', 'inventory wiped']],
    // Slovene / neighbouring languages
    [5, ['sesuje', 'sesulo', 'crasha', 'crashne', 'crasha mi']],
    [4, ['se ne zažene', 'se ne zazene', 'ne zažene', 'ne zazene', 'se ne naloži', 'se ne nalozi',
         'ne naloži', 'ne nalozi', 'izgubil svet', 'izgubil sem svet', 'svet je izginil']],
  ],
  major: [
    [3, ['does not work', "doesn't work", 'not working', 'stopped working', 'broken', 'is broken']],
    [3, ["can't progress", 'cant progress', 'softlock', 'soft lock', 'soft-locked', 'stuck forever',
         'no way to continue', 'quest stuck', 'ritual stuck', 'cannot finish', "can't finish"]],
    [3, ['does not spawn', "doesn't spawn", 'never spawns', 'not spawning', 'nothing spawns',
         'no structures', 'no structure generates', 'never generates']],
    [3, ['memory leak', 'ram usage', 'out of memory', 'outofmemoryerror']],
    [2, ['tps', 'lag', 'lagging', 'lag spike', 'fps drop', 'stutter', 'freezes', 'freeze',
         'unplayable', 'chunk lag']],
    [2, ['recipe missing', 'no recipe', 'cannot craft', "can't craft", 'not craftable']],
    [2, ['takes no damage', 'invincible', 'infinite health', 'never dies', 'instantly dies',
         'one shot', 'one-shots me']],
    [2, ['duplicate entity', 'entity stuck', 'stuck in the ground', 'falls through the world']],
    [3, ['ne dela', 'ne deluje', 'ne dela več', 'ne dela vec', 'se zatakne', 'zatakne se',
         'ne morem naprej', 'ne morem dokončati', 'ne morem dokoncati', 'ne spawna',
         'se ne pojavi', 'ne generira']],
  ],
  minor: [
    [3, ['typo', 'spelling', 'misspelled', 'grammar', 'wrong word', 'translation']],
    [3, ['missing texture', 'purple and black', 'wrong texture', 'texture is', 'model looks',
         'floating pixel', 'z-fighting', 'misaligned', 'off by one pixel']],
    [2, ['sound', 'audio', 'music is', 'too loud', 'too quiet', 'no sound', 'volume']],
    [2, ['tooltip', 'wrong name', 'item name', 'description says', 'ui', 'text overlaps',
         'cut off text', 'cosmetic', 'visual only', 'only visual', 'purely visual']],
    [2, ['tipkarska', 'črkovna', 'crkovna', 'napačno ime', 'napacno ime', 'tekstura manjka',
         'samo vizualno', 'kozmeti']],
  ],
};

// which project a report is about - the tag names must match the forum's own tags
const PROJECTS = [
  ['The Waking World', ['waking world', 'wakingworld', 'thewakingworld', 'colossus', 'colossi',
                        'titan', 'dead letter', 'shrine', 'rune sentinel', 'ember wraith',
                        'drowned keeper', 'hourglass', 'starstone', 'star iron', 'meteor',
                        'cataclysm', 'almanac', 'waker', 'wakers', 'altar', 'ritual', 'sigil',
                        'horn of waking', 'throne', 'titan gate', 'vault', 'kingdom']],
  ['Colonist Errands', ['colonist errands', 'colonist_errands', 'colonisterrands', 'errand',
                        'talking colonist', 'voice command', 'citizen', 'colonist']],
  ['Voyager', ['voyager', 'launchpad', 'launch pad', 'end gate', 'expedition']],
  ['Modpack', ['modpack', 'mod pack', 'minecolonies ultimate', 'the pack', 'wmu', 'lmu',
               'lovkar’s minecolonies', "lovkar's minecolonies"]],
];

const LOG_HINTS = ['latest.log', 'debug.log', 'crash-report', 'crash report', 'pastebin.com',
                   'mclo.gs', 'gist.github', 'hastebin', 'paste.ee', '```'];

/** Does the text look like it already carries a log or a stack trace? */
function hasLog(text, attachments = 0) {
  if (attachments > 0) return true;
  const t = text.toLowerCase();
  if (LOG_HINTS.some((h) => t.includes(h))) return true;
  // an unmarked stack trace: several lines starting with "at " is unmistakable
  const ats = (text.match(/^\s*at [\w$.]+\(/gm) || []).length;
  return ats >= 3;
}

/** A hard floor: some evidence can never be argued down to Minor. */
function floorSeverity(text) {
  const t = text.toLowerCase();
  const trace = (text.match(/^\s*at [\w$.]+\(/gm) || []).length >= 3;
  if (trace || t.includes('crash-report') || t.includes('exception in thread')) return 'critical';
  return null;
}

function score(text) {
  const t = text.toLowerCase();
  const out = { critical: 0, major: 0, minor: 0 };
  const hits = { critical: [], major: [], minor: [] };
  for (const sev of SEVERITIES) {
    for (const [w, words] of RULES[sev]) {
      for (const word of words) {
        if (t.includes(word)) { out[sev] += w; hits[sev].push(word); break; }
      }
    }
  }
  return { out, hits };
}

/**
 * The keyword pass.
 * @returns {{severity: string, project: string|null, needsLog: boolean, why: string}}
 */
function classify(title, body, attachments = 0) {
  const text = `${title || ''}\n${body || ''}`;
  const { out, hits } = score(text);
  let severity;
  if (out.critical > 0 && out.critical >= out.major && out.critical >= out.minor) severity = 'critical';
  else if (out.minor > out.major && out.minor > out.critical) severity = 'minor';
  else if (out.major > 0) severity = 'major';
  else severity = 'major';                                  // a bug report with no signal is still a bug

  const floor = floorSeverity(text);
  if (floor === 'critical') severity = 'critical';

  const t = text.toLowerCase();
  let project = null;
  let best = 0;
  for (const [name, words] of PROJECTS) {
    const n = words.filter((w) => t.includes(w)).length;
    if (n > best) { best = n; project = name; }
  }

  const log = hasLog(text, attachments);
  const why = hits[severity].length
    ? `keywords: ${hits[severity].slice(0, 4).join(', ')}`
    : 'no keywords matched - filed as Major by default';

  return { severity, project, needsLog: !log && severity !== 'minor', why };
}

/** Never let anything drop a report below what the evidence proves. */
function reconcile(heuristic, model, text) {
  if (!model || !SEVERITIES.includes(model.severity)) return heuristic;
  const merged = {
    severity: model.severity,
    project: model.project || heuristic.project,
    needsLog: heuristic.needsLog,
    why: `model: ${(model.reason || '').slice(0, 160)}`,
  };
  if (floorSeverity(text) === 'critical') {
    merged.severity = 'critical';
    merged.why += ' (floored to Critical: the post carries a stack trace)';
  }
  // the model may not invent a project the forum has no tag for
  if (merged.project && !PROJECTS.some(([n]) => n === merged.project)) merged.project = heuristic.project;
  return merged;
}

module.exports = { classify, reconcile, hasLog, floorSeverity, SEVERITIES, PROJECTS };
