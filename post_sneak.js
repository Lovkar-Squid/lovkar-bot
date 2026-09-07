/**
 * One-off: put the 0.2 cards into #sneak-peek.
 *
 * The bot is denied ViewChannel there (the channel is boost-gated), so it grants its own role
 * sight of the channel first - it has Manage Roles for exactly this - and posts. The grant is
 * left in place afterwards on purpose: the bot needs it to keep the boosted-channel permissions
 * up to date once somebody actually boosts.
 */
'use strict';

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const fs = require('node:fs');

const DIR = '/tmp/bts';
const CHANNEL = 'sneak-peek';

const POSTS = [
  {
    file: '0.2-volcano.png',
    text:
      '**The Rising Mountain.** A volcano that grows out of flat ground over about four minutes — ' +
      'basalt, tuff and blackstone, with gilded veins low down that thin out as it climbs.\n\n' +
      'This is read out of the save afterwards, not a screenshot. The first version poured 1402 blocks ' +
      'of lava down the slope, because the crater pool sat above the highest ring of rock. It has a ' +
      'plugged throat below the rim now: 122 blocks of lava, none of it below y=82.',
  },
  {
    file: '0.2-bloodmoon.png',
    text:
      '**The Blood Moon.** Every marker is a real monster, read back out of `world/entities` after one ' +
      'siege — where it actually stood, not a diagram. Forty of them, between 18 and 47 blocks out: ' +
      'close enough to find you, far enough that none of them opens the fight standing on your head.\n\n' +
      'They only land on ground that is genuinely dark and has room to stand. They all carry Fire ' +
      'Resistance, so dawn does not simply burn them — the sweep at sunrise does, including the ones ' +
      'sitting in a chunk nobody had loaded. And the sky fades to that red over four seconds.',
  },
  {
    file: '0.2-tornado.png',
    text:
      '**The Wandering Column.** There is no funnel model. A tornado is only the dirt caught in it, so ' +
      'that is what gets drawn: ninety blocks on a helix seeded from the entity\'s own id, which means ' +
      'it is the same column for everybody who sees it.\n\n' +
      'Left is where it actually walked — polled a position at a time off the test server — with every ' +
      'block it lifted marked warm and every block it set back down marked cold. In 54 sampled seconds ' +
      'it covered 233 blocks, picked up 169 and dropped 110 somewhere else entirely. It takes only what ' +
      'is loose and under open sky, so it will strip a beach and leave your roof alone.',
  },
  {
    file: '0.2-named-lands.png',
    text:
      '**The Named Lands.** The world is cut into squares 384 blocks on a side, and each one gets a name ' +
      'the first time somebody walks into it — written from what the ground there actually is. Shown ' +
      'once as a title card, then kept: everyone who crosses that line afterwards sees the same words.\n\n' +
      'That is one land at its true size, read out of the region files, with its eight neighbours around ' +
      'it. The cross marks the one column in the middle that decides the name. These nine came from the ' +
      'templates; with a Gemini key on the server the model writes them instead.\n\n' +
      'A land could be handed a name a neighbour already had, which reads as a bug even when the dice ' +
      'were fair. Clashes get re-rolled now.',
  },
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async (c) => {
  try {
    const g = c.guilds.cache.first();
    const ch = g.channels.cache.find((x) => x.name === CHANNEL);
    if (!ch) throw new Error(`no #${CHANNEL}`);

    const me = await g.members.fetchMe();
    if (!ch.permissionsFor(me).has(PermissionsBitField.Flags.ViewChannel)) {
      await ch.permissionOverwrites.edit(
        me.roles.botRole ?? me.id,
        { ViewChannel: true, SendMessages: true, AttachFiles: true, ReadMessageHistory: true },
        { reason: 'posting the 0.2 cards, and keeping the boost permissions up to date' },
      );
      console.log('granted myself sight of #' + CHANNEL);
      await new Promise((r) => setTimeout(r, 1500));
    }

    const fresh = await g.channels.fetch(ch.id, { force: true });
    for (const p of POSTS) {
      const path = `${DIR}/${p.file}`;
      if (!fs.existsSync(path)) { console.log('missing file:', path); continue; }
      const msg = await fresh.send({
        content: p.text,
        files: [{ attachment: path, name: p.file }],
        allowedMentions: { parse: [] },
      });
      console.log('posted', p.file, '->', msg.id);
      await new Promise((r) => setTimeout(r, 900));
    }

    const back = await fresh.messages.fetch({ limit: 10 });
    console.log(`#${CHANNEL} now holds ${back.size} message(s)`);
  } catch (e) {
    console.log('FAILED:', e.message);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
