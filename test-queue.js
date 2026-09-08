/**
 * No Discord, and no clock but the one it is handed: the waking hours, the spacing, the named
 * times of QUEUE_AT, and a picture that survives being put down.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-queue-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.QUEUE_DIR = path.join(dir, 'queue');
process.env.QUEUE_EVERY_HOURS = '72';
process.env.QUEUE_FROM_HOUR = '9';
process.env.QUEUE_TO_HOUR = '22';

const db = require('./db');
const queue = require('./queue');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const quiet = () => {};
const at = (h) => { const d = new Date(2026, 0, 1, h, 30); return d; };

// ---- the hours it is awake ----------------------------------------------------------------------
if (queue.awake(at(9)) !== true) fail('nine in the morning is awake');
if (queue.awake(at(21)) !== true) fail('nine at night is awake');
if (queue.awake(at(22)) !== false) fail('ten at night is not');
if (queue.awake(at(4)) !== false) fail('four in the morning is not');
if (queue.awake(at(8)) !== false) fail('eight in the morning is not yet');

// ---- reading the times it is told to post at ----------------------------------------------------
// QUEUE_AT is unset here, so the queue is on the spacing rule and these are asked their times
// outright rather than through the environment. The sweep below moves the setting in place.
if (queue.onClock()) fail('with QUEUE_AT unset the queue should still be on the spacing rule');
if (queue.slots('18:00').join() !== '1080') fail('18:00 is 1080 minutes past midnight');
if (queue.slots('12:30,19:00').join() !== '750,1140') fail('two times should come back as two');
if (queue.slots('19:00, 12:30').join() !== '750,1140') fail('the times should come back in order');
if (queue.slots('9:05,09:05').join() !== '545') fail('the same time twice is still one time');
if (queue.slots('00:00,23:59').join() !== '0,1439') fail('midnight and the minute before it are both times');
if (queue.slots('18:00,25:00').join() !== '1080') fail('one unreadable time should not take a good one with it');

if (queue.days('').length) fail('no days named means every day');
if (queue.days('mon,fri').join() !== '1,5') fail('mon and fri are the first and the fifth day');
if (queue.days(' Tuesday , THU ').join() !== '2,4') fail('the day names should be read forgivingly');
if (queue.days('fri,mon,fri').join() !== '1,5') fail('the days should be in order and said once');
if (queue.days('nonsense').length) fail('an unreadable day should mean every day, not no days');

// March 2026: the 10th is a Tuesday, the 11th a Wednesday, the 13th a Friday.
const when = (d, h, m) => new Date(2026, 2, d, h, m).getTime();
const six = { at: '18:00' };
if (queue.dueSlot(when(10, 18, 0), null, six) !== when(10, 18, 0)) fail('a named time is owed at that time');
if (queue.dueSlot(when(10, 18, 14), null, six) !== when(10, 18, 0)) fail('a sweep a quarter of an hour late still owes it');
if (queue.dueSlot(when(10, 17, 59), null, six) !== null) fail('a minute to six is not yet six');
if (queue.dueSlot(when(10, 19, 40), null, six) !== null) fail('an hour and three quarters late is missed, not owed');
if (queue.dueSlot(when(10, 18, 20), when(10, 18, 0), six) !== null) fail('a time already served should not be owed twice');
if (queue.dueSlot(when(11, 18, 5), when(10, 18, 0), six) !== when(11, 18, 0)) fail('the same time tomorrow is owed again');
// the mark goes into the book as an ISO string, and must mean the same as the number it came from
if (queue.dueSlot(when(10, 18, 20), new Date(when(10, 18, 0)).toISOString(), six) !== null) {
  fail('the mark should mean the same written as a date as it does written as a number');
}
// two in a day, in the order they are named
const twice = { at: '12:30,19:00' };
if (queue.dueSlot(when(10, 12, 30), null, twice) !== when(10, 12, 30)) fail('the first time of the day is owed first');
if (queue.dueSlot(when(10, 19, 2), when(10, 12, 30), twice) !== when(10, 19, 0)) fail('the second is owed after it');
// both of them behind it at once: the later one wins, so a bot that was away posts once, not twice
if (queue.dueSlot(when(10, 19, 5), null, { at: '18:00,19:00' }) !== when(10, 19, 0)) {
  fail('with two times behind it, the later one is the one that is owed');
}
// a time late in the evening can still be caught a few minutes after midnight
if (queue.dueSlot(when(11, 0, 5), null, { at: '23:30' }) !== when(10, 23, 30)) {
  fail('half past eleven should still be catchable at five past midnight');
}
// the days it posts on
if (queue.dueSlot(when(11, 19, 0), null, { at: '19:00', on: 'tue,fri' }) !== null) {
  fail('a Wednesday is neither a Tuesday nor a Friday');
}
if (queue.dueSlot(when(13, 19, 0), null, { at: '19:00', on: 'tue,fri' }) !== when(13, 19, 0)) {
  fail('a Friday is one of them');
}
// how long a missed time stays worth posting is a setting of its own
if (queue.dueSlot(when(10, 18, 50), null, { at: '18:00', catchup: 30 }) !== null) {
  fail('fifty minutes late is outside a half-hour catch-up');
}
if (queue.dueSlot(when(10, 18, 50), null, { at: '18:00', catchup: 120 }) !== when(10, 18, 0)) {
  fail('and inside a two-hour one');
}
// nothing readable in QUEUE_AT leaves the queue on the spacing rule, rather than throwing
for (const nonsense of ['nonsense', '25:00', '18:70', '', '   ', 'half six', '6pm', '18']) {
  if (queue.slots(nonsense).length) fail(`"${nonsense}" is not a time of day`);
  if (queue.dueSlot(when(10, 18, 0), null, { at: nonsense }) !== null) {
    fail(`"${nonsense}" should leave the queue on the spacing rule`);
  }
}

// ---- putting some in ------------------------------------------------------------------------------
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const three = [
  { name: 'one.png', data: png },
  { name: 'two.png', data: png },
  { name: 'three.png', data: png },
];

let refused = false;
try { queue.add('sneak', three, { who: 'a test' }); } catch { refused = true; }
if (!refused) fail('a queue without a book should be refused');

db.open(quiet);
const added = queue.add('sneak', three, { caption: 'a line', who: 'a test', log: quiet });
if (added.queued !== 3) fail('three should have gone in, got ' + added.queued);

const waiting = db.queueWaiting();
if (waiting.length !== 3) fail('three should be waiting, got ' + waiting.length);
if (waiting[0].caption !== 'a line') fail('the caption was not kept');
if (waiting[0].kind !== 'sneak') fail('the kind was not kept');
// the first goes out at once and the rest are spaced: dropping twenty pictures should show one
// straight away, not leave the channel silent for three days
if (waiting[0].due > Date.now() + 2000) fail('the first one should be due at once');
const gap = waiting[1].due - waiting[0].due;
if (Math.abs(gap - 72 * 3600 * 1000) > 1000) fail('they should be three days apart, got ' + (gap / 3600000) + 'h');
if (waiting[2].due <= waiting[1].due) fail('the queue is not in order');
// the bytes are on disk, and are the bytes that went in
if (!fs.existsSync(waiting[0].file)) fail('the picture was not kept on disk');
if (!fs.readFileSync(waiting[0].file).equals(png)) fail('the bytes changed on the way to disk');
// a name with a path in it must not climb out of the store
const climbed = queue.keep('../../escape.png', png);
if (path.dirname(climbed) !== path.resolve(process.env.QUEUE_DIR)) fail('a picture escaped the store: ' + climbed);

// joining the back of the line
queue.add('bts', [{ name: 'four.png', data: png }], { who: 'a test', log: quiet });
const four = db.queueWaiting();
if (four.length !== 4) fail('four should be waiting now');
if (four[3].due <= four[2].due) fail('the new one should be behind the old ones');

for (const [what, fn] of [
  ['an unknown pack', () => queue.add('nope', three, {})],
  ['no files', () => queue.add('sneak', [], {})],
  ['a picture bigger than Discord takes', () => queue.add('sneak', [{ name: 'big.png', data: Buffer.alloc(11 * 1024 * 1024) }], {})],
]) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) fail(`${what} should have been refused`);
}

// ---- taking one out ---------------------------------------------------------------------------------
const gone = queue.drop(four[3].id, quiet);
if (gone.name !== 'four.png') fail('the wrong one was dropped');
if (db.queueWaiting().length !== 3) fail('three should be left');
if (fs.existsSync(four[3].file)) fail('a dropped picture should not stay on disk');

// ---- posting the next one ----------------------------------------------------------------------------
const sent = [];
const channel = { id: '9', name: 'sneak-peek', send: async (p) => { sent.push(p); return { id: 'm', url: 'https://x/m' }; } };
const guild = { channels: { cache: new Map([['9', channel]]) } };
guild.channels.cache.find = function (f) { return [...this.values()].find(f); };

(async () => {
  const first = db.queueWaiting()[0];
  const out = await queue.tick(guild, { log: quiet, force: true, now: Date.now() });
  if (!out) fail('the first one should have gone out at once');
  if (out.name !== 'one.png') fail('the wrong picture went: ' + (out && out.name));
  if (sent[0].content !== 'a line') fail('the caption did not go with it: ' + JSON.stringify(sent[0].content));
  if (sent[0].files[0].name !== 'one.png') fail('the file did not go with it');
  if (db.queueWaiting().length !== 2) fail('two should be left waiting');
  // and the one behind it is not due yet, so a second tick now does nothing
  if (await queue.tick(guild, { log: quiet, force: true, now: Date.now() })) {
    fail('the second one should have to wait its three days');
  }
  if (fs.existsSync(first.file)) fail('a posted picture should not stay on disk');
  if (!db.queueList(10).find((r) => r.id === first.id).posted_at) fail('it should be written down as posted');

  // a picture whose file has vanished is dropped rather than retried for ever
  const next = db.queueWaiting()[0];
  fs.unlinkSync(next.file);
  const nothing = await queue.tick(guild, { log: quiet, force: true, now: next.due + 1000 });
  if (nothing) fail('a picture with no file should not be posted');
  if (db.queueWaiting().find((r) => r.id === next.id)) fail('a picture with no file should leave the queue');

  // ---- the same queue, on a clock instead ---------------------------------------------------------
  // The settings are read at startup, so the test moves them in place the way test-suggestions.js
  // does rather than requiring the file a second time. Nothing here waits for a real minute to
  // pass: every sweep is told what time it is.
  for (const left of db.queueWaiting()) queue.drop(left.id, quiet);
  queue.CONF.at = '12:30,19:00';
  queue.CONF.days = '';
  if (!queue.onClock()) fail('QUEUE_AT should put the queue on a clock');

  const began = new Date(2026, 2, 1).getTime();
  queue.add('sneak', ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'].map((name) => ({ name, data: png })),
    { who: 'a test', when: began, log: quiet });
  const lined = db.queueWaiting();
  if (lined.length !== 6) fail('six should be waiting, got ' + lined.length);
  if (lined.some((r) => r.due !== began)) fail('on a clock nothing is spaced out: they are all simply due');

  sent.length = 0;
  const noon = new Date(2026, 2, 10, 12, 30).getTime();
  const firstOut = await queue.tick(guild, { log: quiet, now: noon });
  if (!firstOut) fail('half past twelve is one of the named times and should have posted');
  if (firstOut && firstOut.name !== 'a.png') fail('the queue should go out in the order it went in: ' + firstOut.name);
  if (db.get('queue:fired') !== new Date(noon).toISOString()) fail('the time that was served should be written down');
  if (await queue.tick(guild, { log: quiet, now: noon + 15 * 60000 })) {
    fail('a time already served should not be served again a quarter of an hour later');
  }
  if (await queue.tick(guild, { log: quiet, now: noon + 3600000 })) fail('nor an hour later');

  // the second named time of the same day goes out too, and takes the next picture in the line
  const evening = new Date(2026, 2, 10, 19, 0).getTime();
  const secondOut = await queue.tick(guild, { log: quiet, now: evening + 4 * 60000 });
  if (!secondOut) fail('the second named time of the day should have posted as well');
  if (secondOut && secondOut.name !== 'b.png') fail('b.png should have been next, got ' + secondOut.name);
  if (db.get('queue:fired') !== new Date(evening).toISOString()) {
    fail('the mark should be the named time, not the minute the sweep happened to run');
  }

  // a bot that was off all day comes back long after the evening time: that one is missed, not late
  if (await queue.tick(guild, { log: quiet, now: new Date(2026, 2, 11, 20, 45).getTime() })) {
    fail('a time missed by more than the catch-up window should stay missed');
  }
  if (db.get('queue:fired') !== new Date(evening).toISOString()) fail('a missed time should not move the mark');

  // ---- and only on the days it was told ------------------------------------------------------------
  queue.CONF.days = 'tue,fri';
  if (await queue.tick(guild, { log: quiet, now: new Date(2026, 2, 11, 19, 0).getTime() })) {
    fail('Wednesday is not one of the days, so nothing should have gone out');
  }
  const friday = new Date(2026, 2, 13, 19, 0).getTime();
  const fridayOut = await queue.tick(guild, { log: quiet, now: friday });
  if (!fridayOut) fail('Friday is one of the days and should have posted');
  if (fridayOut && fridayOut.name !== 'c.png') fail('c.png should have been next, got ' + fridayOut.name);

  // the mark lives in the book and not in memory: this is what the next deploy reads back
  const mark = db.get('queue:fired');
  if (mark !== new Date(friday).toISOString()) fail('Friday evening should be the mark now, got ' + mark);
  const both = { at: queue.CONF.at, on: queue.CONF.days };
  if (queue.dueSlot(friday + 10 * 60000, mark, both) !== null) {
    fail('a time served before a restart should still count as served after one');
  }
  const tuesday = new Date(2026, 2, 17, 19, 0).getTime();
  if (queue.dueSlot(tuesday + 60000, mark, both) !== tuesday) fail('the Tuesday after should be owed again');

  // ---- /queue now ----------------------------------------------------------------------------------
  const odd = new Date(2026, 2, 14, 16, 5).getTime();       // a Saturday teatime: no named time near it
  if (await queue.tick(guild, { log: quiet, now: odd })) fail('four in the afternoon is not a named time');
  const byHand = await queue.tick(guild, { log: quiet, now: odd, force: true });
  if (!byHand) fail('asking for one by hand should post it whatever the clock says');
  if (db.get('queue:fired') !== mark) fail('a picture asked for by hand should not use up a named time');

  // ...but asking by hand while a named time is owed does use that one up, or the sweep would put
  // a second picture out a quarter of an hour later
  if (!(await queue.tick(guild, { log: quiet, now: tuesday + 3 * 60000, force: true }))) {
    fail('the queue should still post by hand inside a named time');
  }
  if (db.get('queue:fired') !== new Date(tuesday).toISOString()) fail('that named time should have been used up');
  if (await queue.tick(guild, { log: quiet, now: tuesday + 18 * 60000 })) {
    fail('the sweep should not post again a quarter of an hour after a hand-posted picture');
  }

  // ---- and back to the spacing rule when the times cannot be read ----------------------------------
  queue.CONF.days = '';
  for (const nonsense of ['nonsense', '25:00', '18:70', '']) {
    queue.CONF.at = nonsense;
    const said = nonsense || '(empty)';
    if (queue.onClock()) fail(`QUEUE_AT=${said} should leave the queue on the spacing rule`);
    if (await queue.tick(guild, { log: quiet, now: new Date(2026, 2, 18, 4, 0).getTime() })) {
      fail(`QUEUE_AT=${said} should be back on the waking window, and four in the morning is not in it`);
    }
  }
  const morning = await queue.tick(guild, { log: quiet, now: new Date(2026, 2, 18, 10, 0).getTime() });
  if (!morning) fail('ten in the morning is inside the waking window, so the spacing rule should have posted');
  if (sent.length !== 6) fail('six pictures should have gone out on the clock, got ' + sent.length);
  if (db.queueWaiting().length) fail('the queue should be empty now');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all queue cases pass');
  process.exit(bad ? 1 : 0);
})();
