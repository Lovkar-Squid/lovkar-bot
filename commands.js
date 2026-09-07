/**
 * The slash commands: everything the bot can do, from inside Discord.
 *
 * <p>Until now the bot was driven from the dashboard or from a terminal, which is fine for the
 * person who owns the server and no use at all to anybody else in it. These are the same actions
 * with a door in Discord: {@code /giveaway}, {@code /poll}, {@code /pack}, {@code /queue},
 * {@code /roles}, {@code /version} for whoever runs the place, and {@code /bug} for everyone.</p>
 *
 * <p>They are registered per-guild rather than globally, because a guild command appears the
 * moment it is written and a global one takes an hour - and this bot lives in one server.</p>
 *
 * <p>Nothing here decides anything: every command hands straight over to the module that already
 * owns that job, so the dashboard, the terminal and Discord cannot drift apart.</p>
 */

'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ChannelType,
} = require('discord.js');

const db = require('./db');
const giveaways = require('./giveaways');
const polls = require('./polls');
const packs = require('./packs');
const queue = require('./queue');
const rolemenu = require('./rolemenu');
const releases = require('./releases');

const STAFF = PermissionFlagsBits.ManageGuild;
const BUG_FORUM = process.env.BUG_FORUM_NAME || 'bug-reports';

/** What the bot is. Bumped by hand, and printed by {@code /version}. */
const VERSION = process.env.BOT_VERSION || '1.3';

// ---- the commands themselves -------------------------------------------------------------------

