/** No Discord, no network: what fits, what the line says, and what comes out of the drawing. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-wel-'));
process.env.DB_PATH = path.join(dir, 'test.db');
// Nothing in this test is allowed to touch /data, and the missing-background path is one of the
// ones worth exercising anyway - so the card is drawn on the flat colour throughout.
process.env.WELCOME_BACKGROUND = path.join(dir, 'no-such-background.jpg');

const db = require('./db');
const wel = require('./welcome');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const note = (m) => console.log('note  ' + m);
const quiet = () => {};

// ---- a context that knows nothing but arithmetic ------------------------------------------------
// Every glyph is six tenths of the font size wide, which is close enough to a real sans-serif for
// the stepping to be worth checking and is entirely predictable, which a real font is not.
function fakeCtx() {
  return {
    font: '10px sans-serif',
    measureText(s) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1]) || 10;
      return { width: [...String(s)].length * size * 0.6 };
    },
  };
}

const wide = (s, size) => [...s].length * size * 0.6;

// ---- shrinking a name to fit --------------------------------------------------------------------
{
  const ctx = fakeCtx();
  const ROOM = 688;

  // a name that already fits comes back at the size it was asked for, untouched
  if (wel.fit(ctx, 'Lovkar', ROOM, 76) !== 76) fail('a short name should keep the starting size: ' + wel.fit(ctx, 'Lovkar', ROOM, 76));
  if (wel.fit(ctx, '', ROOM, 76) !== 76) fail('an empty name should keep the starting size');

  // and one that does not is stepped down until it does, and no further
  const long = 'Bartholomew Fitzgerald-Wellington III';
  const got = wel.fit(ctx, long, ROOM, 76);
  if (got >= 76) fail('a long name should have been shrunk: ' + got);
  if (wide(long, got) > ROOM) fail(`${got}px still does not fit: ${wide(long, got)} > ${ROOM}`);
  if (wide(long, got + 2) <= ROOM) fail('it was shrunk further than it needed to be: ' + got);

  // the floor holds, however absurd the name is
  const absurd = wel.fit(ctx, 'x'.repeat(4000), ROOM, 76);
  const worse = wel.fit(ctx, 'x'.repeat(40000), ROOM, 76);
  if (absurd <= 0) fail('the floor should be a real size, got ' + absurd);
  if (absurd !== worse) fail(`a longer absurd name should still stop at the floor: ${absurd} then ${worse}`);
  if (absurd >= 76) fail('an absurd name should still have been shrunk: ' + absurd);
  // and a caller who asks for something below the floor is given the floor
  if (wel.fit(ctx, 'Lovkar', ROOM, 4) !== absurd) fail('below the floor should come back as the floor');
  if (wel.fit(ctx, 'Lovkar', ROOM, 0) !== absurd) fail('a nonsense starting size should come back as the floor');

  // no room at all is the same story: small, not zero and not for ever
  if (wel.fit(ctx, 'Lovkar', 0, 76) !== absurd) fail('nothing fits in no room, so the floor');

  // a runtime with no fonts measures everything as nothing, and must not shrink on the strength of it
  const blind = { font: '', measureText: () => ({ width: 0 }) };
  if (wel.fit(blind, 'x'.repeat(500), ROOM, 76) !== 76) fail('a zero measurement should count as fitting');
  const broken = { font: '', measureText: () => ({ width: NaN }) };
  if (wel.fit(broken, 'x'.repeat(500), ROOM, 76) !== 76) fail('a NaN measurement should count as fitting');

  // the family asked for is the family measured with
  wel.fit(ctx, 'Lovkar', ROOM, 76, 'Welcome');
  if (!/\bWelcome$/.test(ctx.font)) fail('fit should measure in the family it was given: ' + ctx.font);
}

// ---- the line of text above the picture ---------------------------------------------------------
{
  const member = { id: 'u1', user: { id: 'u1' } };
  if (wel.render('<@id> just walked in.', member) !== '<@u1> just walked in.') {
    fail('the mention token was not substituted: ' + wel.render('<@id> just walked in.', member));
  }
  if (wel.render('Welcome!', member) !== 'Welcome!') fail('a template with no token should be left alone');
  if (wel.render('<@id> and <@id>', member) !== '<@u1> and <@u1>') fail('every token should be substituted');
  if (!wel.CONF.text.includes('<@id>')) fail('the default line should carry the token: ' + wel.CONF.text);
  if (wel.render(wel.CONF.text, member) !== '<@u1> just walked in.') fail('the default line should read right');
  // an id read off the user rather than the member is just as good
  if (wel.render('<@id>', { user: { id: 'u9' } }) !== '<@u9>') fail('the id should be found on the user too');
  // and nothing to substitute leaves nothing behind, rather than the raw token
  if (wel.render('<@id> hello', {}) !== 'hello') fail('no id should leave no token: ' + wel.render('<@id> hello', {}));
  if (wel.render('one\\ntwo', member) !== 'one\ntwo') fail('an escaped newline should become one');
  for (const junk of [null, undefined]) {
    if (wel.render(junk, member) !== '') fail(`"${junk}" should render as nothing`);
  }
}

// ---- the picture itself -------------------------------------------------------------------------
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The dimensions, read back out of the file rather than taken on trust.
 *
 * <p>IHDR is always the first chunk of a PNG: eight bytes of signature, then the chunk's length and
 * its four-letter name, then the width and the height as big-endian 32-bit numbers.</p>
 */
