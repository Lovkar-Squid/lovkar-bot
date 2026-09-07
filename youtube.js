/**
 * The YouTube watcher: a new video on the channel becomes a post in Discord, by itself.
 *
 * <p>It reads the channel's Atom feed - {@code youtube.com/feeds/videos.xml?channel_id=UC...} -
 * which is public, needs no API key, has no quota to run out of, and carries a new upload within
 * a few minutes. The alternative was the YouTube Data API, which would have meant another secret
 * in the .env and a daily quota, to learn the same fifteen video IDs.</p>
 *
 * <p><b>Where it remembers what it has already posted:</b> nowhere. The bot has no database and
 * this does not add one. What it does instead is read the last hundred messages of the channel it
 * posts into and collect the video IDs already there - Discord is the record, which is the only
 * record that cannot disagree with what people can actually see. A restart, a redeploy, a fresh
 * container: it reads the channel again and knows exactly as much as before.</p>
 *
 * <p>Two guards against the failure that would matter, which is dumping the back catalogue into
 * #announcements: nothing older than {@code YOUTUBE_MAX_AGE_HOURS} is ever posted, and everything
 * in the feed at startup that is older than that is marked seen before the first poll.</p>
 *
 * <p><b>There are two of those feeds and they do not always agree.</b> The obvious one is keyed by
 * channel - {@code ?channel_id=UC...} - and YouTube builds it when a video is PUBLISHED, so a
 * video that went up unlisted and was made public afterwards never appears in it. This channel is
 * in exactly that state: the trailer is public and that feed lists nothing at all. The uploads
 * PLAYLIST of the same channel - {@code ?playlist_id=UU...}, the channel id with its UC swapped
 * for UU - does list it, with a real publication date. So the playlist feed is read first and the
 * channel feed is the fallback; both are the same Atom document and go through the same parser.</p>
 *
 * <p>Run {@code node youtube.js} on its own to see what it would post and why, without a Discord
 * connection and without writing anything.</p>
 */

'use strict';

const FEED = 'https://www.youtube.com/feeds/videos.xml?';

/** A channel's uploads playlist is its id with UC swapped for UU. This is a YouTube convention. */
function uploadsPlaylist(channelId) {
  return 'UU' + String(channelId).slice(2);
}

// ---- reading the feed (pure, so test.js can check it without a network) ------------------------

/** Unescape the five XML entities a YouTube title can actually contain. */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  return m ? unescapeXml(m[1].trim()) : '';
}

/**
 * The feed's entries, newest first (which is the order YouTube gives them in).
 *
 * <p>Parsed with regular expressions rather than an XML library on purpose: the feed is a fixed
 * shape produced by one publisher, an XML parser is a dependency the bot does not otherwise need,
 * and a malformed feed should give back nothing rather than throw somewhere else.</p>
 */
function parseFeed(xml) {
  const out = [];
  if (typeof xml !== 'string') return out;
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = tag(e, 'yt:videoId');
    if (!id) continue;
    const published = Date.parse(tag(e, 'published')) || 0;
    out.push({
      id,
      title: tag(e, 'title') || 'Untitled',
      author: tag(e, 'name'),
      published,
      updated: Date.parse(tag(e, 'updated')) || published,
      url: 'https://youtu.be/' + id,
    });
  }
  return out;
}

/**
 * The video IDs a piece of Discord text already refers to. Covers every shape a link can take -
 * youtu.be/ID, watch?v=ID, /shorts/ID, /live/ID, /embed/ID - because the point of this is to
 * recognise a post the bot itself made a month ago, or one Marko made by hand.
 */
const ID = '[A-Za-z0-9_-]{11}';
const LINK = new RegExp(
  '(?:youtu\\.be/|youtube\\.com/(?:watch\\?(?:[^\\s]*&)?v=|shorts/|live/|embed/|v/))(' + ID + ')', 'g');

function idsIn(text) {
  const out = new Set();
  if (!text) return out;
  for (const m of String(text).matchAll(LINK)) out.add(m[1]);
  return out;
}

/**
 * Which entries are worth posting: not seen, not older than the cutoff, oldest first.
 *
 * <p>Oldest first matters - if two videos went up while the bot was down, they should appear in
 * the order they were published, not the order the feed lists them in.</p>
 */