function definitions() {
  const gw = new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run a giveaway')
    .setDefaultMemberPermissions(STAFF)
    .addSubcommand((s) => s
      .setName('start').setDescription('Start one')
      .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('for').setDescription('How long: 30m, 2h, 3d').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('How many win').setMinValue(1).setMaxValue(giveaways.MAX_WINNERS))
      .addChannelOption((o) => o.setName('channel').setDescription('Where it goes').addChannelTypes(ChannelType.GuildText))
      .addRoleOption((o) => o.setName('role').setDescription('Only this role may enter')))
    .addSubcommand((s) => s.setName('end').setDescription('End one now and draw it')
      .addStringOption((o) => o.setName('id').setDescription('Which one').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Draw another name')
      .addStringOption((o) => o.setName('id').setDescription('Which one').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('how_many').setDescription('How many more').setMinValue(1).setMaxValue(10)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Call one off; nobody wins')
      .addStringOption((o) => o.setName('id').setDescription('Which one').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('What has been run'));

  const poll = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Ask the server something')
    .setDefaultMemberPermissions(STAFF)
    .addSubcommand((s) => s
      .setName('ask').setDescription('Ask a question')
      .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(polls.MAX_QUESTION))
      .addStringOption((o) => o.setName('answers').setDescription('Separated by | - up to ten').setRequired(true))
      .addStringOption((o) => o.setName('who').setDescription('Who is being asked')
        .addChoices({ name: 'Supporters', value: 'supporters' }, { name: 'Everyone', value: 'public' }))
      .addIntegerOption((o) => o.setName('hours').setDescription('How long it runs').setMinValue(polls.MIN_HOURS).setMaxValue(polls.MAX_HOURS))
      .addBooleanOption((o) => o.setName('multi').setDescription('May people pick more than one'))
      .addChannelOption((o) => o.setName('channel').setDescription('Somewhere else').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('close').setDescription('Close one early')
      .addStringOption((o) => o.setName('id').setDescription('The message id').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('What has been asked'));

  const pack = new SlashCommandBuilder()
    .setName('pack')
    .setDescription('Post a sneak peek or a behind-the-scenes set')
    .setDefaultMemberPermissions(STAFF)
    .addStringOption((o) => o.setName('kind').setDescription('Which pack').setRequired(true)
      .addChoices(...packs.kinds().map((k) => ({ name: packs.about(k).label, value: k }))))
    .addAttachmentOption((o) => o.setName('picture').setDescription('The first one').setRequired(true))
    .addStringOption((o) => o.setName('caption').setDescription('What to say above them'))
    .addBooleanOption((o) => o.setName('queue').setDescription('Put it in the queue instead of posting it now'))
    .addAttachmentOption((o) => o.setName('picture2').setDescription('Another'))
    .addAttachmentOption((o) => o.setName('picture3').setDescription('Another'))
    .addAttachmentOption((o) => o.setName('picture4').setDescription('Another'))
    .addAttachmentOption((o) => o.setName('picture5').setDescription('Another'));

  const q = new SlashCommandBuilder()
    .setName('queue')
    .setDescription('The pictures waiting to go out')
    .setDefaultMemberPermissions(STAFF)
    .addSubcommand((s) => s.setName('list').setDescription('What is waiting'))
    .addSubcommand((s) => s.setName('now').setDescription('Post the next one straight away'))
    .addSubcommand((s) => s.setName('drop').setDescription('Take one back out')
      .addIntegerOption((o) => o.setName('id').setDescription('Which one').setRequired(true)));

  const roles = new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Put up the "ping me about" menu')
    .setDefaultMemberPermissions(STAFF)
    .addChannelOption((o) => o.setName('channel').setDescription('Where it goes').addChannelTypes(ChannelType.GuildText));

  const version = new SlashCommandBuilder()
    .setName('version')
    .setDescription('What the bot and the mods are on');

  const bug = new SlashCommandBuilder()
    .setName('bug')
    .setDescription('Report a bug - it asks for everything needed, so nothing comes back for more');

  return [gw, poll, pack, q, roles, version, bug].map((c) => c.toJSON());
}

/** Put them up. Guild commands appear at once, which is why they are not global. */
async function register(guild, log = () => {}) {
  const made = await guild.commands.set(definitions());
  log(`[commands] ${made.size} slash command(s) up in ${guild.name}: `
    + [...made.values()].map((c) => '/' + c.name).sort().join(', '));
  return made;
}

// ---- helpers -----------------------------------------------------------------------------------

const quietly = (interaction, content) =>
  (interaction.deferred || interaction.replied
    ? interaction.editReply({ content })
    : interaction.reply({ content, flags: MessageFlags.Ephemeral }));

/** Pull the attachments off a /pack, in the order they were given. */
async function attachments(interaction) {
  const out = [];
  for (const name of ['picture', 'picture2', 'picture3', 'picture4', 'picture5']) {
    const a = interaction.options.getAttachment(name);
    if (!a) continue;
    if (a.size > packs.MAX_BYTES) throw new Error(`${a.name} is bigger than ${packs.MAX_BYTES / 1048576} MB`);
    const res = await fetch(a.url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`could not fetch ${a.name}: ${res.status}`);
    out.push({ name: a.name, data: Buffer.from(await res.arrayBuffer()) });
  }
  return out;
}

// ---- /bug: the wizard --------------------------------------------------------------------------

const BUG_MODAL = 'bug:report';

function bugModal() {
  const field = (id, label, style, placeholder, required = true, max = 1000) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
        .setPlaceholder(placeholder).setRequired(required).setMaxLength(max));

  return new ModalBuilder().setCustomId(BUG_MODAL).setTitle('Report a bug')
    .addComponents(
      field('title', 'In one line, what is wrong?', TextInputStyle.Short, 'The game crashes when a tornado reaches a village', true, 100),
      field('what', 'What happens, and what should happen?', TextInputStyle.Paragraph, 'Tell me what you did, what you saw, and what you expected.'),
      field('version', 'Which version of the mod?', TextInputStyle.Short, '0.2.0-alpha.9', true, 40),
      field('loader', 'Which NeoForge / Forge / Fabric version?', TextInputStyle.Short, 'NeoForge 21.1.248', true, 60),
      field('mods', 'Other mods, if it might matter', TextInputStyle.Paragraph, 'A modpack name is enough. Leave it empty if it is just this mod.', false),
    );
}

/** Turn a filled-in modal into a post in the bug forum, which the triage then tags as usual. */
async function bugPost(interaction, log) {
  const get = (id) => interaction.fields.getTextInputValue(id).trim();
  const guild = interaction.guild;
  const forum = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildForum && c.name.toLowerCase() === BUG_FORUM.toLowerCase());
  if (!forum) return quietly(interaction, `There is no #${BUG_FORUM} in this server, so I have nowhere to put it.`);

  const body = [
    get('what'),
    '',
    `**Mod version:** ${get('version')}`,
    `**Loader:** ${get('loader')}`,
    get('mods') ? `**Other mods:** ${get('mods')}` : '',
    '',
    `-# Reported by ${interaction.user} with /bug.`,
  ].filter((l) => l !== null).join('\n');

  const thread = await forum.threads.create({
    name: get('title').slice(0, 100),
    message: { content: body.slice(0, 1900), allowedMentions: { parse: [] } },
    reason: `/bug by ${interaction.user.tag}`,
  });
  db.event('bug', interaction.user.tag, get('title'));
  db.bump('bugsFiled');
  log(`[bug] ${interaction.user.tag} filed "${get('title')}" -> ${thread.url}`);
  return quietly(interaction,
    `Thank you — it is up as ${thread.url}\n`
    + 'If you have a `latest.log` or a crash report, drag the file into that post; it is usually what decides how fast it gets fixed.');
}

// ---- the dispatcher ----------------------------------------------------------------------------

/**
 * One entry point for every interaction that is not a giveaway button.
 *
 * @returns true when this module dealt with it
 */
async function handle(interaction, { log = () => {} } = {}) {
  try {
    if (interaction.isAutocomplete()) return autocomplete(interaction);
    if (interaction.isModalSubmit()) {
      if (interaction.customId !== BUG_MODAL) return false;
      await bugPost(interaction, log);
      return true;
    }
    if (!interaction.isChatInputCommand()) return false;

    const name = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);
    const who = interaction.user.tag;

    if (name === 'bug') {
      await interaction.showModal(bugModal());
      return true;
    }

    if (name === 'version') {
      const seen = db.releases(3);
      const e = new EmbedBuilder().setColor(0xe2b24a).setTitle('Sentinel').setDescription(
        [`Bot **${VERSION}**, up for ${Math.floor(process.uptime() / 3600)}h.`,
          db.ready ? `The book is at \`${db.where}\`.` : 'No book — nothing is being remembered.',
          seen.length ? '' : null,
          ...seen.map((r) => `**${r.name || r.project}** ${r.version || ''} — ${r.source}`),
        ].filter((l) => l !== null).join('\n'));
      await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
      return true;
    }

    // everything below writes something, and can take a moment
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (name === 'giveaway') {
      if (sub === 'start') {
        const out = await giveaways.start(interaction.guild, {
          prize: interaction.options.getString('prize'),
          lasts: interaction.options.getString('for'),
          winners: interaction.options.getInteger('winners'),
          channel: interaction.options.getChannel('channel')?.id,
          role: interaction.options.getRole('role')?.id,
          host: who,
        }, log);
        return quietly(interaction, `It is up in #${out.channel}: ${out.url}`);
      }
      if (sub === 'end') {
        const out = await giveaways.finish(interaction.client, interaction.options.getString('id'), log, `ended by ${who}`);
        if (!out) return quietly(interaction, 'That one is not running.');
        return quietly(interaction, out.winners.length
          ? `Drawn: ${out.winners.map((w) => `<@${w}>`).join(', ')}`
          : 'Nobody entered, so nobody won.');
      }
      if (sub === 'reroll') {
        const more = await giveaways.reroll(interaction.client, interaction.options.getString('id'),
          interaction.options.getInteger('how_many') || 1, log);
        return quietly(interaction, `Redrawn: ${more.map((w) => `<@${w}>`).join(', ')}`);
      }
      if (sub === 'cancel') {
        await giveaways.cancel(interaction.client, interaction.options.getString('id'), log);
        return quietly(interaction, 'Called off.');
      }
      if (sub === 'list') {
        const rows = giveaways.list(10);
        return quietly(interaction, rows.length
          ? rows.map((g) => `\`${g.id}\`  **${g.prize}** — ${g.state}, ${g.entries} entries`
            + (g.won?.length ? `, won by ${g.won.map((w) => w.tag || w.id).join(', ')}` : '')).join('\n')
          : 'None yet.');
      }
    }

    if (name === 'poll') {
      if (sub === 'ask') {
        const out = await polls.ask(interaction.guild, {
          kind: interaction.options.getString('who') || 'public',
          question: interaction.options.getString('question'),
          answers: interaction.options.getString('answers'),
          hours: interaction.options.getInteger('hours'),
          multi: interaction.options.getBoolean('multi'),
          channel: interaction.options.getChannel('channel')?.id,
          host: who,
        }, log);
        return quietly(interaction, `Asked in #${out.channel}: ${out.url}`);
      }
      if (sub === 'close') {
        const said = await polls.close(interaction.client, interaction.options.getString('id'), log);
        return quietly(interaction, said.map((s) => `**${s.text}** ${s.votes}`).join('\n') || 'Nobody voted.');
      }
      if (sub === 'list') {
        const rows = polls.list(10);
        return quietly(interaction, rows.length
          ? rows.map((p) => `\`${p.id}\`  **${p.question}** — ${p.kind}`
            + (p.result ? `: ${p.result.map((r) => `${r.text} ${r.votes}`).join(', ')}` : ', still open')).join('\n')
          : 'None yet.');
      }
    }

    if (name === 'pack') {
      const kind = interaction.options.getString('kind');
      const caption = interaction.options.getString('caption') || '';
      const files = await attachments(interaction);
      if (interaction.options.getBoolean('queue')) {
        const out = queue.add(kind, files, { caption, who, log });
        return quietly(interaction, `In the queue — ${out.waiting} picture(s) waiting.`);
      }
      const out = await packs.post(interaction.guild, kind, files, caption, who, log);
      return quietly(interaction, `Posted ${out.files} to #${out.channel}: ${out.urls[0]}`);
    }

    if (name === 'queue') {
      if (sub === 'list') {
        const rows = queue.list(20).filter((r) => !r.posted_at);
        return quietly(interaction, rows.length
          ? rows.map((r) => `\`${r.id}\`  ${r.name} — ${r.kind}, due <t:${Math.floor((r.due || 0) / 1000)}:R>`).join('\n')
          : 'The queue is empty.');
      }
      if (sub === 'now') {
        const out = await queue.tick(interaction.guild, { log, force: true });
        return quietly(interaction, out ? `Posted ${out.name} to #${out.channel}.` : 'There is nothing waiting.');
      }
      if (sub === 'drop') {
        const out = queue.drop(interaction.options.getInteger('id'), log);
        return quietly(interaction, `${out.name} is out of the queue.`);
      }
    }

    if (name === 'roles') {
      const out = await rolemenu.post(interaction.guild, {
        log, channel: interaction.options.getChannel('channel')?.name,
      });
      if (!out) return quietly(interaction, 'No role menu is configured (ROLE_MENU is empty).');
      return quietly(interaction, `${out.edited ? 'Updated' : 'Put up'} the menu: ${out.url}`
        + (out.made?.length ? `\nMade the role(s): ${out.made.join(', ')}` : ''));
    }

    return quietly(interaction, 'I do not know that one.');
  } catch (e) {
    log(`[commands] /${interaction.commandName ?? '?'}: ${e.message}`);
    try {
      await quietly(interaction, e.message);
    } catch { /* the interaction has already gone */ }
    return true;
  }
}

/** The id fields on /giveaway take a name rather than a hex string. */
async function autocomplete(interaction) {
  if (interaction.commandName !== 'giveaway') return false;
  const wanted = String(interaction.options.getFocused() || '').toLowerCase();
  const sub = interaction.options.getSubcommand(false);
  const rows = giveaways.list(25)
    .filter((g) => (sub === 'end' || sub === 'cancel' ? g.state === 'running' : g.state !== 'running'))
    .filter((g) => !wanted || g.prize.toLowerCase().includes(wanted) || g.id.includes(wanted))
    .slice(0, 25)
    .map((g) => ({ name: `${g.prize} (${g.entries} entries)`.slice(0, 100), value: g.id }));
  await interaction.respond(rows).catch(() => {});
  return true;
}

module.exports = { register, handle, definitions, bugModal, VERSION, BUG_MODAL, attachments };
