/**
 * The release watcher: a new build on Modrinth or CurseForge becomes a post in #announcements.
 *
 * <p>It is the YouTube watcher's twin and works the same way, for the same reason - poll a public
 * listing, notice what is new, say so once - because the failure that matters is the same one:
 * dumping the back catalogue into a channel people are actually reading. Nothing older than
 * {@code RELEASE_MAX_AGE_HOURS} is ever posted, everything already older than that at the first
 * poll is marked seen before anything is sent, and every id the book already holds is seen before
 * the first request goes out.</p>
 *
 * <p><b>Where it remembers what it has posted:</b> the book ({@link ./db.js}), not Discord. The
 * YouTube watcher can read its own history back out of #announcements because the video id is in
 * the link it posted; a release announcement has no such id in it that Discord could give back.
 * So {@code db.releaseSeen()} is the record here. Without a book the age cutoff is all that is
 * left, which is why the default is measured in days rather than months: a redeploy then repeats
 * at most what is newer than the cutoff, and only once.</p>
 *
 * <p><b>The two listings.</b> Modrinth's API is public, needs no key and asks only that a caller
 * says who it is, so it gets a User-Agent with the repository in it. CurseForge's own API needs a
 * key this bot does not have, so it goes through api.curse.tools - the same open proxy the rest
 * of the project already uses for this. A proxy is somebody else's server and will one day be
 * down: when it is, or when an entry is missing the numeric mod id it needs, that source is one
 * line in the log and Modrinth carries on alone. Neither source may ever stop the other.</p>
 *
 * <p>Ids are written {@code <source>:<id>} so a Modrinth version and a CurseForge file can never
 * be mistaken for one another, whatever either site decides its ids should look like next.</p>
 *
 * <p>Run {@code node releases.js} on its own to see what it would post and why, without a Discord
 * connection and without writing anything down.</p>
 */

'use strict';

const { ChannelType, EmbedBuilder } = require('discord.js');
const db = require('./db');

/**
 * The mark that says this server has been looked at before.
 *
 * <p>Without it, switching the watcher on would announce everything published in the last two
 * days - builds their author already announced by hand. The first listing is noted in silence
 * instead. Clearing this key in the book makes the next start seed itself again.</p>
 */
const SEEDED = 'releases:seeded';
/**
 * The ids that were already out on that first look.
 *
 * <p>Marking them seen only in memory is not enough: the next restart would find them again,
 * and the age cutoff is no help for a build published yesterday. They are not written to the
 * releases table, because that table means "announced" and these never were.</p>
 */
const KNOWN = 'releases:known';

/** Modrinth's version list: public, no key, no quota worth worrying about at one call a quarter-hour. */
const MODRINTH = 'https://api.modrinth.com/v2/project/';
/** CurseForge without a key. Somebody else's server, treated accordingly. */
const CURSE = 'https://api.curse.tools/v1/mods/';
/** Modrinth asks callers to identify themselves, and it is only polite. */
const AGENT = 'lovkar-bot/1.0 (+https://github.com/Lovkar-Squid/lovkar-bot)';

const COLOUR = 0xe2b24a;          // the same gold as the giveaways and the dashboard
const CHANGELOG_MAX = 1000;       // an embed would take 4096; a wall of text nobody reads is not a post
const FIELD_MAX = 1024;           // Discord's own limit on a field value
const TITLE_MAX = 256;            // ...and on a title
const TIMEOUT_MS = 15000;         // every request gets one, so a hung socket cannot hold the poll open

/** A number out of the environment, or the default when somebody has typed "fifteen". */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONF = {
  channel: process.env.RELEASE_CHANNEL || 'announcements',      // a channel name or an id
  modrinth: process.env.RELEASE_MODRINTH || '',                 // slug or slug:projectId, comma-separated
  curseforge: process.env.RELEASE_CURSEFORGE || '',             // slug:modId, comma-separated
  pollMinutes: num(process.env.RELEASE_POLL_MINUTES, 15),
  maxAgeHours: num(process.env.RELEASE_MAX_AGE_HOURS, 48),
  mention: process.env.RELEASE_MENTION || '',                   // @everyone, a role, or nothing at all
  types: process.env.RELEASE_TYPES || 'release,beta',           // alpha is left out on purpose
};