function fresh(entries, { seen, maxAgeMs, now = Date.now() }) {
  return entries
    .filter((e) => !seen.has(e.id))
    .filter((e) => e.published > 0 && now - e.published <= maxAgeMs)
    .sort((a, b) => a.published - b.published);
}

/** Fill {title}, {url}, {author} and {mention} into the announcement line. */
function render(template, entry, mention) {
  return template
    .replace(/\\n/g, '\n')
    .replace(/\{title\}/g, entry.title)
    .replace(/\{url\}/g, entry.url)
    .replace(/\{author\}/g, entry.author || '')
    .replace(/\{mention\}/g, mention || '')
    .trim();
}

/** A channel id out of anything he might paste: the id itself, a /channel/ URL, or a page's HTML. */
function channelIdFrom(text) {
  const m = String(text || '').match(/UC[A-Za-z0-9_-]{22}/);
  return m ? m[0] : null;
}

// ---- the running part --------------------------------------------------------------------------

const CONF = {
  channelId: process.env.YOUTUBE_CHANNEL_ID || '',
  channel: process.env.YOUTUBE_CHANNEL || '',                     // a handle or any channel URL
  post: process.env.YOUTUBE_ANNOUNCE_CHANNEL || 'announcements',
  pollMinutes: Number(process.env.YOUTUBE_POLL_MINUTES || 5),
  maxAgeHours: Number(process.env.YOUTUBE_MAX_AGE_HOURS || 24),
  mention: process.env.YOUTUBE_MENTION || '',
  crosspost: process.env.YOUTUBE_CROSSPOST !== '0',
  template: process.env.YOUTUBE_TEMPLATE || '{mention}**New on YouTube: {title}**\\n{url}',
};

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'lovkar-bot (+https://github.com/Lovkar-Squid/lovkar-bot)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Everything the channel has, from whichever feed answers. The uploads playlist is asked first
 * because it is the one that lists a video made public after the fact; the channel feed is asked
 * when the playlist gives nothing, which is what happens if the playlist is ever made private.
 */
async function uploads(id, say) {
  const sources = [
    ['uploads playlist', FEED + 'playlist_id=' + uploadsPlaylist(id)],
    ['channel feed', FEED + 'channel_id=' + id],
  ];
  for (const [source, url] of sources) {
    try {
      const entries = parseFeed(await get(url));
      if (entries.length) return { entries, source };
    } catch (e) {
      say(`[youtube] ${source}: ${e.message}`);
    }
  }
  return { entries: [], source: 'nothing' };
}

/**
 * The channel id, from the setting if it is one, else resolved once from a handle or URL by
 * reading the channel page. Resolving costs one request at startup and means the .env can hold
 * "@LovkarSquid" instead of twenty-four characters of base64 nobody can check by eye.
 */
async function resolveChannelId(log) {
  if (channelIdFrom(CONF.channelId)) return channelIdFrom(CONF.channelId);
  if (!CONF.channel) return null;
  const direct = channelIdFrom(CONF.channel);
  if (direct) return direct;
  const handle = CONF.channel.startsWith('http')
    ? CONF.channel
    : 'https://www.youtube.com/' + (CONF.channel.startsWith('@') ? CONF.channel : '@' + CONF.channel);
  const id = channelIdFrom(await get(handle));
  if (id) log(`[youtube] ${CONF.channel} is ${id}`);
  return id;
}

/** Every video id already posted in the channel - the whole of the bot's memory for this job. */
async function alreadyPosted(channel) {
  const seen = new Set();
  const messages = await channel.messages.fetch({ limit: 100 });
  for (const m of messages.values()) {
    for (const id of idsIn(m.content)) seen.add(id);
    for (const e of m.embeds) {
      for (const id of idsIn(e.url || '')) seen.add(id);
      for (const id of idsIn(e.description || '')) seen.add(id);
    }
  }
  return seen;
}

function findChannel(guild, name) {
  return guild.channels.cache.find(
    (c) => c.name === name && typeof c.send === 'function') || null;
}

