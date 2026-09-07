/**
 * Giveaways: a prize, a deadline, a button, and a name drawn out of the hat in public.
 *
 * <p>This is the first thing the bot does that could not work without the book. Everything else
 * it knows it can read back off Discord - tags, roles, messages - but nobody can read the
 * entrants of a giveaway off Discord, because clicking a button leaves no trace anyone else can
 * see. So the entries live in {@link ./db.js}, and a giveaway survives a restart, a redeploy and
 * a night with the server switched off: the sweep picks up anything that ended while the bot was
 * away and draws it as soon as it is back.</p>
 *
 * <p>The countdown in the message is Discord's own relative timestamp, so it ticks in everyone's
 * client without the bot editing anything. The message is only rewritten when the number of
 * entrants changes, and then at most every few seconds.</p>
 */

'use strict';

const crypto = require('crypto');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, MessageFlags,
} = require('discord.js');
const db = require('./db');

/** How often anything that has run out of time is looked for. */
const SWEEP_MS = Number(process.env.GIVEAWAY_SWEEP_SECONDS || 15) * 1000;
/** The message is not rewritten more often than this, however fast people click. */
const EDIT_EVERY_MS = 4000;
/** Nothing may run longer than this - a typo of "100d" should not book the bot for a year. */
const MAX_MS = 60 * 24 * 3600 * 1000;
const MIN_MS = 30 * 1000;
const MAX_WINNERS = 20;

const COLOUR = 0xe2b24a;        // the same gold as the dashboard
const OVER = 0x3a3a44;

/**
 * "90s", "10m", "2h", "3d", "1h30m", or a bare number of minutes.
 *
 * @returns milliseconds, or null if it means nothing
 */
function duration(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) {                                        // a bare number is minutes
    const ms = Math.round(Number(s) * 60000);
    return ms > 0 ? ms : null;
  }
  // The whole string has to be nothing but numbers and their units, so a stray minus sign or a
  // word in the middle is refused rather than quietly read as the part that happens to parse.
  if (!/^(?:\d+(?:\.\d+)?\s*[smhdw]\s*)+$/.test(s)) return null;
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([smhdw])/g)) total += Number(m[1]) * unit[m[2]];
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

/** How long is left, in words, for the places Discord's own timestamp cannot go. */
function left(ms) {
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms % 86400000 / 3600000);
  const m = Math.floor(ms % 3600000 / 60000);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

/**
 * Draw the winners.
 *
 * <p>A partial Fisher-Yates over a copy, with {@link crypto.randomInt} rather than Math.random:
 * it costs nothing here and means the draw cannot be argued with. Fewer entrants than places
 * simply means fewer winners; nobody is drawn twice.</p>
 *
 * @param pool    the user ids in the hat
 * @param howMany places
 * @param not     ids that may not win again (a reroll)
 */
function draw(pool, howMany, not = []) {
  const hat = [...new Set(pool)].filter((id) => !not.includes(id));
  const want = Math.min(Math.max(1, howMany | 0), hat.length);
  for (let i = 0; i < want; i++) {
    const j = i + crypto.randomInt(hat.length - i);
    [hat[i], hat[j]] = [hat[j], hat[i]];
  }
  return hat.slice(0, want);
}

/** What the giveaway looks like while it is running, and after. */
function card(g, entries, winners) {
  const ends = Math.floor(g.ends / 1000);
  const over = g.state !== 'running';
  const e = new EmbedBuilder()
    .setTitle('🎉  ' + g.prize)
    .setColor(over ? OVER : COLOUR);

  const lines = [];
  if (over) {
    lines.push(winners && winners.length
      ? `**Won by** ${winners.map((id) => `<@${id}>`).join(', ')}`
      : (g.state === 'cancelled' ? '**Cancelled.**' : '**Nobody entered.**'));
    lines.push(`Ended <t:${Math.floor((g.ended_at || g.ends) / 1000)}:R>`);
  } else {
    lines.push(`Ends <t:${ends}:R>  ·  <t:${ends}:f>`);
  }
  lines.push(`${entries} ${entries === 1 ? 'entry' : 'entries'}`
    + `  ·  ${g.winners} winner${g.winners === 1 ? '' : 's'}`
    + (g.role_id ? `  ·  <@&${g.role_id}> only` : ''));
  e.setDescription(lines.join('\n'));
  if (g.host) e.setFooter({ text: `Started by ${g.host}` });
  return e;
}

