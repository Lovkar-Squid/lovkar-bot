/**
 * Lovkar's Discord bot. Two small jobs, both of them things Discord itself cannot do:
 *
 *   1. Everyone who joins gets the member role (Discord only auto-assigns roles through
 *      Onboarding, which rearranges the whole first impression of the server).
 *   2. Every new post in the bug forum gets a severity tag, a project tag, and - if it has no
 *      log - a nudge to attach one.
 *   3. Server boosters can see the channels boosting is supposed to unlock. Discord does not
 *      create the "Server Booster" role until somebody actually boosts, so the permission cannot
 *      be set in advance by hand - the bot watches for the role and grants it the moment it
 *      exists, and every time it starts.
 *   4. The first two hundred people through the door keep an OG badge. The role is its own tally,
 *      so there is still nothing to store.
 *   5. A new video on the YouTube channel is announced in #announcements. What it has already
 *      posted is read back out of that channel, so this adds no storage either.
 *
 * It reads. It tags. It never deletes anything, never kicks anyone, and never touches a post
 * a human has already tagged by hand.
 *
 * <p>There is also a dashboard ({@link ./web.js}) - the same process, answering from this same
 * gateway connection, so the bot still keeps no database.</p>
 */

'use strict';

const { Client, GatewayIntentBits, Partials, ChannelType, Events, PermissionsBitField } = require('discord.js');
const triage = require('./triage');
const llm = require('./llm');
const web = require('./web');
const youtube = require('./youtube');
const db = require('./db');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const MEMBER_ROLE = process.env.MEMBER_ROLE_NAME || 'Dreamer';
const BUG_FORUM = process.env.BUG_FORUM_NAME || 'bug-reports';
const BACKFILL = process.env.BACKFILL_MEMBER_ROLE === '1';
const REPLY = process.env.TRIAGE_REPLY !== '0';
const DRY = process.env.DRY_RUN === '1';

if (!TOKEN) { console.error('DISCORD_TOKEN is not set - nothing to do.'); process.exit(1); }

// The three severity tags, created on the forum if they are not there yet. Emoji are unicode so
// they work without any server emoji being uploaded.
const SEVERITY_TAGS = [
  { key: 'critical', name: 'Critical', emoji: '🔥' },
  { key: 'major', name: 'Major', emoji: '🟠' },
  { key: 'minor', name: 'Minor', emoji: '🟡' },
];
const NEEDS_LOG_TAG = process.env.NEEDS_LOG_TAG_NAME || 'needs log';

// Channels a boost unlocks. Missing ones are skipped, so the list can name a channel that does
// not exist yet without anything breaking.
const BOOSTER_CHANNELS = (process.env.BOOSTER_CHANNELS || 'dev-builds,behind-the-scenes')
  .split(',').map((s) => s.trim()).filter(Boolean);

// The early-member badge. The role itself is the tally - Discord keeps it, so the bot still needs
// no storage of its own, and the promise the badge makes ("one of the first N here") is exactly
// what a member can see: at most N people wear it.
const OG_ROLE = process.env.OG_ROLE_NAME || 'OG';
const OG_LIMIT = Number(process.env.OG_LIMIT || 200);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// The log the dashboard shows. Five hundred lines is a few days of a quiet server and costs
// nothing; the book behind it keeps a longer tail, so a restart no longer starts on a blank page.
const RING = 500;
const RECENT = [];
const log = (...a) => {
  const line = [new Date().toISOString(), ...a].join(' ');
  console.log(line);
  RECENT.push(line);
  if (RECENT.length > RING) RECENT.shift();
  db.line(line);
};

// The book. Opened before anything else has anything to say, so the first lines land in it too.
// If there is nowhere to keep it, every call to it is a shrug and the bot runs as it always did.
db.open(log);
if (db.ready) RECENT.splice(0, RECENT.length, ...db.lines(RING));

// What the dashboard puts on its cards. The totals are everything the bot has ever done, read back
// out of the book; `since` is only this run, which is the number that used to be shown.
const counters = { joined: 0, triaged: 0, rolesGiven: 0, retriaged: 0, ogGiven: 0,
  videosPosted: 0, packsPosted: 0 };
const since = { ...counters };
Object.assign(counters, db.counters());
const count = (name, by = 1) => {
  counters[name] = (counters[name] || 0) + by;
  since[name] = (since[name] || 0) + by;
  db.bump(name, by);
};

// ---- the member role -----------------------------------------------------------------------

function memberRole(guild) {
  return guild.roles.cache.find((r) => r.name.toLowerCase() === MEMBER_ROLE.toLowerCase()) || null;
}