function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// avatarUrl is deliberately empty everywhere: this test never goes near a network, and the initial
// circle is the path a card takes when the avatar could not be had anyway.
const who = (over = {}) => ({
  name: 'Lovkar', avatarUrl: '', memberNumber: 137, guildName: "Lovkar's Workshop",
  initial: 'L', ...over,
});

async function drawsA(what, over) {
  const png = await wel.card(who(over), { log: quiet });
  if (!Buffer.isBuffer(png)) { fail(`${what} did not come back as a buffer`); return; }
  const at = pngSize(png);
  if (!at) { fail(`${what} is not a PNG: ${png.subarray(0, 8).toString('hex')}`); return; }
  if (at.w !== 1000 || at.h !== 360) fail(`${what} came out ${at.w}x${at.h}, not 1000x360`);
  if (png.length < 1000) fail(`${what} came out suspiciously small: ${png.length} bytes`);
}

// ---- a member, a channel, and somewhere to write it down ------------------------------------------
function fakeChannel(name = 'joins') {
  const sent = [];
  return {
    id: 'c1', name, type: 0, sent,
    send: async (payload) => { sent.push(payload); return { id: 'm' + sent.length, url: 'u' }; },
  };
}

function fakeMember(channel, over = {}) {
  const guild = {
    name: "Lovkar's Workshop",
    memberCount: 137,
    channels: { cache: new Map(channel ? [[channel.id, channel]] : []) },
  };
  guild.channels.cache.find = function (f) { return [...this.values()].find(f); };
  return {
    id: 'u1',
    displayName: 'Lovkar',
    guild,
    user: { id: 'u1', tag: 'lovkar', displayAvatarURL: () => '' },
    ...over,
  };
}

/**
 * The same module, loaded again from scratch.
 *
 * <p>The library and the font are both settled once, when the file is first loaded and the first
 * card drawn, so the only honest way to test either of them is to load the file again with the
 * world arranged differently. <code>hide</code> takes the drawing library away entirely, which is
 * the state a deployment is in when the optional dependency did not install - the whole reason the
 * require is wrapped, and not something worth faking.</p>
 */
function reload({ hide = false } = {}) {
  const Module = require('module');
  const real = Module.prototype.require;
  delete require.cache[require.resolve('./welcome')];
  if (hide) {
    Module.prototype.require = function (id) {
      if (id === '@napi-rs/canvas') {
        const e = new Error("Cannot find module '@napi-rs/canvas'");
        e.code = 'MODULE_NOT_FOUND';
        throw e;
      }
      return real.apply(this, arguments);
    };
  }
  try {
    return require('./welcome');
  } finally {
    Module.prototype.require = real;
  }
}