// ---- reading the listings (pure, so test-releases.js can check it without a network) ------------

/** Whatever came back, as a trimmed string, because both APIs will hand back a number one day. */
function str(x) {
  return x == null ? '' : String(x).trim();
}

/** The strings in an array that are actually strings. Anything else in there is not our problem. */
function strings(a) {
  return Array.isArray(a) ? a.map(str).filter(Boolean) : [];
}

/**
 * The loaders either site might name, and how they are spelled in public.
 *
 * <p>Modrinth keeps loaders and Minecraft versions in separate fields; CurseForge puts loaders,
 * Minecraft versions and things like "Client" and "Java 17" in one {@code gameVersions} array. So
 * this doubles as the rule for telling those three apart: anything starting with a digit is a
 * Minecraft version, anything named here is a loader, and the rest is noise that has no business
 * in an announcement.</p>
 */
const LOADERS = new Map([
  ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['fabric', 'Fabric'], ['quilt', 'Quilt'],
  ['rift', 'Rift'], ['liteloader', 'LiteLoader'], ['modloader', 'ModLoader'],
  ['bukkit', 'Bukkit'], ['spigot', 'Spigot'], ['paper', 'Paper'], ['purpur', 'Purpur'],
  ['folia', 'Folia'], ['sponge', 'Sponge'], ['bungeecord', 'BungeeCord'], ['velocity', 'Velocity'],
  ['waterfall', 'Waterfall'], ['datapack', 'Data pack'], ['iris', 'Iris'], ['optifine', 'OptiFine'],
  ['canvas', 'Canvas'], ['vanilla', 'Vanilla'],
]);

function loaderName(text) {
  const key = str(text).toLowerCase();
  return LOADERS.get(key) || (key ? key[0].toUpperCase() + key.slice(1) : '');
}

/** CurseForge's one list, sorted back into the two things it is really holding. */
function sortVersions(all) {
  const versions = [];
  const loaders = [];
  for (const v of all) {
    if (/^\d/.test(v)) versions.push(v);
    else if (LOADERS.has(v.toLowerCase())) loaders.push(loaderName(v));
  }
  return { versions, loaders };
}

/** 1, 2, 3 is what CurseForge calls release, beta and alpha. Modrinth simply says the word. */
const RELEASE_TYPE = { 1: 'release', 2: 'beta', 3: 'alpha' };
const TYPES = new Set(['release', 'beta', 'alpha']);

function typeOf(text) {
  const t = str(text).toLowerCase();
  return TYPES.has(t) ? t : 'release';
}

/**
 * The version number hiding in a file's name.
 *
 * <p>CurseForge has no field for it: a file knows its own id and what it is called, and the
 * version is whatever the author wrote in the middle of that. The display name is looked at first
 * because it is what a human sees on the site, and the file name only when that says nothing -
 * the file name usually leads with the Minecraft version, which is not the answer wanted here.</p>
 */
function versionIn(text) {
  const m = str(text).match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?/);
  return m ? m[0] : '';
}

/**
 * The five entities an HTML changelog actually contains, plus whatever numeric ones an author's
 * editor has left behind. {@code &amp;} is undone last so "&amp;lt;" does not become a tag.
 */
function unescapeHtml(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#(\d{1,6});/g, (whole, n) => {
      const code = Number(n);
      return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/gi, '&');
}

/**
 * A changelog fit for an embed.
 *
 * <p>CurseForge's arrive as HTML and Modrinth's as markdown, so both are flattened to plain text:
 * the tags that mean "new line" become one, every other tag goes, entities are undone, markdown
 * headings lose their hashes (Discord would render them enormous), and runs of whitespace become
 * single spaces. Then it is cut to {@code CHANGELOG_MAX} at a space rather than mid-word, with an
 * ellipsis to say that it was cut - the link in the title is where the whole thing lives.</p>
 */