async function giveRole(member, why) {
  if (member.user.bot) return;
  const role = memberRole(member.guild);
  if (!role) { log(`[role] no role called "${MEMBER_ROLE}" in ${member.guild.name}`); return; }
  if (member.roles.cache.has(role.id)) return;
  const me = await member.guild.members.fetchMe();
  if (role.position >= me.roles.highest.position) {
    log(`[role] "${role.name}" sits at or above my own highest role - drag mine above it in Server Settings > Roles`);
    return;
  }
  if (DRY) { log(`[role] (dry run) would give ${member.user.tag} ${role.name} - ${why}`); return; }
  try {
    await member.roles.add(role, `auto: ${why}`);
    count('rolesGiven');
    db.event('role', member.user.tag, `${role.name} - ${why}`);
    log(`[role] ${member.user.tag} -> ${role.name} (${why})`);
  } catch (e) {
    log(`[role] could not give ${member.user.tag} ${role.name}: ${e.message}`);
  }
}

async function backfill(guild) {
  const role = memberRole(guild);
  if (!role) return;
  const members = await guild.members.fetch();
  let n = 0;
  for (const m of members.values()) {
    if (m.user.bot || m.roles.cache.has(role.id)) continue;
    await giveRole(m, 'backfill');
    n++;
    await new Promise((r) => setTimeout(r, 400));       // stay well under the rate limit
  }
  log(`[role] backfill done: ${n} member(s) touched`);
}

// ---- the early-member badge ----------------------------------------------------------------

/** The OG role, made if it is not there yet. Null when it cannot be. */
async function ogRole(guild) {
  const found = guild.roles.cache.find((r) => r.name.toLowerCase() === OG_ROLE.toLowerCase());
  if (found) return found;
  if (DRY) { log(`[og] (dry run) would create the "${OG_ROLE}" role`); return null; }
  try {
    const role = await guild.roles.create({
      name: OG_ROLE,
      colors: { primaryColor: 0xE2B24A },   // discord.js 14.22 renamed this; "color" still works but warns
      hoist: false,
      mentionable: false,
      reason: `the first ${OG_LIMIT} members`,
    });
    log(`[og] created the "${role.name}" role`);
    return role;
  } catch (e) {
    log(`[og] could not create "${OG_ROLE}": ${e.message}`);
    return null;
  }
}

/** Hand the badge to one member, if there is a place left. */
async function giveOg(member, role) {
  if (member.user.bot) return false;
  if (!role || member.roles.cache.has(role.id)) return false;
  if (role.members.size >= OG_LIMIT) return false;
  const me = await member.guild.members.fetchMe();
  if (role.position >= me.roles.highest.position) {
    log(`[og] "${role.name}" sits at or above my own highest role - drag mine above it`);
    return false;
  }
  if (DRY) { log(`[og] (dry run) would give ${member.user.tag} ${role.name}`); return false; }
  try {
    await member.roles.add(role, `one of the first ${OG_LIMIT}`);
    count('ogGiven');
    db.event('og', member.user.tag, `${role.members.size}/${OG_LIMIT}`);
    log(`[og] ${member.user.tag} -> ${role.name} (${role.members.size}/${OG_LIMIT})`);
    return true;
  } catch (e) {
    log(`[og] could not give ${member.user.tag} ${role.name}: ${e.message}`);
    return false;
  }
}

/**
 * Everybody already here, oldest first, until the places run out.
 *
 * <p>Ordering by when they joined is the whole point: if the server ever holds more than the
 * limit, the badge should go to the ones who were here first, not to whoever the cache happened
 * to list first.</p>
 */
async function ogBackfill(guild) {
  const role = await ogRole(guild);
  if (!role) return;
  await guild.members.fetch();
  const queue = [...guild.members.cache.values()]
    .filter((m) => !m.user.bot && !m.roles.cache.has(role.id))
    .sort((a, b) => (a.joinedTimestamp || 0) - (b.joinedTimestamp || 0));
  let given = 0;
  for (const m of queue) {
    if (role.members.size >= OG_LIMIT) break;
    if (await giveOg(m, role)) given++;
  }
  log(`  "${role.name}": ${role.members.size}/${OG_LIMIT}${given ? ` (${given} handed out just now)` : ''}`);
}

// ---- the bug forum -------------------------------------------------------------------------

function findForum(guild) {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildForum && c.name.toLowerCase() === BUG_FORUM.toLowerCase(),
  ) || null;
}

