/**
 * Lovkar's Discord bot. Two small jobs, both of them things Discord itself cannot do:
 *
 *   1. Everyone who joins gets the member role (Discord only auto-assigns roles through
 *      Onboarding, which rearranges the whole first impression of the server).
 *   2. Every new post in the bug forum gets a severity tag, a project tag, and - if it has no
 *      log - a nudge to attach one.
 *
 * It reads. It tags. It never deletes anything, never kicks anyone, and never touches a post
 * a human has already tagged by hand.
 */

'use strict';

const { Client, GatewayIntentBits, Partials, ChannelType, Events } = require('discord.js');
const triage = require('./triage');
const llm = require('./llm');

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

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
  const tags = [
    ...forum.availableTags.map((t) => ({ name: t.name, moderated: t.moderated, emoji: t.emoji })),
    ...missing.map((t) => ({ name: t.name, moderated: true, emoji: { name: t.emoji, id: null } })),
  ];
  await forum.setAvailableTags(tags, 'severity tags for automatic triage');
  log(`[tags] added: ${missing.map((t) => t.name).join(', ')}`);
  return forum;
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

// ---- wiring --------------------------------------------------------------------------------

client.once(Events.ClientReady, async (c) => {
  log(`logged in as ${c.user.tag}`);
  const guilds = GUILD_ID ? [c.guilds.cache.get(GUILD_ID)].filter(Boolean) : [...c.guilds.cache.values()];
  for (const g of guilds) {
    log(`guild: ${g.name}`);
    const role = memberRole(g);
    log(`  member role "${MEMBER_ROLE}": ${role ? 'found' : 'MISSING'}`);
    const forum = findForum(g);
    if (forum) {
      await ensureTags(await forum.fetch());
      log(`  forum "#${forum.name}": ${forum.availableTags.map((t) => t.name).join(', ')}`);
    } else {
      log(`  forum "#${BUG_FORUM}": MISSING`);
    }
    if (BACKFILL) await backfill(g);
  }
  log(`triage second opinion: ${process.env.LLM_PROVIDER || 'off'}${DRY ? '   (DRY RUN - nothing is written)' : ''}`);
});

client.on(Events.GuildMemberAdd, (m) => giveRole(m, 'joined'));
client.on(Events.ThreadCreate, (t, isNew) => { if (isNew) onNewPost(t).catch((e) => log('[triage]', e)); });

client.on(Events.Error, (e) => log('[gateway]', e.message));
process.on('unhandledRejection', (e) => log('[unhandled]', e));

client.login(TOKEN);