function changelog(text, max = CHANGELOG_MAX) {
  if (text == null) return '';
  let s = String(text)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')             // never rendered, never wanted
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')                                // the bullet opens the line,
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|blockquote|pre)\s*>/gi, '\n')  // so </li> must not end it
    .replace(/<[^>]*>/g, '');                                      // and every other tag
  s = unescapeHtml(s)
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')                          // markdown headings
    .replace(/[^\S\n]+/g, ' ')                                     // runs of spaces and tabs
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length <= max) return s;

  const room = max - 1;                                            // the ellipsis has to fit as well
  const cut = s.slice(0, room);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return (at > room / 2 ? cut.slice(0, at) : cut).trimEnd() + '…';
}

/**
 * Modrinth's version list, in the order it gave them.
 *
 * <p>The slug is passed in rather than read out of the payload because a version does not carry
 * one - it knows its project's id, and {@code modrinth.com/mod/<id>} resolves to the same page,
 * so a missing slug costs a less pretty link and nothing else.</p>
 */
function parseModrinth(json, slug) {
  const out = [];
  if (!Array.isArray(json)) return out;
  for (const v of json) {
    if (!v || typeof v !== 'object') continue;
    const id = str(v.id);
    if (!id) continue;
    const project = str(slug) || str(v.project_id);
    const version = str(v.version_number);
    out.push({
      id: 'modrinth:' + id,
      source: 'modrinth',
      project,
      name: str(v.name) || version || project,
      version,
      url: project
        ? `https://modrinth.com/mod/${project}`
          + (version ? `/version/${encodeURIComponent(version)}` : '')
        : '',
      published: Date.parse(v.date_published) || 0,
      type: typeOf(v.version_type),
      gameVersions: strings(v.game_versions),
      loaders: strings(v.loaders).map(loaderName),
      changelog: changelog(v.changelog),
    });
  }
  return out;
}

/**
 * The proxy's file list, in the same shape.
 *
 * <p>It answers {@code {data: [...]}}; a bare array is accepted too, in case the proxy is ever
 * swapped for something that hands the list back directly.</p>
 */
function parseCurseForge(json, slug, section) {
  const out = [];
  // a modpack's files live under a different path than a mod's; see list()
  const where = /^[a-z0-9-]+$/.test(String(section || '')) ? section : 'mc-mods';
  const rows = Array.isArray(json) ? json
    : (json && typeof json === 'object' && Array.isArray(json.data) ? json.data : []);
  for (const f of rows) {
    if (!f || typeof f !== 'object') continue;
    const id = str(f.id);
    if (!id) continue;
    const project = str(slug);
    const display = str(f.displayName);
    const file = str(f.fileName);
    const { versions, loaders } = sortVersions(strings(f.gameVersions));
    out.push({
      id: 'curseforge:' + id,
      source: 'curseforge',
      project,
      name: display || file || project,
      version: versionIn(display) || versionIn(file.replace(/\.(jar|zip|litemod)$/i, '')),
      url: project
        ? `https://www.curseforge.com/minecraft/${where}/${project}/files/${encodeURIComponent(id)}`
        : '',
      published: Date.parse(f.fileDate) || 0,
      type: RELEASE_TYPE[Number(f.releaseType)] || 'release',
      gameVersions: versions,
      loaders,
      changelog: changelog(f.changelog),
    });
  }
  return out;
}

/** "release,beta", ["release"], a Set, or nothing at all, which means every kind of build. */
function typeSet(types) {
  if (types == null) return null;
  const named = types instanceof Set ? [...types]
    : (Array.isArray(types) ? types : String(types).split(','));
  const out = new Set(named.map((t) => str(t).toLowerCase()).filter(Boolean));
  if (!out.size || out.has('all') || out.has('any')) return null;
  return out;
}

/**
 * Which releases are worth posting: not seen, of a kind that may be announced, not older than the
 * cutoff, oldest first.
 *
 * <p>Oldest first matters - if a beta and then a release went out while the bot was down, they
 * should appear in that order, not in whichever order the two sites happened to list them.</p>
 */
