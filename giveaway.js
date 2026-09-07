/**
 * Run a giveaway from the command line, for when nobody is at the dashboard.
 *
 *   docker exec lovkar-bot node giveaway.js start "A copy of the modpack" 24h
 *   docker exec lovkar-bot node giveaway.js start "Early access" 3d 2 sneak-peek "Server Booster"
 *   docker exec lovkar-bot node giveaway.js list
 *   docker exec lovkar-bot node giveaway.js end    <id>
 *   docker exec lovkar-bot node giveaway.js reroll <id> [how many]
 *   docker exec lovkar-bot node giveaway.js cancel <id>
 *
 * It shares the book with the bot that is already running, so the button, the countdown and the
 * draw are all handled by that one - this only writes the row and posts the message, then leaves.
 */

'use strict';

const { Client, GatewayIntentBits } = require('discord.js');
const db = require('./db');
const giveaways = require('./giveaways');

const [what, ...rest] = process.argv.slice(2);
const USAGE = `usage:
  node giveaway.js start "<prize>" <how long> [winners] [channel] [role]
  node giveaway.js list
  node giveaway.js end|cancel <id>
  node giveaway.js reroll <id> [how many]`;

if (!['start', 'list', 'end', 'cancel', 'reroll'].includes(what)) {
  console.error(USAGE);
  process.exit(2);
}

db.open(console.log);
if (!db.ready) {
  console.error('there is no book, so there can be no giveaway: ' + db.why);
  process.exit(1);
}

// `list` needs nothing from Discord at all.
if (what === 'list') {
  const rows = giveaways.list(50);
  if (!rows.length) console.log('none yet');
  for (const g of rows) {
    const when = g.state === 'running'
      ? `ends in ${giveaways.left(g.ends - Date.now())}`
      : `${g.state} ${giveaways.left(Date.now() - (g.ended_at || g.ends))} ago`;
    console.log(`${g.id}  ${String(g.state).padEnd(9)} ${String(g.entries).padStart(4)} entries  `
      + `${when.padEnd(20)} ${g.prize}`);
  }
  process.exit(0);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async (c) => {
  try {
    const guild = process.env.GUILD_ID ? c.guilds.cache.get(process.env.GUILD_ID) : c.guilds.cache.first();
    if (!guild) throw new Error('the bot is in no guild');

    if (what === 'start') {
      const [prize, lasts, winners, channel, role] = rest;
      if (!prize || !lasts) throw new Error(USAGE);
      const out = await giveaways.start(guild, { prize, lasts, winners, channel, role, host: 'the terminal' },
        console.log);
      console.log(out.url);
      console.log(`id ${out.id} - it ends in ${giveaways.left(out.ends - Date.now())}`);
    } else if (what === 'end') {
      const out = await giveaways.finish(c, rest[0], console.log, 'ended from the terminal');
      if (!out) throw new Error('that one is not running');
      console.log(out.winners.length ? `won by ${out.winners.join(', ')}` : 'nobody entered');
    } else if (what === 'cancel') {
      await giveaways.cancel(c, rest[0], console.log);
      console.log('called off');
    } else if (what === 'reroll') {
      const more = await giveaways.reroll(c, rest[0], Number(rest[1]) || 1, console.log);
      console.log(`redrawn: ${more.join(', ')}`);
    }
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);
