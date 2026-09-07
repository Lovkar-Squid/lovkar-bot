/** No network, no Discord: the multipart parser and the rules about what a pack may carry. */
'use strict';
const packs = require('./packs');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

// ---- the multipart parser ----------------------------------------------------------------------
const B = '----sentineltest';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);

function part(head, body) {
  return Buffer.concat([Buffer.from(`--${B}\r\n${head}\r\n\r\n`), body, Buffer.from('\r\n')]);
}
const body = Buffer.concat([
  part('Content-Disposition: form-data; name="kind"', Buffer.from('sneak')),
  part('Content-Disposition: form-data; name="caption"', Buffer.from('a line\nwith a break')),
  part('Content-Disposition: form-data; name="files"; filename="shot one.png"\r\nContent-Type: image/png', PNG),
  part('Content-Disposition: form-data; name="files"; filename="../evil/two.jpg"\r\nContent-Type: image/jpeg', Buffer.from('jpegbytes')),
  Buffer.from(`--${B}--\r\n`),
]);

const got = packs.multipart(body, `multipart/form-data; boundary=${B}`);
if (got.fields.kind !== 'sneak') fail('the kind field is wrong: ' + got.fields.kind);
if (got.fields.caption !== 'a line\nwith a break') fail('the caption lost its line break');
if (got.files.length !== 2) fail(`two files expected, got ${got.files.length}`);
if (got.files[0].name !== 'shot one.png') fail('the filename is wrong: ' + got.files[0].name);
// a filename with a path in it must not stay a path
if (got.files[1].name !== '.._evil_two.jpg') fail('a path in the filename was not flattened: ' + got.files[1].name);
// and the bytes must survive exactly - this is the whole reason the parser walks the buffer
if (!got.files[0].data.equals(PNG)) fail('the png bytes did not survive the parse');
if (got.files[0].data.length !== PNG.length) fail('the png changed length');

try {
  packs.multipart(Buffer.from('nonsense'), 'application/json');
  fail('a non-multipart body should be refused');
} catch { /* expected */ }

// ---- the packs themselves ------------------------------------------------------------------------
if (!packs.about('sneak') || !packs.about('bts')) fail('both packs should exist');
if (packs.about('nope')) fail('an unknown pack should be null');
if (packs.about('sneak').channel !== 'sneak-peek') fail('sneak goes to #sneak-peek');
if (packs.about('bts').channel !== 'behind-the-scenes') fail('bts goes to #behind-the-scenes');
if (!packs.kinds().includes('sneak')) fail('kinds() should list sneak');

// ---- what post() refuses, checked without a Discord connection -------------------------------------
const guild = { channels: { cache: new Map() } };
guild.channels.cache.find = function (f) { return [...this.values()].find(f); };

async function refuses(what, fn) {
  try {
    await fn();
    fail(`${what} should have been refused`);
  } catch (e) {
    if (/^no such pack|no files|not an image|is the most|there is no #/.test(e.message)) return;
    fail(`${what} was refused for the wrong reason: ${e.message}`);
  }
}

(async () => {
  const one = [{ name: 'a.png', data: Buffer.alloc(10) }];
  await refuses('an unknown pack', () => packs.post(guild, 'nope', one, '', 'test'));
  await refuses('no files at all', () => packs.post(guild, 'sneak', [], '', 'test'));
  await refuses('a .exe', () => packs.post(guild, 'sneak', [{ name: 'x.exe', data: Buffer.alloc(4) }], '', 'test'));
  await refuses('a file over the size limit',
    () => packs.post(guild, 'sneak', [{ name: 'big.png', data: Buffer.alloc(packs.MAX_BYTES + 1) }], '', 'test'));
  await refuses('more files than allowed',
    () => packs.post(guild, 'sneak', Array.from({ length: packs.MAX_FILES + 1 },
      (_, i) => ({ name: `p${i}.png`, data: Buffer.alloc(4) })), '', 'test'));
  await refuses('a channel that is not there', () => packs.post(guild, 'sneak', one, '', 'test'));

  // and what it does when the channel IS there: batches of ten, the caption only on the first
  const sent = [];
  guild.channels.cache.set('c', { name: 'sneak-peek', send: async (m) => { sent.push(m); return { url: 'u' + sent.length }; } });
  const many = Array.from({ length: 23 }, (_, i) => ({ name: `p${i}.png`, data: Buffer.alloc(4) }));
  const out = await packs.post(guild, 'sneak', many, '  hello  ', 'test');
  if (out.messages !== 3) fail(`23 files should be 3 messages, got ${out.messages}`);
  if (sent[0].content !== 'hello') fail('the caption should be trimmed onto the first message');
  if (sent[1].content !== undefined) fail('only the first message carries the caption');
  if (sent[0].files.length !== 10 || sent[2].files.length !== 3) fail('the batches are wrong');
  if (out.urls.length !== 3) fail('every message should give back its link');

  // an empty caption falls back to the pack's own line
  sent.length = 0;
  await packs.post(guild, 'sneak', [{ name: 'a.png', data: Buffer.alloc(4) }], '   ', 'test');
  if (sent[0].content !== packs.about('sneak').blurb) fail('an empty caption should use the pack blurb');

  console.log(bad ? `\n${bad} failing` : 'all packs cases pass');
  process.exit(bad ? 1 : 0);
})();