/** Make sure Critical / Major / Minor exist, without disturbing the tags already there. */
async function ensureTags(forum) {
  const have = forum.availableTags.map((t) => t.name.toLowerCase());
  const missing = SEVERITY_TAGS.filter((t) => !have.includes(t.name.toLowerCase()));
  if (!missing.length) return forum;
  if (forum.availableTags.length + missing.length > 20) {
    log('[tags] the forum is at Discord\'s 20-tag limit - add Critical/Major/Minor by hand and I will use them');
    return forum;
  }
  if (DRY) { log(`[tags] (dry run) would add: ${missing.map((t) => t.name).join(', ')}`); return forum; }
  // the id has to come along: a tag sent back without one is created afresh, which would
  // quietly unhook every post already wearing it
  const tags = [
    ...forum.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
    ...missing.map((t) => ({ name: t.name, moderated: true, emoji: { name: t.emoji, id: null } })),
  ];
  try {
    const updated = await forum.setAvailableTags(tags, 'severity tags for automatic triage');
    log(`[tags] added: ${missing.map((t) => t.name).join(', ')}`);
    return updated || forum;
  } catch (e) {
    // editing a forum's tag list wants Manage Channels, which this bot deliberately does not
    // have. Not being able to create them is not a reason to stop doing everything else.
    log(`[tags] could not add ${missing.map((t) => t.name).join(', ')}: ${e.message}` +
        ' - add those three tags to the forum by hand and I will use them');
    return forum;
  }
}

function tagId(forum, name) {
  const t = forum.availableTags.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  return t ? t.id : null;
}

const LINE = {
  critical: 'Filed as **Critical** - I look at these first.',
  major: 'Filed as **Major**.',
  minor: 'Filed as **Minor** - it will get fixed, just not ahead of the ones that break the game.',
};

async function onNewPost(thread) {
  const forum = thread.parent;
  if (!forum || forum.type !== ChannelType.GuildForum) return;
  if (forum.name.toLowerCase() !== BUG_FORUM.toLowerCase()) return;

  // give the starter message a moment to exist
  let starter = null;
  for (let i = 0; i < 6 && !starter; i++) {
    try { starter = await thread.fetchStarterMessage(); } catch { /* not there yet */ }
    if (!starter) await new Promise((r) => setTimeout(r, 800));
  }
  const body = starter ? starter.content : '';
  const files = starter ? starter.attachments.size : 0;
  const text = `${thread.name}\n${body}`;

  let verdict = triage.classify(thread.name, body, files);
  const second = await llm.ask(thread.name, body);
  verdict = triage.reconcile(verdict, second, text);

  // a human who already tagged the post knows better than I do
  const already = thread.appliedTags || [];
  const severityIds = SEVERITY_TAGS.map((t) => tagId(forum, t.name)).filter(Boolean);
  if (already.some((id) => severityIds.includes(id))) {
    log(`[triage] "${thread.name}" already has a severity tag - left alone`);
    return;
  }

  const want = new Set(already);
  const sev = tagId(forum, SEVERITY_TAGS.find((t) => t.key === verdict.severity).name);
  if (sev) want.add(sev);
  if (verdict.project) { const p = tagId(forum, verdict.project); if (p) want.add(p); }
  if (verdict.needsLog) { const l = tagId(forum, NEEDS_LOG_TAG); if (l) want.add(l); }

  const tags = [...want].slice(0, 5);                    // Discord allows five per post
  log(`[triage] "${thread.name}" -> ${verdict.severity}${verdict.project ? ' / ' + verdict.project : ''}` +
      `${verdict.needsLog ? ' / needs log' : ''}  (${verdict.why})`);
  if (DRY) return;

  try {
    await thread.setAppliedTags(tags, 'automatic triage');
    count('triaged');
    db.report({
      id: thread.id, title: thread.name, author: starter?.author?.tag || null,
      severity: verdict.severity, project: verdict.project, needsLog: verdict.needsLog,
      why: verdict.why,
    });
  } catch (e) {
    log(`[triage] could not tag "${thread.name}": ${e.message}`);
  }

  if (!REPLY) return;
  const missing = [];
  const t = text.toLowerCase();
  if (verdict.needsLog) missing.push('your `latest.log` (or the crash report) - drag the file straight into this post');
  if (!/\b\d+\.\d+[\w.\-]*\b/.test(t)) missing.push('which version of the mod you are on');
  if (!t.includes('neoforge') && !t.includes('forge') && !t.includes('fabric')) missing.push('your NeoForge version');
  let msg = `${LINE[verdict.severity]}`;
  if (missing.length) {
    msg += `\n\nTo get it fixed faster, could you add:\n` + missing.map((m) => `- ${m}`).join('\n');
  }
  msg += `\n\n-# Tagged automatically. If I got it wrong, Lovkar will fix the tag - it changes nothing but the order things get looked at.`;
  try {
    await thread.send({ content: msg, allowedMentions: { parse: [] } });
  } catch (e) {
    log(`[triage] could not reply in "${thread.name}": ${e.message}`);
  }
}

/**
 * Triage a post again, at somebody's request from the dashboard.
 *
 * <p>{@link onNewPost} leaves alone anything that already carries a severity, because a human's
 * tag beats a guess. Asking for it again from the dashboard <em>is</em> that human, so the
 * severity tags are cleared first and then the ordinary path runs.</p>
 */
