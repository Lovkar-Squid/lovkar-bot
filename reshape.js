/**
 * One-off: open #sneak-peek to everyone, and make #behind-the-scenes the thing a boost buys.
 *
 * The Patreon tiers are parked, so the roles that used to gate these channels have nobody in
 * them - which left #sneak-peek visible to precisely no one. So: sneak-peek goes public, and the
 * deeper material behind the scenes becomes the boost perk instead. The old tier overwrites are
 * left in place on purpose: they grant nothing while the roles are empty, and they are what comes
 * back if the Patreon ever does.
 */
'use strict';

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const F = PermissionsBitField.Flags;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const TOPICS = {
  'sneak-peek':
    'Work on the next version, before it is out. Nothing here is final and some of it will not ship.',
  'behind-the-scenes':
    'How it is actually made: notes, failed attempts and things read straight out of the save. Boost the server and this opens for you.',
};

async function show(ch, g) {
  const rows = [];
  for (const [id, ow] of ch.permissionOverwrites.cache) {
    const who = g.roles.cache.get(id)?.name ?? `member:${id}`;
    rows.push(`      ${who} | allow: ${ow.allow.toArray().join(',') || '-'} | deny: ${ow.deny.toArray().join(',') || '-'}`);
  }
  console.log(`   #${ch.name}\n${rows.join('\n') || '      (none)'}`);
}

client.once('clientReady', async (c) => {
  try {
    const g = c.guilds.cache.first();
    const me = await g.members.fetchMe();

    // ---- 1. sneak-peek: open it -------------------------------------------------------------
    const sneak = g.channels.cache.find((x) => x.name === 'sneak-peek');
    if (sneak) {
      await sneak.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: null },
        { reason: 'sneak peeks are for everybody now' });
      await sneak.setTopic(TOPICS['sneak-peek'], 'no longer boost-gated');
      console.log('#sneak-peek: opened to @everyone, topic updated');
    } else {
      console.log('#sneak-peek: missing');
    }

    // ---- 2. behind-the-scenes: this is what a boost buys now ---------------------------------
    const bts = g.channels.cache.find((x) => x.name === 'behind-the-scenes');
    if (bts) {
      // the bot needs sight of it to keep the booster permissions up to date later
      try {
        await bts.permissionOverwrites.edit(me.id,
          { ViewChannel: true, SendMessages: true, AttachFiles: true, ReadMessageHistory: true },
          { reason: 'so the boost permissions can be kept up to date here' });
        console.log('#behind-the-scenes: granted the bot sight of it');
      } catch (e) {
        console.log('#behind-the-scenes: could not grant myself sight: ' + e.message);
      }
      try {
        await bts.setTopic(TOPICS['behind-the-scenes'], 'the boost perk, not the Patreon tiers');
        console.log('#behind-the-scenes: topic updated');
      } catch (e) {
        console.log('#behind-the-scenes: could not set the topic: ' + e.message);
      }
    } else {
      console.log('#behind-the-scenes: missing');
    }

    // ---- 3. what it looks like now -----------------------------------------------------------
    console.log('\n   how they stand:');
    for (const name of ['sneak-peek', 'behind-the-scenes', 'dev-builds']) {
      const ch = await g.channels.fetch(
        g.channels.cache.find((x) => x.name === name)?.id, { force: true }).catch(() => null);
      if (ch) await show(ch, g);
    }
    const ev = g.roles.everyone;
    const s2 = g.channels.cache.find((x) => x.name === 'sneak-peek');
    console.log('\n   @everyone can see #sneak-peek:',
      s2 ? s2.permissionsFor(ev).has(F.ViewChannel) : '?');
  } catch (e) {
    console.log('FAILED:', e.message);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
