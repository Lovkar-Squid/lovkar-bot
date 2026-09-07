/**
 * The notification roles: one message, a row of buttons, and nobody has to be @everyone'd.
 *
 * <p>A server that announces things has one blunt instrument for it, and a server that reaches for
 * @everyone twice in a week is a server people mute. The way out is old and boring: roles people
 * give themselves, and an announcement that pings the role instead of the room. This module is
 * only the place where people give themselves those roles - a message with a button per role,
 * where pressing it once puts the role on and pressing it again takes it off. Every answer is
 * ephemeral, so #welcome stays one message rather than turning into a conversation about it.</p>
 *
 * <p>The roles are made by the bot with no permissions at all and no colour. They are not ranks
 * and must not look like one: a role with nothing attached to it is a role that can be handed to
 * anybody who asks without anyone having to think about what else it grants, which is exactly what
 * a self-service button needs. They are mentionable, which is the whole point of them -
 * {@link mention} hands the rest of the bot the {@code <@&id>} to put in the announcement.</p>
 *
 * <p>The book ({@link ./db.js}) holds one thing here: which message the menu is. Everything else
 * can be read back off Discord - the roles are in the role list, who has them is on the members -
 * but a message id cannot be worked out again, and without it {@link post} cannot edit the menu it
 * already posted and puts up a second one instead. The old one goes on working, because a press is
 * answered out of the configuration and the role list rather than out of anything remembered about
 * the message; two menus in one channel is untidy rather than broken, and it is the only thing
 * here that gets worse without a book.</p>
 */

'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, MessageFlags,
} = require('discord.js');
const db = require('./db');

/** The prefix on the buttons. giveaways.js owns "gw:"; nothing else may answer to this one. */
const PREFIX = 'role:';
/** Where the menu is, so a second call edits it instead of posting another. */
const MESSAGE_KEY = 'rolemenu:message';
const CHANNEL_KEY = 'rolemenu:channel';

const COLOUR = 0xe2b24a;    // the same gold as the giveaways and the dashboard
const PER_ROW = 5;          // Discord's own limit on one row
const MAX_BUTTONS = 25;     // ...and five rows is all one message may carry
const LABEL_MAX = 80;       // ...and this is as long as a label may be

/** What the server gets if nobody configures anything: the four things worth being pinged about. */
const DEFAULT_MENU = 'releases:New releases:📦,sneaks:Sneak peeks:🔍,streams:Streams:🎥,'
  + 'giveaways:Giveaways:🎉';

const CONF = {
  channel: process.env.ROLE_MENU_CHANNEL || 'welcome',   // a channel name or an id
  menu: process.env.ROLE_MENU || DEFAULT_MENU,           // key:Role name:emoji, comma-separated
  title: process.env.ROLE_MENU_TITLE || 'Ping me about…',
};

// ---- reading the configuration (pure, so the test can check it without Discord anywhere near it) --

/** The key comes back on the button press, so it has to be something that survives the round trip. */
const KEY = /^[a-z0-9_-]{1,32}$/;
/** A custom emoji as Discord writes one: it has colons in it, which is why the emoji is split off last. */
const CUSTOM = /^<a?:\w{2,32}:\d{15,25}>$/;
/** 1️⃣ and its neighbours: the only emoji with an ASCII character in them. */
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/;

/**
 * The emoji of an entry, or nothing at all.
 *
 * <p>Discord refuses the whole message when one button carries something that is not an emoji, so
 * a typo in one entry would take the entire menu down with it. Anything that is not recognisably
 * an emoji is dropped here instead, and that button goes up with its label alone.</p>
 */
function icon(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 32) return '';
  if (CUSTOM.test(s) || KEYCAP.test(s)) return s;
  return /[ -~]/.test(s) ? '' : s;               // a real emoji has no printable ASCII in it
}

/**
 * "releases:New releases:📦, sneaks:Sneak peeks:🔍" read into something with a button per entry.
 *
 * <p>The middle field is the role's actual name in Discord, because that is what people see in
 * their profile and what an owner looks for in Server Settings; the key is only ever seen by the
 * button. An entry that cannot be read is left out rather than thrown over: a stray comma in a
 * setting should cost one button, not the menu.</p>
 *
 * @returns [{ key, name, emoji }], in the order they were configured, without duplicate keys
 */
function parse(text) {
  const out = [];
  const seen = new Set();
  for (const entry of String(text ?? '').split(',')) {
    const first = entry.indexOf(':');
    if (first < 0) continue;                                    // no name, so nothing to call the role
    const second = entry.indexOf(':', first + 1);
    const key = entry.slice(0, first).trim().toLowerCase();
    const name = (second < 0 ? entry.slice(first + 1) : entry.slice(first + 1, second)).trim();
    const emoji = second < 0 ? '' : entry.slice(second + 1);     // the rest, colons and all
    if (!KEY.test(key) || !name || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name, emoji: icon(emoji) });
  }
  return out;
}