function buttons(g, entries) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw:${g.id}`)
      .setLabel(g.state === 'running' ? `Enter${entries ? `  (${entries})` : ''}` : 'Closed')
      .setEmoji('🎉')
      .setStyle(g.state === 'running' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(g.state !== 'running'),
  );
}

function findChannel(guild, name) {
  if (!name) return null;
  const want = String(name).replace(/^#/, '').toLowerCase();
  return guild.channels.cache.find(
    (c) => (c.id === want || c.name.toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

function findRole(guild, name) {
  if (!name) return null;
  const want = String(name).replace(/^@/, '').toLowerCase();
  return guild.roles.cache.find((r) => r.id === want || r.name.toLowerCase() === want) || null;
}

/**
 * Start one.
 *
 * @param guild  the discord.js Guild
 * @param what   { prize, lasts, winners, channel, role, host }
 * @returns { id, url, ends }
 */
async function start(guild, what, log = () => {}) {
  const prize = String(what.prize || '').trim();
  if (!prize) throw new Error('a giveaway needs a prize');
  if (prize.length > 200) throw new Error('that prize will not fit in a title');

  const ms = duration(what.lasts);
  if (!ms) throw new Error(`"${what.lasts}" is not a length of time - try 30m, 2h, 3d`);
  if (ms < MIN_MS) throw new Error('half a minute is the shortest that is worth posting');
  if (ms > MAX_MS) throw new Error('sixty days is the longest one may run');

  const winners = Math.max(1, Math.min(MAX_WINNERS, Number(what.winners) || 1));

  const channel = findChannel(guild, what.channel)
    || findChannel(guild, process.env.GIVEAWAY_CHANNEL || 'giveaways');
  if (!channel) throw new Error(`there is no #${what.channel || process.env.GIVEAWAY_CHANNEL || 'giveaways'} in this server`);

  const role = what.role ? findRole(guild, what.role) : null;
  if (what.role && !role) throw new Error(`there is no role called "${what.role}"`);

  if (!db.ready) throw new Error('the bot is not keeping a book, and a giveaway cannot be run from memory');

  const id = crypto.randomBytes(6).toString('hex');
  const ends = Date.now() + ms;
  // Written down before the message exists: if the send fails, the row is there to be seen,
  // and if the bot dies between the two the sweep closes an empty giveaway rather than a ghost.
  db.giveawayNew({ id, channelId: channel.id, prize, winners, roleId: role?.id || null, host: what.host, ends });

  const g = db.giveawayGet(id);
  const msg = await channel.send({ embeds: [card(g, 0)], components: [buttons(g, 0)] });
  db.giveawaySent(id, msg.id);
  db.event('giveaway', prize, `${what.host || 'someone'} started one in #${channel.name}, ${left(ms)}`);
  log(`[giveaway] ${what.host || 'someone'} started "${prize}" in #${channel.name} - ${winners} winner(s), ends in ${left(ms)}`);
  return { id, url: msg.url, ends, channel: channel.name };
}

/** Somebody pressed the button. Pressing it again takes them back out. */
async function press(interaction, log = () => {}) {
  const id = interaction.customId.slice(3);
  const g = db.giveawayGet(id);
  if (!g) {
    return interaction.reply({ content: 'That giveaway is gone.', flags: MessageFlags.Ephemeral });
  }
  if (g.state !== 'running' || g.ends <= Date.now()) {
    return interaction.reply({ content: 'That one is over.', flags: MessageFlags.Ephemeral });
  }
  if (g.role_id && !interaction.member?.roles?.cache?.has(g.role_id)) {
    return interaction.reply({ content: `This one is for <@&${g.role_id}> only.`, flags: MessageFlags.Ephemeral });
  }

  const inNow = db.giveawayEnter(id, interaction.user.id, interaction.user.tag);
  let text;
  if (inNow) {
    text = `You are in for **${g.prize}**. Press again to take your name back out.`;
  } else {
    db.giveawayLeave(id, interaction.user.id);
    text = `Taken back out of **${g.prize}**.`;
  }
  await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  touch(interaction.client, id, log);
  return undefined;
}

// The message is rewritten at most every EDIT_EVERY_MS, and only when the count has moved.
const pending = new Map();

function touch(client, id, log) {
  if (pending.has(id)) return;
  const later = setTimeout(async () => {
    pending.delete(id);
    try {
      const g = db.giveawayGet(id);
      if (!g || g.state !== 'running') return;
      const msg = await message(client, g);
      const n = db.giveawayCount(id);
      if (msg) await msg.edit({ embeds: [card(g, n)], components: [buttons(g, n)] });
    } catch (e) {
      log(`[giveaway] could not refresh ${id}: ${e.message}`);
    }
  }, EDIT_EVERY_MS);
  later.unref?.();
  pending.set(id, later);
}

async function message(client, g) {
  if (!g.message_id) return null;
  const channel = await client.channels.fetch(g.channel_id).catch(() => null);
  if (!channel) return null;
  return channel.messages.fetch(g.message_id).catch(() => null);
}

/**
 * Draw it and say so.
 *
 * @param why  'ended' when the clock ran out, 'early' when a human ended it
 */
