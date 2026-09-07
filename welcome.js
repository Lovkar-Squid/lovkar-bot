/**
 * Welcome cards: a picture with the new member's name written across it.
 *
 * <p>A join is the one moment the bot has somebody's full attention, and "@somebody just walked in"
 * spends it on nothing. This draws a card instead - the mod's own background, the member's avatar,
 * their name large enough to read from the channel list - and posts that in #welcome. It is the
 * same information; it just looks like somebody meant it.</p>
 *
 * <p>The drawing is done by <code>@napi-rs/canvas</code>, which is an <em>optional</em> dependency
 * and is treated like one throughout. The require is wrapped, every step of the card is wrapped,
 * and each failure has somewhere sensible to fall to: no library or a card that will not draw ends
 * up as an embed with the avatar as its thumbnail, a background that is missing or is not really a
 * JPEG becomes a flat dark fill, an avatar that will not download becomes a circle with their
 * initial in it. Nothing here is allowed to be the reason a member is not welcomed.</p>
 *
 * <p>Fonts are the other thing that cannot be assumed. The card asks for the generic
 * <code>sans-serif</code> family and lets skia resolve it to whatever the image happens to have,
 * and every piece of text is laid out from {@link CanvasRenderingContext2D#measureText} rather than
 * from a guess about how wide a letter is. That is what {@link fit} is for: the name starts large
 * and steps down until it fits beside the avatar, so a thirty-character display name comes out
 * small rather than off the edge. Point WELCOME_FONT at a .ttf and that is used instead, but the
 * card is drawn to look right without one. What it cannot survive is an image with no fonts in it
 * at all - the library ships none of its own - so that case is noticed and refused rather than
 * posted as a picture with no words on it.</p>
 *
 * <p>{@link card} is handed a plain object rather than a discord.js member on purpose. It means the
 * drawing can be tested without Discord anywhere near it, and it keeps {@link join} down to what it
 * really is: find the channel, draw, send, write it in the book.</p>
 */

'use strict';

const fs = require('fs');
const { EmbedBuilder, ChannelType } = require('discord.js');
const db = require('./db');

/**
 * The drawing library, or null.
 *
 * <p>It is an optional dependency, which means npm is allowed to fail to install it - no prebuilt
 * binary for the architecture, a network that was down at build time - and the image still comes
 * up. So this must be a require that can fail, and everything below must cope with skia being
 * null. The reason is kept for the one log line that explains the plain messages.</p>
 */
let skia = null;
let noSkia = '';
try {
  skia = require('@napi-rs/canvas');
} catch (e) {
  noSkia = e.message;
}

const CONF = {
  channel: process.env.WELCOME_CHANNEL || 'welcome',              // a channel name or an id
  background: process.env.WELCOME_BACKGROUND || '/data/welcome-bg.jpg',
  text: process.env.WELCOME_TEXT || '<@id> just walked in.',
  font: process.env.WELCOME_FONT || '',                           // a .ttf, or nothing
  enabled: (process.env.WELCOME_ENABLED || '1') !== '0',
};

const WIDTH = 1000;
const HEIGHT = 360;
const PAD = 40;

const GOLD = '#e2b24a';           // the same gold as the giveaways and the dashboard
const NAME = '#ece6de';
const DIM = '#a8a096';
const FLAT = '#12121a';           // what the card is when there is no background to put on it

/** The avatar circle, on the left, vertically centred. */
const AVATAR_R = 96;
const AVATAR_X = PAD + AVATAR_R;
const AVATAR_Y = HEIGHT / 2;
/** Everything else lives to the right of it, in this much room. */
const TEXT_X = PAD + AVATAR_R * 2 + 40;
const TEXT_W = WIDTH - TEXT_X - PAD;
/** Three baselines, measured so the block sits on the middle of the card. */
const Y_WORD = 120;
const Y_NAME = 210;
const Y_SUB = 258;

const WORD_SIZE = 26;
const WORD_TRACK = 6;             // letter spacing, drawn by hand rather than trusted to the library
const NAME_SIZE = 76;             // where the name starts before it is shrunk to fit
const NAME_FLOOR = 26;            // and the smallest it is ever allowed to become
const SUB_SIZE = 22;

/** Long enough for a CDN that is having a bad afternoon, short enough not to hold up a join. */
const FETCH_MS = 5000;

// ---- the pure half, so the test can check it without Discord or a network -----------------------