function fresh(entries, { seen = new Set(), maxAgeMs, types, now = Date.now() } = {}) {
  const want = typeSet(types);
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => !seen.has(e.id))
    .filter((e) => !want || want.has(e.type))
    .filter((e) => e.published > 0 && now - e.published <= maxAgeMs)
    .sort((a, b) => a.published - b.published);
}

// ---- what it looks like in the channel ----------------------------------------------------------

const WHERE = { modrinth: 'Modrinth', curseforge: 'CurseForge' };

/** Long enough is long enough, and Discord will refuse the message rather than trim it for us. */
function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * "{name} {version}" - unless the name already ends in the version, which on Modrinth it usually
 * does, and "Waking World 0.2.1 0.2.1" helps nobody.
 */
function title(e) {
  const name = str(e.name) || str(e.project) || 'New release';
  const version = str(e.version);
  return clip(!version || name.includes(version) ? name : `${name} ${version}`, TITLE_MAX);
}

/** The one line people actually check: what it runs on. */
function worksWith(e) {
  const bits = [];
  if (e.gameVersions && e.gameVersions.length) bits.push(`**Minecraft** ${e.gameVersions.join(', ')}`);
  if (e.loaders && e.loaders.length) bits.push(`**Loaders** ${e.loaders.join(', ')}`);
  return bits.join('   ·   ');
}

function card(e) {
  const embed = new EmbedBuilder().setTitle(title(e)).setColor(COLOUR);
  if (e.url) embed.setURL(e.url);
  const notes = changelog(e.changelog);
  if (notes) embed.setDescription(notes);
  const works = worksWith(e);
  if (works) embed.addFields({ name: 'Works with', value: clip(works, FIELD_MAX) });
  embed.setFooter({
    text: (WHERE[e.source] || e.source) + (e.type && e.type !== 'release' ? `  ·  ${e.type}` : ''),
  });
  if (e.published) embed.setTimestamp(e.published);
  return embed;
}

/** The whole message. The mention only pings when one was configured; otherwise nothing is parsed. */
function message(e) {
  return {
    content: CONF.mention || undefined,
    embeds: [card(e)],
    allowedMentions: CONF.mention ? undefined : { parse: [] },
  };
}

// ---- the running part ----------------------------------------------------------------------------

/**
 * "slug", "slug:id", "slug:id:section", and any amount of space around any of it. Blanks ignored.
 *
 * <p>The third field only matters on CurseForge, whose file links live under a different path for
 * a modpack than for a mod: {@code /minecraft/modpacks/…} rather than {@code /minecraft/mc-mods/…}.
 * A pack configured without it would be announced with a link that 404s.</p>
 */
function list(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [slug, id, section] = entry.split(':').map((p) => p.trim());
      return { slug: slug || '', id: id || '', section: section || '' };
    });
}

/**
 * What is configured, in the order it will be polled.
 *
 * <p>Modrinth takes a slug or a project id in the same place, so the slug alone is enough there
 * and an id is only worth setting for a project that has been renamed. The CurseForge proxy takes
 * the numeric mod id and nothing else, while the link needs the slug, so an entry without both
 * halves cannot be polled at all and is left out here rather than failing every quarter of an
 * hour later.</p>
 */
function sources() {
  const out = [];
  for (const { slug, id } of list(CONF.modrinth)) {
    if (slug) out.push({ source: 'modrinth', slug, id: id || slug });
  }
  for (const { slug, id, section } of list(CONF.curseforge)) {
    if (slug && /^\d+$/.test(id)) {
      out.push({ source: 'curseforge', slug, id, section: section || 'mc-mods' });
    }
  }
  return out;
}

