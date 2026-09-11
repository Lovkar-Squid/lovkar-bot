/**
 * boosts.js - every server boost said out loud in #boosts, and the Supporter role that comes with it.
 *
 * <p>A boost is somebody paying, every month, for everyone else's emoji slots and audio quality.
 * Discord marks the moment with one grey system line in whichever channel the server's system
 * messages go to (here #joins, between the join lines), and that is the last anybody hears of it.
 * This gives each boost a card of its own in #boosts - who, how many, what level the server is at
 * now and how far the next one is - and hands the booster the Supporter role, so a boost buys
 * exactly what the role Lovkar gives by hand buys.</p>
 *
 * <p><b>Where a boost is seen.</b> Discord's own system message is the best witness there is: it
 * names the booster, says how many boosts they bought in one go (the message content is that
 * number, "2"), and its type says whether this boost took the server up a level (9, 10, 11 for
 * Level 1, 2, 3; plain 8 otherwise). So that is what this listens for. If a server owner switches
 * those system messages off, there is a second witness: the member's <code>premiumSince</code>
 * going from nothing to a date. It cannot tell a second boost from the same person, or the count,
 * so it is only used when the first witness is gone - never both, or every boost would be said
 * twice.</p>
 *
 * <p><b>Saying it once.</b> #boosts itself is the record, the way #announcements is for videos:
 * each card carries the boost's own time as its timestamp and the booster's mention, and before
 * anything is posted the last fifty messages are read to see whether that card is already there.
 * That is what makes the look back at startup safe. Boosts from the last
 * <code>BOOST_CATCHUP_HOURS</code> (24) that have no card yet are posted - a bot that was being
 * redeployed while somebody boosted still thanks them - and a restart, a lost book or a second copy
 * of the bot finds its own cards and stays quiet. Anything older is left alone: a thank-you three
 * days late is stranger than none.</p>
 *
 * <p><b>The Supporter role.</b> Given when a boost starts. Taken back when the boost ends - but only
 * if it was this file that gave it. Who got it from a boost is one line in the book
 * (<code>boosts:auto-supporters</code>); somebody Lovkar made a Supporter by hand is not on it and
 * is never touched, boosting or not. A sweep at startup and every <code>BOOST_SWEEP_MINUTES</code>
 * (30) puts the role right for anyone whose boost began or ended while the bot was away. With no
 * book there is nowhere to write "this one was mine", so the role is still given but never taken:
 * losing a perk wrongly is worse than keeping one a little long.</p>
 *
 * Settings (environment, all optional - the defaults are what the server uses):
 *   BOOST_ENABLED        0 switches all of it off                     (default on)
 *   BOOST_CHANNEL        channel name or id for the cards              (default boosts)
 *   BOOST_PING           1 pings the booster in their card              (default off)
 *   BOOST_SUPPORTER      0 stops handing boosters the Supporter role     (default on)
 *   BOOST_CATCHUP_HOURS  how far back the startup look reaches          (default 24)
 *   BOOST_SWEEP_MINUTES  how often the Supporter role is re-checked      (default 30)
 */

'use strict';

const { EmbedBuilder, ChannelType, SystemChannelFlagsBitField } = require('discord.js');
const db = require('./db');

const COLOUR = 0xf47fff;                 // Discord's own booster pink, the Supporter role's colour
/** Boost system message types, and the level each one says the server has just reached (0: none). */
const BOOST_TYPES = new Map([[8, 0], [9, 1], [10, 2], [11, 3]]);
/** How many boosts each level takes. */
const LEVELS = [{ level: 1, boosts: 2 }, { level: 2, boosts: 7 }, { level: 3, boosts: 14 }];
/** Who holds the Supporter role because of a boost, as a JSON list of user ids. */
const AUTO_KEY = 'boosts:auto-supporters';
/** How many of #boosts' newest messages are read to find out whether a card is already there. */
const LOOK_BACK = 50;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONF = {
  enabled: (process.env.BOOST_ENABLED || '1') !== '0',
  channel: (process.env.BOOST_CHANNEL || 'boosts').trim(),
  ping: process.env.BOOST_PING === '1',
  supporter: (process.env.BOOST_SUPPORTER || '1') !== '0',
  catchupHours: num(process.env.BOOST_CATCHUP_HOURS, 24),
  sweepMinutes: num(process.env.BOOST_SWEEP_MINUTES, 30),
  /** Discord sends the new boost count a moment after the system message; this is that moment. */
  settleMs: num(process.env.BOOST_SETTLE_MS, 4000),
};