/** How many entries were configured, so {@link post} can say how many of them it could not read. */
function entries(text) {
  return String(text ?? '').split(',').filter((s) => s.trim()).length;
}

// ---- the message ---------------------------------------------------------------------------------

/** The message itself. The buttons say which roles there are, so the words only say what they do. */
function card() {
  return new EmbedBuilder()
    .setTitle(CONF.title)
    .setColor(COLOUR)
    .setDescription([
      'Press a button and you will be pinged when there is something to say about it.'
        + ' Press it again and you will not be.',
      'These only decide what you get notified about - they are not ranks, they give you nothing'
        + ' else, and you can change your mind as often as you like.',
    ].join('\n\n'));
}

function button(r) {
  const b = new ButtonBuilder()
    .setCustomId(PREFIX + r.key)
    .setLabel(r.name.slice(0, LABEL_MAX))
    .setStyle(ButtonStyle.Secondary);      // a toggle, not a call to action
  if (r.emoji) b.setEmoji(r.emoji);
  return b;
}

function rows(roles) {
  const out = [];
  for (let i = 0; i < roles.length; i += PER_ROW) {
    out.push(new ActionRowBuilder().addComponents(roles.slice(i, i + PER_ROW).map(button)));
  }
  return out;
}

// ---- the server ----------------------------------------------------------------------------------