(async () => {
  db.open(quiet);

  const canDraw = Buffer.isBuffer(await wel.card(who(), { log: quiet }));
  if (!canDraw) {
    note('@napi-rs/canvas is not installed - skipping the drawing cases');
    note('      (install it with: npm install --no-save @napi-rs/canvas)');
  } else {
    await drawsA('a normal name');
    await drawsA('a very long name', { name: 'Bartholomew Fitzgerald-Wellington the Third of Somewhere' });
    await drawsA('a name of nothing but emoji', { name: '🐙🎉🔥✨', initial: '🐙' });
    await drawsA('an empty name', { name: '', initial: '' });
    await drawsA('a name that is only spaces', { name: '   ', initial: ' ' });
    await drawsA('no server name and no number', { memberNumber: 0, guildName: '' });
    await drawsA('a server name far too long to fit', { guildName: 'The '.repeat(40) + 'Workshop' });

    // the background: missing is already the case above, and a file that is not an image is the
    // other way the decode fails. Both have to end up as a card rather than as an exception.
    const missing = wel.CONF.background;
    const notAnImage = path.join(dir, 'not-a-picture.jpg');
    fs.writeFileSync(notAnImage, 'this is a text file wearing a jpg hat');
    wel.CONF.background = notAnImage;
    await drawsA('a background that will not decode');
    wel.CONF.background = '';
    await drawsA('no background configured at all');
    wel.CONF.background = missing;
    await drawsA('a background file that is not there');

    // WELCOME_FONT, which is settled once per load, so each of these needs its own module
    const junkFont = path.join(dir, 'not-a-font.ttf');
    fs.writeFileSync(junkFont, 'this is not a font either');
    const fonts = [
      ['a font file that is not there', path.join(dir, 'gone.ttf')],
      ['a font file that is not a font', junkFont],
      ['a setting that is not a font file at all', path.join(dir, 'background.jpg')],
      ['no font configured', ''],
    ];
    // A real font file if this machine has one - the deployed image may not, so it is a skip and
    // not a failure. It is the one case where the setting changes what the card looks like.
    const real = ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
      .find((p) => fs.existsSync(p));
    if (real) fonts.push(['a font file that really is one', real]);
    else note('no .ttf on this machine - skipping the registered-font case');

    for (const [what, value] of fonts) {
      process.env.WELCOME_FONT = value;
      const again = reload();
      again.CONF.background = missing;
      const png = await again.card(who(), { log: quiet });
      const at = pngSize(png);
      if (!at) { fail(`${what} should still draw a card`); continue; }
      if (at.w !== 1000 || at.h !== 360) fail(`${what} came out ${at.w}x${at.h}`);
    }
    delete process.env.WELCOME_FONT;
    reload();                                     // and back to the module the rest of this uses
  }

  // ---- posting it -------------------------------------------------------------------------------
  {
    const channel = fakeChannel();
    const member = fakeMember(channel);
    const out = await wel.join(member, { log: quiet });
    if (!out.posted) fail('a join in a server with a #joins should post: ' + out.why);
    if (out.drew !== canDraw) fail(`drew should say which path it took: ${out.drew} with canDraw ${canDraw}`);
    if (channel.sent.length !== 1) fail('one message expected, got ' + channel.sent.length);
    const msg = channel.sent[0] || {};
    if (msg.content !== '<@u1> just walked in.') fail('the line was not substituted: ' + msg.content);
    if (msg.allowedMentions?.users?.join(',') !== 'u1') fail('only the new member should be pinged');
    if (canDraw) {
      if (!msg.files || msg.files.length !== 1) fail('the card should be the one attachment');
      if (msg.files?.[0]?.name !== 'welcome.png') fail('the attachment should be welcome.png: ' + msg.files?.[0]?.name);
      if (!pngSize(msg.files?.[0]?.attachment)) fail('the attachment should be a PNG');
      if (msg.embeds) fail('a card that drew should not also carry an embed');
    }
  }

  // a rewritten line, to prove the substitution is the configuration and not the code
  {
    const was = wel.CONF.text;
    wel.CONF.text = 'come in <@id>, come in.';
    const channel = fakeChannel();
    await wel.join(fakeMember(channel), { log: quiet });
    if (channel.sent[0]?.content !== 'come in <@u1>, come in.') fail('a rewritten line should be used: ' + channel.sent[0]?.content);
    wel.CONF.text = was;
  }

  // no #joins: one line in the log, and nothing else at all
  {
    const elsewhere = fakeChannel('general');
    const member = fakeMember(elsewhere);
    const said = [];
    const out = await wel.join(member, { log: (m) => said.push(m) });
    if (out.posted) fail('there is no #joins, so nothing should have been posted');
    if (elsewhere.sent.length) fail('nothing should have been posted anywhere else either');
    if (said.length !== 1) fail('a missing channel is worth exactly one line: ' + said.length);
  }

  // a send that fails is a log line, never an exception out of join()
  {
    const channel = fakeChannel();
    channel.send = async () => { throw new Error('Missing Permissions'); };
    const said = [];
    const out = await wel.join(fakeMember(channel), { log: (m) => said.push(m) });
    if (out.posted) fail('a send that failed did not post');
    if (!said.some((m) => /Missing Permissions/.test(m))) fail('the reason should be in the log: ' + said.join(' | '));
  }

  // switched off entirely
  {
    const was = wel.CONF.enabled;
    wel.CONF.enabled = false;
    const channel = fakeChannel();
    const out = await wel.join(fakeMember(channel), { log: quiet });
    if (out.posted || channel.sent.length) fail('WELCOME_ENABLED=0 should post nothing');
    wel.CONF.enabled = was;
  }

  // ---- and now with the drawing library taken away --------------------------------------------
  {
    const blind = reload({ hide: true });
    if (await blind.card(who()) !== null) fail('with no library, a card should be null rather than a throw');

    const channel = fakeChannel();
    const member = fakeMember(channel);
    member.user.displayAvatarURL = () => 'https://cdn.example/u1.png';
    const out = await blind.join(member, { log: quiet });
    if (!out.posted) fail('a member must still be welcomed with no drawing library: ' + out.why);
    if (out.drew) fail('there was nothing to draw with, so drew should be false');
    if (channel.sent.length !== 1) fail('one message expected, got ' + channel.sent.length);
    const msg = channel.sent[0] || {};
    if (msg.files) fail('there is no picture to attach');
    if (!msg.embeds || msg.embeds.length !== 1) fail('the fallback should be one embed');
    const embed = msg.embeds?.[0]?.data || {};
    if (!/Lovkar/.test(embed.description || '')) fail('the embed should name them: ' + embed.description);
    if (!/member #137/.test(embed.description || '')) fail('the embed should carry the number: ' + embed.description);
    if (embed.thumbnail?.url !== 'https://cdn.example/u1.png') fail('the avatar should be the thumbnail: ' + embed.thumbnail?.url);
    if (msg.content !== '<@u1> just walked in.') fail('the line should still be substituted: ' + msg.content);
  }

  // ---- what the book was told -------------------------------------------------------------------
  {
    const events = db.events(50).filter((e) => e.kind === 'welcome');
    if (!events.length) fail('a welcome should be written down');
    if (events[0].subject !== 'lovkar') fail('the event should name them: ' + events[0].subject);
    if (!/member #137/.test(events[0].detail || '')) fail('the event should carry the number: ' + events[0].detail);
    // three joins actually posted above: the plain one, the rewritten line, and the blind one
    if (db.counters().welcomed !== 3) fail('three welcomes should have been counted, got ' + db.counters().welcomed);
  }

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all welcome cases pass');
  process.exit(bad ? 1 : 0);
})();