/**
 * Start watching. Safe to call when nothing is configured - it says so and does nothing, the way
 * the dashboard does when its own settings are missing.
 */
async function start(client, { log, guildId, onPosted } = {}) {
  const say = log || console.log;
  const id = await resolveChannelId(say).catch((e) => { say(`[youtube] ${e.message}`); return null; });
  if (!id) {
    say('[youtube] no channel configured (set YOUTUBE_CHANNEL_ID or YOUTUBE_CHANNEL) - not watching');
    return null;
  }

  const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
  if (!guild) { say('[youtube] no guild - not watching'); return null; }
  const channel = findChannel(guild, CONF.post);
  if (!channel) { say(`[youtube] no channel #${CONF.post} - not watching`); return null; }

  const maxAgeMs = CONF.maxAgeHours * 3600 * 1000;
  const seen = new Set();

  try {
    for (const vid of await alreadyPosted(channel)) seen.add(vid);
    say(`[youtube] #${CONF.post} already carries ${seen.size} video${seen.size === 1 ? '' : 's'}`);
  } catch (e) {
    // If the history cannot be read, the age cutoff is still holding the line on its own.
    say(`[youtube] could not read #${CONF.post}: ${e.message}`);
  }

  // Everything already too old to post is marked seen now, so the cutoff is never the only thing
  // standing between a redeploy and the back catalogue.
  let first = true;

  async function poll() {
    const { entries, source } = await uploads(id, say);
    if (!entries.length) {
      if (first) say('[youtube] neither feed lists anything yet');
      return;
    }
    if (first) {
      first = false;
      // The snapshot: everything already too old to announce is marked seen now, so the age
      // cutoff is never the only thing standing between a redeploy and the back catalogue.
      for (const e of entries) if (Date.now() - e.published > maxAgeMs) seen.add(e.id);
      say(`[youtube] watching ${entries[0].author || id} by ${source} - ${entries.length} listed, `
        + `newest "${entries[0].title}"`);
    }
    for (const e of fresh(entries, { seen, maxAgeMs })) {
      seen.add(e.id);                                   // before sending: a failure must not loop
      try {
        const msg = await channel.send({
          content: render(CONF.template, e, CONF.mention),
          allowedMentions: CONF.mention ? undefined : { parse: [] },
        });
        say(`[youtube] posted "${e.title}" (${e.id}) in #${channel.name}`);
        if (onPosted) onPosted(e);
        // #announcements is an Announcement channel: publishing is what makes it reach the
        // servers that follow it. It is a no-op anywhere else, and never worth failing over.
        if (CONF.crosspost && msg.crosspostable) {
          await msg.crosspost().then(
            () => say('[youtube] published to followers'),
            (err) => say(`[youtube] could not publish: ${err.message}`));
        }
      } catch (err) {
        say(`[youtube] could not post ${e.id}: ${err.message}`);
      }
    }
  }

  await poll();
  const timer = setInterval(() => poll().catch((e) => say(`[youtube] ${e.message}`)),
    Math.max(1, CONF.pollMinutes) * 60 * 1000);
  timer.unref?.();
  return { poll, stop: () => clearInterval(timer) };
}

module.exports = { start, parseFeed, fresh, idsIn, render, channelIdFrom, uploadsPlaylist, unescapeXml, CONF };

// ---- run it on its own to see what it would do -------------------------------------------------

if (require.main === module) {
  (async () => {
    const id = await resolveChannelId(console.log);
    if (!id) { console.log('set YOUTUBE_CHANNEL_ID or YOUTUBE_CHANNEL first'); process.exit(1); }
    const { entries, source } = await uploads(id, console.log);
    console.log(`${entries.length} listed for ${id}, read by ${source}\n`);
    for (const e of entries) {
      const age = (Date.now() - e.published) / 3600000;
      const would = age <= CONF.maxAgeHours ? 'WOULD POST' : 'too old   ';
      console.log(`${would}  ${age.toFixed(1).padStart(7)}h  ${e.id}  ${e.title}`);
    }
    if (!entries.length) return;
    console.log('\nthe message it would send for the newest:\n---');
    console.log(render(CONF.template, entries[0], CONF.mention));
    console.log('---');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