// ---- the pure half, so the test can check it without Discord anywhere near it -------------------

/** Whether a message is one of Discord's boost system messages. */
function isBoost(message) {
  return BOOST_TYPES.has(Number(message?.type));
}

/** The level a boost message says the server just reached, or 0 when it did not go up. */
function levelReached(type) {
  return BOOST_TYPES.get(Number(type)) || 0;
}

/** How many boosts one system message is about. Its content is that number; empty means one. */
function boostCount(content) {
  const n = parseInt(String(content ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The level a number of boosts buys. */
function levelFor(boosts) {
  const n = Number(boosts) || 0;
  let level = 0;
  for (const l of LEVELS) if (n >= l.boosts) level = l.level;
  return level;
}

/** The next level and how many boosts are still missing, or null at the top. */
function nextLevel(boosts) {
  const n = Number(boosts) || 0;
  const next = LEVELS.find((l) => n < l.boosts);
  return next ? { level: next.level, need: next.boosts - n } : null;
}

/**
 * The server's boost count right after each of these boosts, newest first.
 *
 * <p>Only today's count is known, so the older ones are worked out backwards by taking each newer
 * boost off again. A count cannot fall below the boost it is describing, which also keeps the
 * numbers sane when a boost expired somewhere in between.</p>
 *
 * @param current      the server's boost count now
 * @param newestFirst  the boosts' counts, newest first
 */
function totalsAfter(current, newestFirst) {
  const out = [];
  let total = Number(current) || 0;
  for (const count of newestFirst) {
    const c = Number(count) || 1;
    out.push(Math.max(total, c));
    total = Math.max(total - c, 0);
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

/** "a", "a and b", "a, b and c". */
function list(items) {
  const xs = [...items];
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * The words on a card.
 *
 * @param b.userId  the booster
 * @param b.count   boosts bought in this one go, or null when nobody can say (the fallback witness)
 * @param b.reached the level this boost took the server to, 0 for none
 * @param b.total   the server's boost count after this boost, or null when unknown
 * @param b.perks   the channels a Supporter gets, already formatted (may be empty)
 * @param b.supporter whether boosters get the Supporter role at all
 */
function text({ userId, count = 1, reached = 0, total = null, perks = [], supporter = true }) {
  const lines = [];
  const times = count && count > 1 ? ` **×${count}**` : '';
  lines.push(`<@${userId}> just boosted the server${times}! Thank you 💜`);
  if (reached) lines.push(`🎉 That took the server to **Level ${reached}**!`);
  if (total != null && Number.isFinite(Number(total))) {
    const t = Number(total);
    const level = levelFor(t);
    const next = nextLevel(t);
    lines.push(`The server now has **${plural(t, 'boost')}** · Level ${level}`
      + (next ? ` · ${next.need} more for Level ${next.level}` : ' · the top level'));
  }
  if (supporter) {
    lines.push(perks.length
      ? `Boosters get the **Supporter** role: ${list(perks)}`
      : 'Boosters get the **Supporter** role.');
  }
  return lines.join('\n');
}

/** The whole message. Nobody is pinged unless BOOST_PING is on, and then only the booster. */
function message(b, { ping = CONF.ping } = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLOUR)
    .setTitle('💎 New server boost')
    .setDescription(text(b))
    .setTimestamp(b.at ? new Date(b.at) : new Date());
  if (b.avatar) embed.setThumbnail(b.avatar);
  return {
    content: ping ? `<@${b.userId}>` : undefined,
    embeds: [embed],
    allowedMentions: ping ? { users: [String(b.userId)] } : { parse: [] },
  };
}

/**
 * Whether a card for this boost is already among these messages: one of ours, about the same
 * person, stamped with the same moment. The moment is the boost's own, not the time of posting,
 * which is what lets a second look recognise a card the first look made.
 */
function alreadyPosted(messages, { userId, at }, botId) {
  const when = Number(at);
  for (const m of messages || []) {
    if (botId && m.author?.id !== botId) continue;
    for (const e of m.embeds || []) {
      const stamp = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (!Number.isFinite(stamp) || Math.abs(stamp - when) > 1500) continue;
      if (String(e.description || '').includes(`<@${userId}>`)) return true;
    }
  }
  return false;
}

/**
 * Who should gain and lose the Supporter role, from who is boosting and who got it from a boost.
 *
 * @param people  [{ id, boosting, supporter }] - everyone currently in the server worth looking at
 * @param auto    ids that hold the role because of a boost
 * @returns { give, take, auto } - ids to give it to, ids to take it from, and the new auto list
 */
function plan(people, auto) {
  const byId = new Map((people || []).map((p) => [String(p.id), p]));
  const mine = new Set((auto || []).map(String));
  const give = [];
  const take = [];
  for (const p of people || []) {
    const id = String(p.id);
    if (p.boosting && !p.supporter) { give.push(id); mine.add(id); }
  }
  for (const id of [...mine]) {
    const p = byId.get(id);
    if (p && p.boosting) continue;                 // still boosting: keep it
    if (p && p.supporter && !give.includes(id)) take.push(id);
    mine.delete(id);                               // gone from the server, or boost over
  }
  return { give, take, auto: [...mine].sort() };
}

// ---- the running part ----------------------------------------------------------------------------

const state = {
  client: null,
  guild: null,
  log: console.log,
  dry: false,
  count: null,
  perkNames: [],
  roleName: 'Supporter',
  chain: Promise.resolve(),
  timer: null,
};

/** One thing at a time, in order: two boosts a second apart must not race each other to #boosts. */
function serial(what, fn) {
  state.chain = state.chain.then(fn).catch((e) => state.log(`[boosts] ${what}: ${e.message}`));
  return state.chain;
}

function findChannel(guild, name) {
  const want = String(name || '').replace(/^#/, '').toLowerCase();
  if (!want || !guild) return null;
  return guild.channels.cache.find(
    (c) => (c.id === want || String(c.name || '').toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

function supporterRole(guild) {
  const want = String(state.roleName || '').toLowerCase();
  if (!want) return null;
  return guild.roles.cache.find((r) => r.name.toLowerCase() === want) || null;
}

/**
 * Whether Discord's own boost messages are there to be heard: a system channel, and boost messages
 * not switched off in Server Settings → Engagement.
 */
function systemMessagesOn(guild) {
  if (!guild?.systemChannelId) return false;
  const flags = new SystemChannelFlagsBitField(guild.systemChannelFlags ?? 0);
  return !flags.has(SystemChannelFlagsBitField.Flags.SuppressPremiumSubscriptions);
}

/**
 * The Supporter channels, by name. Written out rather than as channel mentions: most people reading
 * #boosts cannot see those channels, and Discord draws a mention of a channel you cannot see as
 * "No Access", which is the opposite of an invitation.
 */
function perkNames(guild) {
  return state.perkNames.filter((name) => findChannel(guild, name)).map((name) => `**#${name}**`);
}

function readAuto() {
  try {
    const list = JSON.parse(db.get(AUTO_KEY) || '[]');
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

function writeAuto(ids) {
  db.set(AUTO_KEY, JSON.stringify([...new Set(ids.map(String))].sort()));
}

/**
 * Put one card in #boosts, unless it is already there.
 *
 * @returns true when a card went out
 */
async function announce(guild, b, { recent = null } = {}) {
  const channel = findChannel(guild, CONF.channel);
  if (!channel) { state.log(`[boosts] no #${CONF.channel} - the boost by ${b.tag || b.userId} is not announced`); return false; }
  const seen = recent || [...(await channel.messages.fetch({ limit: LOOK_BACK }).catch(() => new Map())).values()];
  if (alreadyPosted(seen, b, state.client?.user?.id)) return false;
  const card = message({ ...b, perks: perkNames(guild), supporter: CONF.supporter && Boolean(supporterRole(guild)) });
  if (state.dry) { state.log(`[boosts] DRY RUN - would thank ${b.tag || b.userId} in #${channel.name}`); return false; }
  const sent = await channel.send(card);
  if (recent) recent.unshift(sent);
  db.event('boost', b.tag || String(b.userId), `${b.count || '?'} boost(s)${b.reached ? `, level ${b.reached}` : ''}`);
  if (state.count) state.count('boostsThanked'); else db.bump('boostsThanked');
  state.log(`[boosts] thanked ${b.tag || b.userId} in #${channel.name}`
    + `${b.count ? ` (${plural(b.count, 'boost')})` : ''}${b.reached ? `, level ${b.reached}` : ''}`);
  return true;
}

/**
 * Give and take the Supporter role so that it matches who is boosting.
 *
 * @param only  a single member to look at, instead of the whole server
 */
async function sweep(guild, { only = null } = {}) {
  if (!CONF.supporter) return { give: [], take: [] };
  const role = supporterRole(guild);
  if (!role) { state.log(`[boosts] no "${state.roleName}" role - boosters get nothing extra`); return { give: [], take: [] }; }
  const me = guild.members.me;
  if (me && role.position >= me.roles.highest.position) {
    state.log(`[boosts] "${role.name}" sits at or above my own role - drag mine above it to hand it out`);
    return { give: [], take: [] };
  }

  let members;
  if (only) {
    members = [only];
  } else {
    await guild.members.fetch().catch(() => null);        // a small server: one request, everyone
    members = [...guild.members.cache.values()];
  }
  const people = members.filter((m) => !m.user?.bot).map((m) => ({
    id: m.id, boosting: Boolean(m.premiumSince), supporter: m.roles.cache.has(role.id),
  }));

  // A whole-server sweep sees everybody, so an id on the list with no member behind it has left and
  // is dropped. A sweep of one member only speaks for that member; the rest of the list is kept.
  const auto = readAuto();
  const looked = new Set(people.map((p) => p.id));
  const result = plan(people, only ? auto.filter((id) => looked.has(id)) : auto);
  const untouched = only ? auto.filter((id) => !looked.has(id)) : [];

  for (const id of result.give) {
    const m = guild.members.cache.get(id);
    if (!m) continue;
    if (state.dry) { state.log(`[boosts] DRY RUN - would give ${m.user.tag} the ${role.name} role`); continue; }
    try {
      await m.roles.add(role, 'Boosting the server: boosters get the Supporter role');
      state.log(`[boosts] ${m.user.tag} is boosting - gave them ${role.name}`);
    } catch (e) {
      state.log(`[boosts] could not give ${m.user.tag} ${role.name}: ${e.message}`);
      result.auto = result.auto.filter((x) => x !== id);   // not given, so never ours to take back
    }
  }
  for (const id of result.take) {
    const m = guild.members.cache.get(id);
    if (!m) continue;
    if (state.dry) { state.log(`[boosts] DRY RUN - would take ${role.name} back from ${m.user.tag}`); continue; }
    try {
      await m.roles.remove(role, 'The boost ended: the Supporter role came with it');
      state.log(`[boosts] ${m.user.tag} stopped boosting - took back the ${role.name} role the boost gave`);
    } catch (e) {
      state.log(`[boosts] could not take ${role.name} from ${m.user.tag}: ${e.message}`);
    }
  }
  if (!state.dry) writeAuto([...result.auto, ...untouched]);
  return result;
}

/**
 * The look back: boosts from the last BOOST_CATCHUP_HOURS with no card yet get one, oldest first.
 */
async function catchUp(guild) {
  const channel = findChannel(guild, CONF.channel);
  if (!channel) return 0;
  const since = Date.now() - CONF.catchupHours * 3600 * 1000;
  const recent = [...(await channel.messages.fetch({ limit: LOOK_BACK }).catch(() => new Map())).values()];
  let found = [];
  if (systemMessagesOn(guild)) {
    const sys = guild.systemChannel;
    const msgs = sys ? await sys.messages.fetch({ limit: 100 }).catch(() => null) : null;
    if (!msgs) { state.log('[boosts] cannot read the system channel - nothing to look back at'); return 0; }
    found = [...msgs.values()].filter(isBoost).map((m) => ({
      userId: m.author.id, tag: m.author.tag, avatar: m.author.displayAvatarURL?.({ size: 256 }),
      count: boostCount(m.content), reached: levelReached(m.type), at: m.createdTimestamp,
    }));
  } else {
    await guild.members.fetch().catch(() => null);
    found = [...guild.members.cache.values()].filter((m) => m.premiumSince).map((m) => ({
      userId: m.id, tag: m.user.tag, avatar: m.displayAvatarURL?.({ size: 256 }),
      count: null, reached: 0, at: m.premiumSinceTimestamp,
    }));
  }
  const newestFirst = found.sort((a, b) => b.at - a.at);
  const totals = totalsAfter(guild.premiumSubscriptionCount, newestFirst.map((b) => b.count || 1));
  // without counts only the newest boost's total is known for certain
  newestFirst.forEach((b, i) => { b.total = i === 0 || b.count ? totals[i] : null; });
  let posted = 0;
  for (const b of [...newestFirst].reverse()) {
    if (b.at < since) continue;
    if (await announce(guild, b, { recent })) posted++;
  }
  return posted;
}

/** Discord's boost message, straight off the gateway. */
function onMessage(m) {
  if (!state.guild || !CONF.enabled || !m?.guild || m.guild.id !== state.guild.id || !isBoost(m)) return;
  const b = {
    userId: m.author.id, tag: m.author.tag, avatar: m.author.displayAvatarURL?.({ size: 256 }),
    count: boostCount(m.content), reached: levelReached(m.type), at: m.createdTimestamp,
  };
  serial('a boost', async () => {
    await new Promise((r) => setTimeout(r, CONF.settleMs));
    const guild = await state.guild.fetch().catch(() => state.guild);
    b.total = guild.premiumSubscriptionCount;
    await announce(guild, b);
    const member = await guild.members.fetch(b.userId).catch(() => null);
    if (member) await sweep(guild, { only: member });
  });
}

/** A member's boost starting or ending. The role follows either way; a card only without system messages. */
function onMemberUpdate(before, after) {
  if (!state.guild || !CONF.enabled || !after?.guild || after.guild.id !== state.guild.id) return;
  const was = Boolean(before?.premiumSince);
  const is = Boolean(after.premiumSince);
  if (was === is) return;
  serial(is ? 'a boost starting' : 'a boost ending', async () => {
    if (is && !systemMessagesOn(after.guild)) {
      await new Promise((r) => setTimeout(r, CONF.settleMs));
      const guild = await state.guild.fetch().catch(() => state.guild);
      await announce(guild, {
        userId: after.id, tag: after.user.tag, avatar: after.displayAvatarURL?.({ size: 256 }),
        count: null, reached: 0, at: after.premiumSinceTimestamp, total: guild.premiumSubscriptionCount,
      });
    }
    if (!is) state.log(`[boosts] ${after.user.tag} is no longer boosting`);
    await sweep(after.guild, { only: after });
  });
}

/**
 * Find the server, look back once, put the Supporter role right, and keep it right.
 */
function start(client, { log = console.log, guildId, dry = false, count = null, perkChannels = [], supporterRole: roleName = 'Supporter' } = {}) {
  state.log = log;
  if (!CONF.enabled) { log('[boosts] off (BOOST_ENABLED=0)'); return null; }
  const guild = guildId ? client?.guilds?.cache?.get(guildId) : client?.guilds?.cache?.first();
  if (!guild) { log('[boosts] no guild - nothing to watch'); return null; }
  Object.assign(state, { client, guild, dry, count, perkNames: perkChannels, roleName });
  const channel = findChannel(guild, CONF.channel);
  log(`[boosts] ${channel ? `#${channel.name}` : `no #${CONF.channel} (cards off until it exists)`}`
    + ` · ${plural(guild.premiumSubscriptionCount || 0, 'boost')}, level ${levelFor(guild.premiumSubscriptionCount)}`
    + ` · heard through ${systemMessagesOn(guild) ? `Discord's boost messages in #${guild.systemChannel?.name || '?'}` : 'members\' boost dates (system messages are off)'}`
    + ` · Supporter for boosters ${CONF.supporter ? 'on' : 'off'}${dry ? ' · DRY RUN' : ''}`);

  serial('the look back', async () => {
    const n = await catchUp(guild);
    if (n) log(`[boosts] the look back thanked ${plural(n, 'boost')} that had no card yet`);
    await sweep(guild);
  });
  const every = Math.max(5, CONF.sweepMinutes);
  state.timer = setInterval(() => serial('the sweep', () => sweep(guild)), every * 60 * 1000);
  state.timer.unref?.();
  return { stop: () => clearInterval(state.timer), sweep: () => serial('the sweep', () => sweep(guild)) };
}

module.exports = {
  start, onMessage, onMemberUpdate, CONF,
  // the pure half
  isBoost, levelReached, boostCount, levelFor, nextLevel, totalsAfter, text, message, alreadyPosted, plan, list,
  systemMessagesOn,
};
