/**
 * Post a pack from the command line, for when the pictures are already on the server.
 *
 *   docker exec lovkar-bot node pack.js sneak "The tornado finally has a body." /tmp/pack/*.png
 *   docker exec lovkar-bot node pack.js bts   "How the funnel is built."       /tmp/pack/tex.jpg
 *
 * It logs in, posts, prints the message links and exits. Marko uses the dashboard's Packs page
 * for the same thing; this is the door for whoever is at a terminal - which is usually me, right
 * after making something worth showing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const packs = require('./packs');

const [kind, caption, ...paths] = process.argv.slice(2);

if (!kind || !packs.about(kind) || !paths.length) {
  console.error(`usage: node pack.js <${packs.kinds().join('|')}> "<caption>" <file> [file...]`);
  console.error('the caption may be an empty string; the pack then says its own line');
  process.exit(2);
}

const files = paths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) }));
const total = files.reduce((n, f) => n + f.data.length, 0);
console.log(`${files.length} file(s), ${(total / 1048576).toFixed(1)} MB -> ${packs.about(kind).channel}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async (c) => {
  try {
    const guild = process.env.GUILD_ID ? c.guilds.cache.get(process.env.GUILD_ID) : c.guilds.cache.first();
    if (!guild) throw new Error('the bot is in no guild');
    const out = await packs.post(guild, kind, files, caption, 'the terminal', console.log);
    for (const u of out.urls) console.log(u);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);