/**
 * The largest font size at which the text fits, stepping down from the size asked for.
 *
 * <p>Measured rather than estimated: the same string is a different width in every font, and this
 * bot does not know which font it will be given. Two things make it safe on a runtime with no fonts
 * installed at all. A measurement that comes back as nothing, or as NaN, counts as "it fits", so
 * the card is drawn at full size rather than shrunk to nothing on the strength of a number that
 * means nothing. And the floor is a floor: an absurd name comes out small and clipped rather than
 * looping down to an unreadable size, because at some point the honest answer is that it will not
 * fit and something has to be given up.</p>
 *
 * <p>The font is set on the context as it goes, so a caller that wants to draw straight afterwards
 * finds it already in place - though {@link card} sets it again anyway, to say so out loud.</p>
 *
 * @param ctx       anything with a settable `font` and a `measureText`
 * @param text      the string that has to fit
 * @param maxWidth  how much room there is
 * @param startSize the size to try first
 * @param family    the font family to ask for
 * @returns the size to draw at, never below the floor
 */
function fit(ctx, text, maxWidth, startSize, family = 'sans-serif') {
  const wanted = Math.round(Number(startSize)) || NAME_FLOOR;
  let size = Math.max(NAME_FLOOR, wanted);
  const s = String(text ?? '');
  if (!s) return size;
  while (size > NAME_FLOOR) {
    ctx.font = `bold ${size}px ${family}`;
    const w = ctx.measureText(s).width;
    if (!(w > maxWidth)) break;                 // includes NaN and 0 - a runtime with no fonts
    size -= 2;
  }
  return size;
}

/**
 * The line of text above the picture, with its token filled in.
 *
 * <p>One token, <code>&lt;@id&gt;</code>, which becomes the member's mention. It is done here as a
 * plain replace so that a mod can rewrite WELCOME_TEXT without touching the bot and so that this
 * file can be tested on the wording alone. A template with no token in it is left exactly as it is,
 * which is how somebody turns the ping off.</p>
 */
function render(template, member) {
  const id = member?.id || member?.user?.id || '';
  return String(template ?? '')
    .replace(/\\n/g, '\n')
    .replace(/<@id>/g, id ? `<@${id}>` : '')
    .trim();
}

/**
 * What a discord.js member looks like to the drawing half.
 *
 * <p>The initial is taken by code point rather than by character, because the first "letter" of a
 * name is often an emoji and half a surrogate pair draws as a box.</p>
 */
function about(member) {
  const name = member?.displayName || member?.user?.displayName
    || member?.user?.globalName || member?.user?.username || 'someone';
  return {
    name,
    avatarUrl: member?.user?.displayAvatarURL?.({ extension: 'png', size: 256 }) || '',
    memberNumber: Number(member?.guild?.memberCount) || 0,
    guildName: member?.guild?.name || '',
    initial: ([...String(name)][0] || '?').toUpperCase(),
  };
}

