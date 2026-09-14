/**
 * Can Sentinel actually do its job in the three suggestion boards?
 *
 * <p>The unit test proves the logic; this proves the permissions, which is the other half and the
 * one no test can see. A channel created with no overwrites of its own inherits its category's, so
 * "public, zero overwrites" is not the same as "the bot can read it" - and a board the bot cannot
 * read is a board that silently never works.</p>
 *
 * <p>Read-only: it logs in, works out what it is allowed to do, prints it, and leaves. Nothing is
 * posted, nothing is reacted to. The token comes in through --env-file and is never printed.</p>
 *
 *   docker run --rm --env-file .env.compose -v $PWD/probe-boards.js:/app/probe-boards.js:ro \
 *     -w /app lovkar-bot:latest node probe-boards.js
 */
'use strict';

const { Client, GatewayIntentBits, PermissionsBitField: P } = require('discord.js');
const sug = require('./suggestions');

const NEED = {
  read: ['ViewChannel', 'ReadMessageHistory'],
  react: ['AddReactions'],
  post: ['SendMessages', 'EmbedLinks'],
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('clientReady', async () => {
  let bad = 0;
  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
    const me = await guild.members.fetchMe();
    console.log(`guild: ${guild.name}\n`);

    const hubWant = sug.mirrorTo();
    console.log(`SUGGESTION_CHANNEL = ${sug.CONF.channels.join(', ')}`);
    console.log(`the hub             = ${hubWant || '(announcements off)'}\n`);

    for (const want of sug.CONF.channels) {
      const c = guild.channels.cache.find(
        (x) => x.id === want || String(x.name || '').toLowerCase() === want.toLowerCase());
      if (!c) { console.log(`MISSING  #${want}`); bad++; continue; }

      const perms = c.permissionsFor(me);
      const isHub = hubWant && (c.id === hubWant || c.name.toLowerCase() === String(hubWant).toLowerCase());
      const wanted = [...NEED.read, ...NEED.react, ...(isHub ? NEED.post : [])];
      const missing = wanted.filter((p) => !perms.has(P.Flags[p]));

      console.log(`${missing.length ? 'NOT OK  ' : 'ok      '}#${c.name}  (${c.id})`
        + `  in ${c.parent ? c.parent.name : 'no category'}${isHub ? '  [hub]' : ''}`);
      console.log(`         ${wanted.map((p) => (perms.has(P.Flags[p]) ? '+' : '-') + p).join('  ')}`);
      if (c.topic) console.log(`         topic: ${c.topic}`);
      const overwrites = c.permissionOverwrites?.cache?.size ?? 0;
      console.log(`         ${overwrites} overwrite(s) of its own, `
        + `${c.parent?.permissionOverwrites?.cache?.size ?? 0} on the category`);
      if (missing.length) { console.log(`         MISSING: ${missing.join(', ')}`); bad++; }
      console.log();
    }
  } catch (e) {
    console.log('probe failed: ' + e.message);
    bad++;
  }
  console.log(bad ? `${bad} board(s) not ready` : 'every board is readable, reactable, and the hub can post');
  await client.destroy();
  process.exit(bad ? 1 : 0);
});

client.login(process.env.DISCORD_TOKEN);
