/** No network, no Discord: just the classifier, against reports that look like real ones. */
'use strict';
const { classify, reconcile } = require('./triage');

const CASES = [
  ['crash on world load',
   'Every time I load my world the game crashes. Log: https://mclo.gs/abc123',
   'critical', null, false],
  ['Game wont start',
   "After updating the game gets stuck on the loading screen and won't launch.",
   'critical', null, true],
  ['Colossus never spawns',
   'I did the ritual at the altar in The Waking World but the colossus does not spawn. NeoForge 21.1.248, mod 0.1.0-beta.5',
   'major', 'The Waking World', true],
  ['typo in the almanac',
   'Small thing - the almanac says "Wakers" but the tooltip says "Waker". Purely visual.',
   'minor', 'The Waking World', false],
  ['missing texture on starstone',
   'The starstone block is purple and black for me.',
   'minor', 'The Waking World', false],
  ['TPS drops to 5',
   'With Colonist Errands installed the server TPS drops to 5 whenever citizens talk. Unplayable.',
   'major', 'Colonist Errands', true],
  ['sesuje se ob zagonu',
   'Ko dodam mod v pack, se igra sesuje ob zagonu. Voyager 1.2',
   'critical', 'Voyager', true],
  ['ne dela ukaz',
   'Ukaz za errand ne dela, colonist se samo zatakne.',
   'major', 'Colonist Errands', true],
  ['duplication with the hammer',
   'You can dupe items by dropping them into the colossus hammer swing.',
   'critical', 'The Waking World', true],
  ['stack trace, no keywords',
   'It stops. Here is what the console says:\n    at me.lovkar.wakingworld.Foo.bar(Foo.java:1)\n    at me.lovkar.wakingworld.Foo.baz(Foo.java:2)\n    at me.lovkar.wakingworld.Foo.qux(Foo.java:3)',
   'critical', 'The Waking World', false],
  ['no signal at all',
   'Something is off with the modpack, not sure what.',
   'major', 'Modpack', true],
];

let bad = 0;
for (const [title, body, sev, proj, needsLog] of CASES) {
  const r = classify(title, body, 0);
  const ok = r.severity === sev && r.project === proj && r.needsLog === needsLog;
  if (!ok) {
    bad++;
    console.log(`FAIL  ${title}\n      want ${sev}/${proj}/log:${needsLog}\n      got  ${r.severity}/${r.project}/log:${r.needsLog}  (${r.why})`);
  }
}

// the model may never talk a stack trace down to Minor
const traced = 'x\n    at a.b.C(d:1)\n    at a.b.C(d:2)\n    at a.b.C(d:3)';
const floored = reconcile(classify('x', traced), { severity: 'minor', reason: 'looks cosmetic' }, traced);
if (floored.severity !== 'critical') { bad++; console.log('FAIL  the stack-trace floor did not hold'); }

// a report the model calls cosmetic is not nagged for a crash log
const vague = classify('hm', 'nekaj je cudno pri mahovnem velikanu');
if (!vague.needsLog) { bad++; console.log('FAIL  a vague report should still want a log'); }
const cosmetic = reconcile(vague, { severity: 'minor', reason: 'purely cosmetic' }, 'x');
if (cosmetic.needsLog) { bad++; console.log('FAIL  a cosmetic report should not be nagged for a log'); }
if (vague.project !== 'The Waking World') { bad++; console.log('FAIL  "mahovni velikan" should map to The Waking World, got ' + vague.project); }

// but it may move an unclear report between the ordinary buckets
const moved = reconcile(classify('hm', 'the wording is odd'), { severity: 'minor', project: 'Voyager', reason: 'wording' }, 'the wording is odd');
if (moved.severity !== 'minor' || moved.project !== 'Voyager') { bad++; console.log('FAIL  the model pass was ignored'); }

console.log(bad ? `\n${bad} failing` : `all ${CASES.length + 5} cases pass`);
process.exit(bad ? 1 : 0);