function findChannel(guild, name) {
  if (!name) return null;
  const want = String(name).replace(/^#/, '').toLowerCase();
  return guild.channels.cache.find(
    (c) => (c.id === want || c.name.toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

function findRole(guild, name) {
  if (!name || !guild?.roles?.cache) return null;
  const want = String(name).replace(/^@/, '').toLowerCase();
  return guild.roles.cache.find((r) => r.id === want || r.name.toLowerCase() === want) || null;
}

/**
 * The roles themselves, made if they are not there yet.
 *
 * <p>No permissions and no colour on purpose - see the top of the file. A role that could not be
 * created is one line in the log and the rest are still made: the menu is worth putting up with
 * three buttons out of four, and {@link press} says plainly what happened when somebody presses
 * the fourth.</p>
 *
 * @returns the names of the roles that had to be created
 */
async function ensure(guild, roles, log) {
  const made = [];
  for (const r of roles) {
    if (findRole(guild, r.name)) continue;
    try {
      const role = await guild.roles.create({
        name: r.name,
        permissions: [],
        mentionable: true,      // the whole point: an announcement has to be able to ping it
        hoist: false,           // it is not a rank, so it does not get its own group in the sidebar
        reason: 'a notification role people give themselves',
      });
      made.push(role.name);
      log(`[roles] created "${role.name}"`);
    } catch (e) {
      log(`[roles] could not create "${r.name}": ${e.message}`);
    }
  }
  return made;
}

/**
 * The menu already posted, if it is still where the book says it is.
 *
 * <p>A menu remembered in another channel is left alone: the setting has been changed since, and
 * editing a message in a room the owner has moved on from would put the menu back where they took
 * it away. A message that has been deleted comes back as null and a new one goes up.</p>
 */
async function existing(where) {
  const id = db.get(MESSAGE_KEY);
  if (!id || db.get(CHANNEL_KEY) !== where.id) return null;
  return where.messages.fetch(id).catch(() => null);
}

/**
 * Put the menu up, or bring the one that is already up to date.
 *
 * @param guild        the discord.js Guild
 * @param opts.channel where it goes, if not ROLE_MENU_CHANNEL
 * @returns { url, id, channel, buttons, made, edited }
 */
async function post(guild, { log = console.log, channel } = {}) {
  const all = parse(CONF.menu);
  if (!all.length) {
    log('[roles] ROLE_MENU is empty or unreadable - each entry is key:Role name:emoji');
    return null;
  }
  // An entry that could not be read is not fatal, but nobody would ever find out why their button
  // is missing unless it is said out loud here.
  const skipped = entries(CONF.menu) - all.length;
  if (skipped > 0) {
    log(`[roles] ${skipped} entr${skipped === 1 ? 'y' : 'ies'} in ROLE_MENU could not be read`
      + ' - each one is key:Role name:emoji');
  }
  const roles = all.slice(0, MAX_BUTTONS);
  if (all.length > MAX_BUTTONS) {
    log(`[roles] ${all.length - MAX_BUTTONS} more than the ${MAX_BUTTONS} buttons one message can`
      + ' carry, so the last of them are left off');
  }

  const wanted = channel || CONF.channel;
  const where = findChannel(guild, wanted);
  if (!where) throw new Error(`there is no #${String(wanted).replace(/^#/, '')} in this server`);

  // The role list is normally cached in full. This is the one call where a stale cache would make
  // a second role with the same name, which a human then has to clean up, so it is worth asking.
  if (typeof guild.roles.fetch === 'function') await guild.roles.fetch().catch(() => {});
  const made = await ensure(guild, roles, log);

  const body = { embeds: [card()], components: rows(roles) };
  const old = await existing(where);
  if (old) {
    await old.edit(body);
    log(`[roles] menu brought up to date in #${where.name} - ${roles.length} button(s)`);
    return { url: old.url, id: old.id, channel: where.name, buttons: roles.length, made, edited: true };
  }

  const msg = await where.send(body);
  db.set(MESSAGE_KEY, msg.id);
  db.set(CHANNEL_KEY, where.id);
  db.event('role', 'menu', `posted in #${where.name}, ${roles.length} button(s)`);
  log(`[roles] menu posted in #${where.name} - ${roles.length} button(s)`
    + (made.length ? `, created ${made.join(', ')}` : ''));
  return { url: msg.url, id: msg.id, channel: where.name, buttons: roles.length, made, edited: false };
}

/**
 * Somebody pressed one of the buttons. Pressing it again takes the role back off.
 *
 * <p>The configuration is read again on every press rather than kept from when the menu went up.
 * It costs a few string operations and it means the answer is always the one the settings say
 * today, whether or not anybody has posted the menu since they were changed.</p>
 */
async function press(interaction, log = () => {}) {
  const id = String(interaction.customId ?? '');
  const key = id.startsWith(PREFIX) ? id.slice(PREFIX.length) : '';
  const wanted = parse(CONF.menu).find((r) => r.key === key);
  if (!wanted) {
    return interaction.reply({
      content: 'That button is not one of mine any more.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const guild = interaction.guild;
  const role = findRole(guild, wanted.name);
  if (!role) {
    log(`[roles] there is no "${wanted.name}" role - post the menu again to have it made`);
    return interaction.reply({
      content: `There is no **${wanted.name}** role in this server, so I cannot give it to you.`
        + ' Somebody with the keys will have to put the menu up again.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // The same check bot.js makes before it hands out Dreamer or OG: Discord refuses a role at or
  // above the bot's own highest, and the fix is a drag in Server Settings that only a human can do.
  const me = await guild.members.fetchMe();
  if (role.position >= me.roles.highest.position) {
    log(`[roles] "${role.name}" sits at or above my own highest role`
      + ' - drag mine above it in Server Settings > Roles');
    return interaction.reply({
      content: `I cannot hand out **${role.name}**: it sits above my own highest role.`
        + ' Somebody with the keys will have to drag mine above it in Server Settings > Roles.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const member = interaction.member;
  const had = member.roles.cache.has(role.id);
  try {
    if (had) await member.roles.remove(role, 'asked not to be pinged about it any more');
    else await member.roles.add(role, 'asked to be pinged about it');
  } catch (e) {
    log(`[roles] could not ${had ? 'take' : 'give'} ${interaction.user?.tag} "${role.name}": ${e.message}`);
    return interaction.reply({
      content: `That did not work: ${e.message}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  db.event('role', interaction.user?.tag || 'someone', `${had ? 'off' : 'on'}: ${role.name}`);
  // Counted the way the dashboard counts roles handed out: only on the way in, so the number does
  // not climb when somebody opts back out again.
  if (!had) db.bump('pingRoles');
  log(`[roles] ${interaction.user?.tag || 'somebody'} ${had ? '-' : '+'} ${role.name}`);
  return interaction.reply({
    content: had
      ? `You will not be pinged about **${role.name}** any more.`
      : `You will be pinged about **${role.name}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * The {@code <@&id>} for one of these roles, for the rest of the bot to ping instead of everyone.
 *
 * <p>Empty when there is no such role, and empty is a usable answer on purpose: an announcement
 * template with nothing where the mention goes reads perfectly well, and one with the word
 * "undefined" in it does not. The roles are mentionable, so the ping works without the sender
 * having to be allowed to mention everyone.</p>
 */
function mention(guild, key) {
  const wanted = parse(CONF.menu).find((r) => r.key === String(key ?? '').trim().toLowerCase());
  if (!wanted) return '';
  const role = findRole(guild, wanted.name);
  return role ? `<@&${role.id}>` : '';
}

module.exports = { post, press, mention, parse, CONF };