function describe(where) {
  const all = where || sources();
  if (!all.length) return 'nothing';
  return all.map((s) => `${s.slug} on ${WHERE[s.source] || s.source}`).join(', ');
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// One complaint per source while it is down, and the slate is wiped when it answers again: a proxy
// having a bad week must not fill the log, and a second outage next month is still worth a line.
const moaned = new Set();

/**
 * Every version either site is listing, whichever of them answered.
 *
 * <p>A source that is down, slow, or handing back something that is not a list is one line in the
 * log; whatever the others said is still posted. This is the whole reason the CurseForge proxy is
 * allowed to be somebody else's server.</p>
 */
async function look(say = () => {}) {
  const out = [];
  for (const s of sources()) {
    const key = `${s.source}:${s.slug}`;
    try {
      const url = s.source === 'modrinth'
        ? `${MODRINTH}${encodeURIComponent(s.id)}/version`
        : `${CURSE}${encodeURIComponent(s.id)}/files?pageSize=20`;
      const json = await get(url);
      const got = s.source === 'modrinth'
        ? parseModrinth(json, s.slug)
        : parseCurseForge(json, s.slug, s.section);
      out.push(...got);
      moaned.delete(key);
    } catch (e) {
      if (!moaned.has(key)) {
        moaned.add(key);
        say(`[releases] ${WHERE[s.source] || s.source} ${s.slug}: ${e.message}`
          + ' - carrying on without it');
      }
    }
  }
  return out;
}

function findChannel(guild, name) {
  if (!name) return null;
  const want = String(name).replace(/^#/, '').toLowerCase();
  return guild.channels.cache.find(
    (c) => (c.id === want || c.name.toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

/**
 * Start watching. Safe to call when nothing is configured - it says so and does nothing, which is
 * what a server that publishes no mods should get.
 */
async function start(client, { log, guildId, onPosted } = {}) {
  const say = log || console.log;

  const where = sources();
  if (!where.length) {
    say('[releases] nothing to watch (set RELEASE_MODRINTH or RELEASE_CURSEFORGE) - not watching');
    return null;
  }
  const short = list(CONF.curseforge).length - where.filter((s) => s.source === 'curseforge').length;
  if (short) {
    say(`[releases] ${short} CurseForge entr${short === 1 ? 'y' : 'ies'} ignored: RELEASE_CURSEFORGE`
      + ' wants slug:modId, and the mod id is the number on the project page');
  }

  const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
  if (!guild) { say('[releases] no guild - not watching'); return null; }
  const channel = findChannel(guild, CONF.channel);
  if (!channel) { say(`[releases] no channel #${CONF.channel} - not watching`); return null; }

  const maxAgeMs = CONF.maxAgeHours * 3600 * 1000;
  const types = typeSet(CONF.types);
  const seen = new Set();

  // What went out before. There is nothing in a release announcement that Discord could give back
  // as an id, so unlike the YouTube watcher the book is the record and not merely a shortcut.
  for (const id of db.releaseSeen()) seen.add(id);
  // ...and what was already out when the watcher was first switched on, which was never announced
  // and must never be. A build published yesterday is inside the age cutoff, so the cutoff alone
  // would let it through on the next restart.
  try {
    for (const id of JSON.parse(db.get(KNOWN) || '[]')) seen.add(id);
  } catch { /* a mangled list is no reason not to run */ }

  say(`[releases] watching ${describe(where)} in #${channel.name}, every ${CONF.pollMinutes}m`
    + `, ${types ? [...types].join('/') : 'every kind of build'} announced`
    + `${seen.size ? `, ${seen.size} already in the book` : ''}`);

  let first = true;

  async function poll() {
    const entries = await look(say);
    if (!entries.length) {
      if (first) say('[releases] neither listing has anything yet');
      return;
    }
    if (first) {
      first = false;
      // The very first look at a server is not news. Everything already published was published
      // by a person who announced it themselves; announcing it again the day the watcher is
      // switched on would post the last week of builds at once and, in an announcement channel,
      // push all of it out to every server that follows. So the first listing is written down in
      // silence and only what appears afterwards is ever announced.
      if (!db.get(SEEDED)) {
        for (const e of entries) seen.add(e.id);
        db.set(SEEDED, new Date().toISOString());
        db.set(KNOWN, JSON.stringify([...seen]));
        say(`[releases] first look: ${entries.length} build${entries.length === 1 ? '' : 's'} `
          + 'already out, all noted without a word - only what appears from now on is announced');
        return;
      }
      // Afterwards: everything already too old to announce is marked seen, so the age cutoff is
      // never the only thing standing between a redeploy and the back catalogue.
      for (const e of entries) if (!e.published || Date.now() - e.published > maxAgeMs) seen.add(e.id);
      const known = entries.filter((e) => seen.has(e.id)).length;
      const newest = entries.reduce((a, b) => (b.published > a.published ? b : a));
      say(`[releases] ${entries.length} build${entries.length === 1 ? '' : 's'} listed`
        + `, ${known} of them already known, newest "${title(newest)}"`);
    }
    for (const e of fresh(entries, { seen, maxAgeMs, types })) {
      seen.add(e.id);                                   // before sending: a failure must not loop
      try {
        const msg = await channel.send(message(e));
        say(`[releases] posted ${title(e)} (${e.id}) in #${channel.name}`);
        db.releasePosted({
          id: e.id, source: e.source, project: e.project, name: e.name,
          version: e.version, url: e.url, published: e.published,
        });
        db.bump('releasesPosted');
        db.event('release', e.name, e.version);
        if (onPosted) onPosted(e, msg);
        // #announcements is an Announcement channel: publishing is what makes it reach the servers
        // that follow it. It is a no-op anywhere else, and never worth failing over.
        if (msg.crosspostable) {
          await msg.crosspost().then(
            () => say('[releases] published to followers'),
            (err) => say(`[releases] could not publish: ${err.message}`));
        }
      } catch (err) {
        say(`[releases] could not post ${e.id}: ${err.message}`);
      }
    }
  }

  await poll();
  const timer = setInterval(() => poll().catch((e) => say(`[releases] ${e.message}`)),
    Math.max(1, CONF.pollMinutes) * 60 * 1000);
  timer.unref?.();
  return { poll, stop: () => clearInterval(timer) };
}

module.exports = { start, CONF, parseModrinth, parseCurseForge, fresh, changelog, sources, SEEDED, KNOWN };

// ---- run it on its own to see what it would do ---------------------------------------------------

if (require.main === module) {
  (async () => {
    const where = sources();
    if (!where.length) {
      console.log('set RELEASE_MODRINTH (slug or slug:projectId) or RELEASE_CURSEFORGE (slug:modId) first');
      process.exit(1);
    }
    console.log(`${describe(where)}, ${CONF.types} announced, nothing older than ${CONF.maxAgeHours}h\n`);
    const short = list(CONF.curseforge).length - where.filter((s) => s.source === 'curseforge').length;
    if (short) console.log(`(${short} CurseForge entry/entries ignored: RELEASE_CURSEFORGE wants slug:modId)\n`);

    const entries = await look(console.log);
    const types = typeSet(CONF.types);
    const maxAgeMs = CONF.maxAgeHours * 3600 * 1000;
    const posting = fresh(entries, { seen: new Set(), maxAgeMs, types });
    const would = new Set(posting.map((e) => e.id));

    for (const e of [...entries].sort((a, b) => b.published - a.published)) {
      const age = (Date.now() - e.published) / 3600000;
      const verdict = would.has(e.id) ? 'WOULD POST'
        : (types && !types.has(e.type) ? `${e.type} skipped` : 'too old');
      console.log(`${verdict.padEnd(14)}${age.toFixed(1).padStart(8)}h  ${e.id.padEnd(24)}  ${title(e)}`);
    }
    if (!entries.length) return;

    // The newest one it would actually announce, rather than the newest one listed - showing the
    // alpha it is about to skip would be a strange thing to print. Built through the same builder
    // the channel would be handed, so a message Discord would refuse is refused here instead.
    const newest = posting.length
      ? posting[posting.length - 1]
      : [...entries].sort((a, b) => b.published - a.published)[0];
    const { content, embeds } = message(newest);
    const embed = embeds[0].toJSON();
    console.log(`\nthe message it would send for ${posting.length ? 'the newest' : 'the newest listed'}:\n---`);
    if (content) console.log(content);
    console.log(embed.title + (embed.url ? `\n${embed.url}` : ''));
    for (const f of embed.fields || []) console.log(`${f.name}: ${f.value.replace(/\*\*/g, '')}`);
    if (embed.description) console.log('\n' + embed.description);
    console.log('---');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
