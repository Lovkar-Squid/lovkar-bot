/**
 * Packs: a handful of images, posted to the channel they belong in, in one go.
 *
 * <p>Two ways in and one way out. Marko drops files on the dashboard's Packs page; I run
 * {@link ./pack.js} inside the container when I have made something worth showing. Both end up
 * here, so the channel mapping, the batching and the rules about what may be posted are written
 * once.</p>
 *
 * <p>The pictures are not kept. They go from the upload straight to Discord, which holds the only
 * copy that matters; the book ({@link ./db.js}) keeps one line saying a pack went out, so there is
 * an answer to "when did we last post anything" that survives a redeploy.</p>
 */

'use strict';

const db = require('./db');

/** Where each pack goes, and what to say about it if nothing is said. */
const PACKS = {
  sneak: {
    channel: process.env.PACK_SNEAK_CHANNEL || 'sneak-peek',
    label: 'Sneak peek',
    blurb: 'A look at what is coming.',
  },
  bts: {
    channel: process.env.PACK_BTS_CHANNEL || 'behind-the-scenes',
    label: 'Behind the scenes',
    blurb: 'How it was made.',
  },
};

/** Discord takes ten attachments in a message; more than that becomes several messages. */
const PER_MESSAGE = 10;
/** What the free tier accepts per file. A boosted server takes more, but this is the safe line. */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 30;

const IMAGE = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;

function kinds() {
  return Object.keys(PACKS);
}

function about(kind) {
  return PACKS[kind] || null;
}

/**
 * Post one pack.
 *
 * @param guild    the discord.js Guild
 * @param kind     'sneak' or 'bts'
 * @param files    [{ name, data: Buffer }]
 * @param caption  what to say above them; the pack's own blurb if empty
 * @param who      whose name goes in the log
 * @returns {Promise<{channel: string, messages: number, files: number, urls: string[]}>}
 */
async function post(guild, kind, files, caption, who, log = () => {}) {
  const pack = about(kind);
  if (!pack) throw new Error(`no such pack: ${kind}`);
  if (!files.length) throw new Error('no files');
  if (files.length > MAX_FILES) throw new Error(`that is ${files.length} files; ${MAX_FILES} is the most`);

  for (const f of files) {
    if (!IMAGE.test(f.name)) throw new Error(`${f.name} is not an image or a clip`);
    if (f.data.length > MAX_BYTES) {
      throw new Error(`${f.name} is ${(f.data.length / 1048576).toFixed(1)} MB; ${MAX_BYTES / 1048576} MB is the most`);
    }
  }

  const channel = guild.channels.cache.find(
    (c) => c.name === pack.channel && typeof c.send === 'function');
  if (!channel) throw new Error(`there is no #${pack.channel} in this server`);

  const text = (caption || '').trim() || pack.blurb;
  const urls = [];
  let messages = 0;
  for (let i = 0; i < files.length; i += PER_MESSAGE) {
    const slice = files.slice(i, i + PER_MESSAGE);
    const msg = await channel.send({
      // only the first message carries the words; the rest are the rest of the pictures
      content: i === 0 ? text : undefined,
      files: slice.map((f) => ({ attachment: f.data, name: f.name })),
      allowedMentions: { parse: [] },
    });
    urls.push(msg.url);
    messages++;
  }
  log(`[packs] ${who} posted ${files.length} file${files.length === 1 ? '' : 's'} `
    + `to #${channel.name} as ${pack.label.toLowerCase()}`);
  // The pictures themselves are Discord's now; what is kept here is the note that they went out.
  db.pack({
    kind, channel: channel.name, files: files.length, who, caption: text, url: urls[0],
    bytes: files.reduce((n, f) => n + f.data.length, 0),
    names: files.map((f) => f.name),
  });
  db.bump('packsPosted');
  return { channel: channel.name, messages, files: files.length, urls };
}

/**
 * Pull the fields and files out of a multipart/form-data body.
 *
 * <p>Written by hand because the bot has no dependencies beyond discord.js and this is the only
 * place that needs it. It walks the raw buffer rather than turning it into a string first, which
 * matters: a PNG turned into a UTF-8 string and back is no longer a PNG.</p>
 */
function multipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('not a multipart body');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {};
  const files = [];

  let at = buffer.indexOf(boundary);
  while (at >= 0) {
    let start = at + boundary.length;
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;        // the closing --
    start += 2;                                                            // the CRLF after it
    const headEnd = buffer.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = buffer.toString('utf8', start, headEnd);
    const next = buffer.indexOf(boundary, headEnd);
    if (next < 0) break;
    const body = buffer.subarray(headEnd + 4, next - 2);                   // minus the trailing CRLF

    const name = /name="([^"]*)"/i.exec(head);
    const filename = /filename="([^"]*)"/i.exec(head);
    if (filename && filename[1]) {
      files.push({ name: filename[1].replace(/[/\\]/g, '_'), data: Buffer.from(body) });
    } else if (name) {
      fields[name[1]] = body.toString('utf8');
    }
    at = next;
  }
  return { fields, files };
}

module.exports = { PACKS, PER_MESSAGE, MAX_BYTES, MAX_FILES, kinds, about, post, multipart };
