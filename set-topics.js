/**
 * The three board topics, rewritten now that they are one board in three rooms.
 *
 * <p>A #name written in a topic is plain text and does not link, which is no use when the whole
 * point of the sentence is "go there instead" - so every #name below is turned into the channel's
 * real mention before it is sent, and a name that matches nothing stops the run rather than
 * quietly posting a topic that says #ideas-and-feeback.</p>
 *
 * <p>Prints what would change and changes nothing unless --write is passed.</p>
 */
'use strict';

const { Client, GatewayIntentBits } = require('discord.js');

const WRITE = process.argv.includes('--write');

const TOPICS = {
  'ideas-and-feedback':
    'Every idea in one place. Post here if it spans more than one of them, or put it in '
    + '#waking-world-ideas or #addon-ideas and it turns up here by itself, with your name on it. '
    + 'Say what the idea is FOR (what it would let you do), not only what to add. '
    + '\u{1F44D} / \u{1F44E} go on the original, and the best of the week are rounded up here. '
    + 'Colossus and Titan patrons vote on the big ones in #polls; anything I take goes into '
    + '#changelog with your name if you want it there.',

  'waking-world-ideas':
    'Ideas and wishes for The Waking World - a colossus you want to see, a rite, a cataclysm, '
    + 'something a kingdom should do. One idea per message and it gets its own \u{1F44D} / \u{1F44E} '
    + 'by itself. Everything posted here also shows up in #ideas-and-feedback so it is not missed, '
    + 'and the best of the week are rounded up there. '
    + 'Something broken instead? That goes to #bug-reports.',

  'addon-ideas':
    'Ideas and wishes for the MineColonies addons - Colonist Errands, Voyager, Colonist Thieves, '
    + 'Colonies at War and the modpack. One idea per message and it gets its own \u{1F44D} / \u{1F44E} '
    + 'by itself. Everything posted here also shows up in #ideas-and-feedback so it is not missed, '
    + 'and the best of the week are rounded up there. '
    + 'Something broken instead? That goes to #bug-reports.',
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  let bad = 0;
  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
    const byName = (n) => guild.channels.cache.find(
      (c) => String(c.name || '').toLowerCase() === n.toLowerCase());

    for (const [name, raw] of Object.entries(TOPICS)) {
      const channel = byName(name);
      if (!channel) { console.log(`MISSING  #${name}`); bad++; continue; }

      let stop = false;
      const topic = raw.replace(/#([a-z0-9-]+)/g, (whole, n) => {
        const c = byName(n);
        if (!c) { console.log(`  #${n} does not exist - not touching #${name}`); stop = true; bad++; return whole; }
        return `<#${c.id}>`;
      });
      if (stop) continue;
      if (topic.length > 1024) { console.log(`  too long for #${name}: ${topic.length}`); bad++; continue; }

      if (channel.topic === topic) { console.log(`unchanged  #${name}`); continue; }
      console.log(`${WRITE ? 'setting   ' : 'would set '} #${name}  (${topic.length} chars)`);
      console.log(`  was: ${channel.topic || '(none)'}`);
      console.log(`  now: ${topic}\n`);
      if (WRITE) await channel.setTopic(topic, 'the ideas boards now feed the hub');
    }
  } catch (e) {
    console.log('failed: ' + e.message);
    bad++;
  }
  console.log(bad ? `${bad} problem(s)` : (WRITE ? 'topics set' : 'dry run - nothing changed; pass --write'));
  await client.destroy();
  process.exit(bad ? 1 : 0);
});

client.login(process.env.DISCORD_TOKEN);