/** How an image of this shape has to be scaled and shifted to cover the whole card. */
function cover(iw, ih, w, h) {
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

/** As much of the text as fits, with an ellipsis where the rest was. */
function ellipsis(ctx, text, maxWidth) {
  const s = String(text ?? '');
  if (!s || !(ctx.measureText(s).width > maxWidth)) return s;
  let cut = [...s];
  while (cut.length > 1 && ctx.measureText(cut.join('') + '…').width > maxWidth) cut.pop();
  return cut.join('') + '…';
}

/** Letter-spaced text, one glyph at a time, because tracking is not something to assume. */
function tracked(ctx, text, x, y, spacing) {
  let at = x;
  for (const ch of String(text ?? '')) {
    ctx.fillText(ch, at, y);
    at += ctx.measureText(ch).width + spacing;
  }
}

// ---- the drawing --------------------------------------------------------------------------------

/**
 * The font family the card asks for, or null when there is nothing to write with.
 *
 * <p>Worked out once, on the first card. A registered file wins; otherwise it is the generic
 * family, and skia is left to find whatever the image happens to have. Registering is wrapped
 * because a font file that is corrupt, or is not really a font, must cost a log line and nothing
 * more.</p>
 *
 * <p>Then it measures a word, which looks paranoid and is not. The library ships no fonts of its
 * own and a slim base image can genuinely have none installed, in which case every string measures
 * as nothing and the card comes out as a background and an avatar with no words on it at all. That
 * is worse than not drawing one: the embed at least says who has arrived. So a zero measurement is
 * taken as "there is no font here", the card is refused, and the log says what to install.</p>
 */
let family = null;
let noFont = false;
/**
 * Whether the absence of a drawing library has been mentioned yet. It is a permanent state, not an
 * event, so it is worth one line rather than one line per person who joins for the rest of the year.
 */
let saidNoSkia = false;

function fontFamily(log = () => {}) {
  if (family !== null) return noFont ? null : family;
  family = 'sans-serif';
  const path = String(CONF.font || '').trim();
  // .otf as well as .ttf: registerFromPath takes both, and refusing one of them would only be a
  // surprise to whoever pointed the setting at the font they actually had.
  if (path && /\.(ttf|otf)$/i.test(path) && skia?.GlobalFonts?.registerFromPath) {
    try {
      if (!fs.existsSync(path)) {
        log(`[welcome] no font file at ${path} - using the generic family`);
      } else {
        skia.GlobalFonts.registerFromPath(path, 'Welcome');
        family = 'Welcome';
        log(`[welcome] drawing with ${path}`);
      }
    } catch (e) {
      log(`[welcome] could not read the font at ${path}: ${e.message}`);
    }
  }
  try {
    const probe = skia.createCanvas(8, 8).getContext('2d');
    probe.font = `bold 40px ${family}`;
    noFont = !(probe.measureText('Welcome').width > 0);
  } catch {
    noFont = true;
  }
  if (noFont) {
    log('[welcome] no font this runtime can draw with, so no cards - install one in the image'
      + ' (apk add font-noto) or point WELCOME_FONT at a .ttf');
  }
  return noFont ? null : family;
}

/**
 * The background, scaled to cover and centred, or a flat fill when there is none.
 *
 * <p>The file is read here and the bytes handed to the decoder, rather than giving the decoder the
 * path. It costs nothing and it means WELCOME_BACKGROUND can only ever be a file: a setting that
 * had drifted into being a URL would otherwise quietly turn every join into an HTTP request.</p>
 */
async function backdrop(ctx, log) {
  ctx.fillStyle = FLAT;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const path = String(CONF.background || '').trim();
  if (!path) return false;
  try {
    const img = await skia.loadImage(fs.readFileSync(path));
    const at = cover(img.width, img.height, WIDTH, HEIGHT);
    ctx.drawImage(img, at.x, at.y, at.w, at.h);
    return true;
  } catch (e) {
    // Once per card and no louder: a server with no background image is a normal state to be in,
    // not a fault, and the card behind the text is meant to be dark anyway.
    log(`[welcome] no background from ${path} (${e.message}) - drawing on the flat colour`);
    return false;
  }
}

/** The gradient that keeps the text readable whatever the picture underneath is doing. */
function scrim(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  g.addColorStop(0, 'rgba(8,8,12,0.35)');
  g.addColorStop(1, 'rgba(8,8,12,0.85)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 2;
  ctx.strokeRect(9, 9, WIDTH - 18, HEIGHT - 18);
}

/** The avatar, downloaded and decoded, or null if either of those did not happen. */
async function face(url, log) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await skia.loadImage(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    log(`[welcome] could not fetch the avatar: ${e.message}`);
    return null;
  }
}

/** The circle on the left: their picture, or their initial when there was no picture to be had. */
function drawFace(ctx, img, initial, fam) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, AVATAR_X - AVATAR_R, AVATAR_Y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
  } else {
    ctx.fillStyle = '#26262f';
    ctx.fillRect(AVATAR_X - AVATAR_R, AVATAR_Y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
    ctx.fillStyle = NAME;
    ctx.font = `bold ${Math.round(AVATAR_R)}px ${fam}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(initial || '?'), AVATAR_X, AVATAR_Y + 2);
  }
  ctx.restore();                        // which puts the clip, the alignment and the colours back
  ctx.beginPath();
  ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R + 1.5, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = GOLD;
  ctx.stroke();
}

/**
 * Draw the card.
 *
 * @param who { name, avatarUrl, memberNumber, guildName, initial } - a plain object, never a member
 * @returns a PNG Buffer, or null when there is no library to draw with and no font to write with
 */
async function card(who = {}, { log = () => {} } = {}) {
  if (!skia) return null;
  const fam = fontFamily(log);
  if (!fam) return null;
  const canvas = skia.createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  await backdrop(ctx, log);
  scrim(ctx);
  drawFace(ctx, await face(who.avatarUrl, log), who.initial, fam);

  // Everything from here is clipped to the space beside the avatar. fit() is what keeps the name
  // inside it; this is the belt to that pair of braces, so nothing can ever cross the picture.
  ctx.save();
  ctx.beginPath();
  ctx.rect(TEXT_X, 0, TEXT_W, HEIGHT);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // A soft shadow under the words as well as the scrim over the picture: the top of the card is
  // the lightest part of the gradient, and that is exactly where the small gold word sits.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;

  ctx.fillStyle = GOLD;
  ctx.font = `${WORD_SIZE}px ${fam}`;
  tracked(ctx, 'WELCOME', TEXT_X, Y_WORD, WORD_TRACK);

  const name = String(who.name ?? '').trim() || 'someone';
  const size = fit(ctx, name, TEXT_W, NAME_SIZE, fam);
  ctx.font = `bold ${size}px ${fam}`;
  ctx.fillStyle = NAME;
  // Shrinking stops at the floor, and a name long enough to still not fit there would otherwise be
  // cut off mid-letter by the clip. Discord caps a display name at 32 characters and the floor is
  // comfortably wide enough for those, so this only ever fires on something strange - but when it
  // does, an ellipsis says "there is more of this" and a severed glyph says "the bot is broken".
  ctx.fillText(ellipsis(ctx, name, TEXT_W), TEXT_X, Y_NAME);

  ctx.font = `${SUB_SIZE}px ${fam}`;
  ctx.fillStyle = DIM;
  const sub = `member #${Number(who.memberNumber) || 0}`
    + (who.guildName ? ` · ${who.guildName}` : '');
  ctx.fillText(ellipsis(ctx, sub, TEXT_W), TEXT_X, Y_SUB);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

// ---- the posting ---------------------------------------------------------------------------------

function findChannel(guild, name) {
  const want = String(name || '').replace(/^#/, '').toLowerCase();
  if (!want || !guild) return null;
  return guild.channels.cache.find(
    (c) => (c.id === want || String(c.name || '').toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

/** What goes out when there is no picture: the same three facts, in an embed. */
function plain(who) {
  const e = new EmbedBuilder()
    .setColor(0xe2b24a)
    .setDescription(`**Welcome, ${who.name}.**\nmember #${who.memberNumber}`
      + (who.guildName ? ` · ${who.guildName}` : ''));
  if (who.avatarUrl) e.setThumbnail(who.avatarUrl);
  return e;
}

/**
 * Somebody joined: draw them a card and post it in #welcome.
 *
 * <p>The three failures are handled separately because they deserve different answers. No channel
 * is a configuration the mod chose and is worth exactly one line in the log. A card that will not
 * draw still leaves somebody standing in the doorway, so the embed goes out instead. A send that
 * fails is Discord's business - a missing permission, a rate limit - and there is nothing useful
 * to do about it here beyond saying so.</p>
 *
 * @returns { posted, drew, why } - drew says whether it was the picture or the embed
 */
async function join(member, { log = console.log } = {}) {
  if (!CONF.enabled) return { posted: false, drew: false, why: 'off' };
  const guild = member?.guild;
  const channel = findChannel(guild, CONF.channel);
  if (!channel) {
    log(`[welcome] no #${CONF.channel} in ${guild?.name || 'this server'} - nobody is being welcomed`);
    return { posted: false, drew: false, why: `no #${CONF.channel}` };
  }

  const who = about(member);
  const content = render(CONF.text, member);

  let png = null;
  try {
    png = await card(who, { log });
  } catch (e) {
    log(`[welcome] could not draw a card for ${who.name}: ${e.message}`);
  }
  if (!png && !skia && !saidNoSkia) {
    saidNoSkia = true;
    log(`[welcome] no drawing library (${noSkia}) - welcoming people with an embed instead`);
  }

  try {
    await channel.send({
      content: content || undefined,
      files: png ? [{ attachment: png, name: 'welcome.png' }] : undefined,
      embeds: png ? undefined : [plain(who)],
      // Only the new member is ever pinged, whatever somebody has put in WELCOME_TEXT.
      allowedMentions: { users: member?.id ? [member.id] : [] },
    });
  } catch (e) {
    log(`[welcome] could not post in #${channel.name}: ${e.message}`);
    return { posted: false, drew: Boolean(png), why: e.message };
  }

  db.event('welcome', member?.user?.tag || who.name, `member #${who.memberNumber}`);
  db.bump('welcomed');
  log(`[welcome] ${member?.user?.tag || who.name} welcomed in #${channel.name}`
    + ` as member #${who.memberNumber}${png ? '' : ' (no picture)'}`);
  return { posted: true, drew: Boolean(png), why: '' };
}

module.exports = { join, card, fit, render, CONF };