async function finish(client, id, log = () => {}, why = 'ended') {
  const g = db.giveawayGet(id);
  if (!g || g.state !== 'running') return null;

  const entries = db.giveawayEntries(id);
  const winners = draw(entries.map((e) => e.user), g.winners);
  db.giveawayClose(id, 'ended', winners);
  const after = db.giveawayGet(id);

  const msg = await message(client, g);
  if (msg) {
    await msg.edit({ embeds: [card(after, entries.length, winners)], components: [buttons(after, entries.length)] })
      .catch((e) => log(`[giveaway] could not close the message: ${e.message}`));
    const said = winners.length
      ? `🎉 ${winners.map((w) => `<@${w}>`).join(', ')} — you won **${g.prize}**!`
      : `Nobody entered for **${g.prize}**.`;
    await msg.reply({ content: `${said}\n${msg.url}`, allowedMentions: { users: winners } })
      .catch((e) => log(`[giveaway] could not announce: ${e.message}`));
  }
  db.event('giveaway', g.prize, winners.length
    ? `${why}, won by ${winners.length}: ${entries.length} entries`
    : `${why} with nobody in it`);
  db.bump('giveaways');
  log(`[giveaway] "${g.prize}" ${why} - ${entries.length} entries, ${winners.length} winner(s)`);
  return { id, winners, entries: entries.length };
}

/** Draw a different name, without giving the old one a second chance. */
async function reroll(client, id, howMany = 1, log = () => {}) {
  const g = db.giveawayGet(id);
  if (!g) throw new Error('no such giveaway');
  if (g.state === 'running') throw new Error('that one has not ended yet');
  const had = g.drawn ? JSON.parse(g.drawn) : [];
  const entries = db.giveawayEntries(id).map((e) => e.user);
  const fresh = draw(entries, howMany, had);
  if (!fresh.length) throw new Error('there is nobody left to draw');
  db.giveawayClose(id, 'ended', [...had, ...fresh]);

  const msg = await message(client, g);
  if (msg) {
    await msg.reply({
      content: `🎉 Redrawn: ${fresh.map((w) => `<@${w}>`).join(', ')} — **${g.prize}** is yours.`,
      allowedMentions: { users: fresh },
    }).catch((e) => log(`[giveaway] could not announce the reroll: ${e.message}`));
  }
  log(`[giveaway] "${g.prize}" redrawn - ${fresh.length} more winner(s)`);
  return fresh;
}

/** Call it off. Nobody wins, and the message says so. */
async function cancel(client, id, log = () => {}) {
  const g = db.giveawayGet(id);
  if (!g) throw new Error('no such giveaway');
  if (g.state !== 'running') throw new Error('that one is already over');
  db.giveawayClose(id, 'cancelled', null);
  const after = db.giveawayGet(id);
  const msg = await message(client, g);
  if (msg) {
    await msg.edit({
      embeds: [card(after, db.giveawayCount(id))],
      components: [buttons(after, 0)],
    }).catch(() => {});
  }
  log(`[giveaway] "${g.prize}" cancelled`);
  return { id };
}

/**
 * Watch the clock.
 *
 * <p>One sweep rather than a timer per giveaway: a timer cannot outlive the process, and this
 * way a giveaway that ended while the bot was off is drawn the moment it comes back, which is
 * exactly what the book is for.</p>
 */
function watch(client, { log = console.log } = {}) {
  if (!db.ready) {
    log('[giveaway] no book, so no giveaways - mount /data and restart');
    return null;
  }
  const running = db.giveawayLive();
  if (running.length) {
    const late = running.filter((g) => g.ends <= Date.now()).length;
    log(`[giveaway] ${running.length} running${late ? `, ${late} of them already up` : ''}`);
  }

  const sweep = async () => {
    for (const g of db.giveawayDue()) {
      await finish(client, g.id, log).catch((e) => log(`[giveaway] ${g.id}: ${e.message}`));
    }
  };
  sweep().catch((e) => log(`[giveaway] ${e.message}`));
  const timer = setInterval(() => sweep().catch((e) => log(`[giveaway] ${e.message}`)), SWEEP_MS);
  timer.unref?.();
  return { sweep, stop: () => clearInterval(timer) };
}

/** Everything the dashboard shows, with the entry counts filled in. */
function list(n = 25) {
  return db.giveawayAll(n).map((g) => ({
    ...g,
    entries: db.giveawayCount(g.id),
    drawn: g.drawn ? JSON.parse(g.drawn) : [],
  }));
}

module.exports = {
  start, press, finish, reroll, cancel, watch, list,
  draw, duration, left, card, buttons,
  SWEEP_MS, MAX_MS, MIN_MS, MAX_WINNERS,
};
