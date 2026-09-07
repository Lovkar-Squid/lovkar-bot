/** No Discord: the waking hours, the spacing, and a picture that survives being put down. */
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

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all queue cases pass');
  process.exit(bad ? 1 : 0);
})();