async function retriage(thread) {
  const forum = thread.parent;
  const severityIds = SEVERITY_TAGS.map((t) => tagId(forum, t.name)).filter(Boolean);
  const keep = (thread.appliedTags || []).filter((id) => !severityIds.includes(id));
  if (keep.length !== (thread.appliedTags || []).length) {
    await thread.setAppliedTags(keep, 'triage asked for again');
  }
  count('retriaged');
  await onNewPost(await thread.fetch());
}

// ---- what a boost unlocks ------------------------------------------------------------------

/**
 * Give the Server Booster role sight of the channels a boost is meant to open.
 *
 * <p>Discord creates that role lazily - it does not exist at all while the server has no boosts -
 * so the permission cannot be set up in the UI beforehand. Run this at startup and whenever the
 * roles change and the perk turns itself on with the first boost. Only ViewChannel is granted, and
 * only where it is not granted already, so running it repeatedly costs nothing and a permission
 * somebody set by hand is never overwritten. Channels that do not exist yet are skipped.</p>
 */
async function boosterPerks(g) {
  const role = g.roles.premiumSubscriberRole;
  if (!role) return;                                     // nobody has boosted yet
  for (const name of BOOSTER_CHANNELS) {
    const ch = g.channels.cache.find((c) => c.name === name && c.permissionOverwrites);
    if (!ch) { log(`  boost: no channel #${name} (skipped)`); continue; }
    const has = ch.permissionOverwrites.cache.get(role.id);
    if (has && has.allow.has(PermissionsBitField.Flags.ViewChannel)) continue;
    if (DRY) { log(`  boost: would open #${name} to ${role.name}`); continue; }
    try {
      await ch.permissionOverwrites.edit(role, { ViewChannel: true }, { reason: 'server boosters see the boosted channels' });
      log(`  boost: #${name} opened to ${role.name}`);
    } catch (e) {
      log(`  boost: could not open #${name}: ${e.message}`);
    }
  }
}

// ---- wiring --------------------------------------------------------------------------------

client.once(Events.ClientReady, async (c) => {
  log(`logged in as ${c.user.tag}`);
  const guilds = GUILD_ID ? [c.guilds.cache.get(GUILD_ID)].filter(Boolean) : [...c.guilds.cache.values()];
  for (const g of guilds) {
    try {
      await startGuild(g);
    } catch (e) {
      log(`[startup] ${g.name}: ${e.message}`);
    }
  }
  log(`triage second opinion: ${llm.describe()}${DRY ? '   (DRY RUN - nothing is written)' : ''}`);
  web.start(c, {
    log, llm, retriage, db,
    recent: () => [...RECENT],
    stats: () => ({ ...counters, ...db.counters(), since: { ...since }, book: db.stats() }),
  });
  if (DRY) {
    log('[youtube] DRY RUN - not watching');
  } else {
    youtube.start(c, {
      log,
      guildId: GUILD_ID,
      seen: () => db.videosSeen(),
      onPosted: (e, msg) => {
        count('videosPosted');
        db.videoPosted({ id: e.id, title: e.title, url: e.url, published: e.published, messageId: msg?.id });
      },
    })
      .catch((e) => log('[youtube]', e.message));
  }
});

async function startGuild(g) {
  {
    log(`guild: ${g.name}`);
    const role = memberRole(g);
    log(`  member role "${MEMBER_ROLE}": ${role ? 'found' : 'MISSING'}`);
    let forum = findForum(g);
    if (forum) {
      forum = await ensureTags(await forum.fetch());
      log(`  forum "#${forum.name}": ${forum.availableTags.map((t) => t.name).join(', ')}`);
    } else {
      log(`  forum "#${BUG_FORUM}": MISSING`);
    }
    await boosterPerks(g);
    await ogBackfill(g);
    if (BACKFILL) await backfill(g);
  }
}

client.on(Events.GuildMemberAdd, async (m) => {
  db.event('join', m.user.tag, `${m.guild.memberCount} members`);
  count('joined');
  await giveRole(m, 'joined');
  await giveOg(m, await ogRole(m.guild)).catch((e) => log('[og]', e.message));
});
// the booster role appears the moment the first boost lands, and again if it is ever recreated
client.on(Events.GuildRoleCreate, (r) => boosterPerks(r.guild).catch((e) => log('[boost]', e.message)));
client.on(Events.GuildUpdate, (_old, g) => boosterPerks(g).catch((e) => log('[boost]', e.message)));
client.on(Events.ThreadCreate, (t, isNew) => { if (isNew) onNewPost(t).catch((e) => log('[triage]', e)); });

client.on(Events.Error, (e) => log('[gateway]', e.message));
process.on('unhandledRejection', (e) => log('[unhandled]', e));

client.login(TOKEN);
