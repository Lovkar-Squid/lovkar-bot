/**
 * The one thing the unit test cannot prove: that an announcement actually posts, renders and pings.
 *
 * <p>It needs a real message from a real person, and the only ones in the server are in channels
 * everybody reads - so this posts the announcement into a staff-only channel instead of the hub.
 * Same code path, same message, no footprint anywhere the community can see.</p>
 *
 * <p>First it lists what @everyone cannot see, so there is something to aim at. Pass a channel id
 * as the first argument to actually post; with no argument it only lists and leaves.</p>
 */
'use strict';

const { Client, GatewayIntentBits, PermissionsBitField: P } = require('discord.js');
const sug = require('./suggestions');

const target = process.argv[2] || null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('clientReady', async () => {
  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
    const everyone = guild.roles.everyone;

    if (!target) {
      console.log('channels @everyone cannot see:\n');
      for (const c of guild.channels.cache.values()) {
        if (typeof c.send !== 'function') continue;
        if (c.permissionsFor(everyone)?.has(P.Flags.ViewChannel)) continue;
        console.log(`  ${c.id}  #${c.name}  (${c.parent ? c.parent.name : 'no category'})`);
      }
      console.log('\npass one of those ids to post a real announcement into it');
      await client.destroy();
      process.exit(0);
    }

    const to = guild.channels.cache.get(target);
    if (!to) { console.log('no such channel'); await client.destroy(); process.exit(1); }

    // A real message by a real person, from one of the boards, fetched off Discord - not a fake.
    let found = null;
    for (const name of sug.CONF.channels) {
      const board = guild.channels.cache.find(
        (x) => x.id === name || String(x.name || '').toLowerCase() === name.toLowerCase());
      if (!board || typeof board.messages?.fetch !== 'function') continue;
      const recent = await board.messages.fetch({ limit: 50 }).catch(() => null);
      const hit = recent?.find((m) => !m.author?.bot && (m.content || m.attachments?.size));
      if (hit) { found = hit; break; }
    }
    // Nobody has posted in a board yet, so borrow a real message from wherever people do talk.
    // The channel it names will be that one rather than a board, which is the one thing this probe
    // cannot borrow - and the one thing the unit test already covers.
    if (!found) {
      console.log('no board has a human message yet - borrowing one from elsewhere\n');
      for (const c of guild.channels.cache.values()) {
        if (typeof c.messages?.fetch !== 'function') continue;
        if (!c.permissionsFor(guild.members.me)?.has(P.Flags.ReadMessageHistory)) continue;
        const recent = await c.messages.fetch({ limit: 20 }).catch(() => null);
        const hit = recent?.find((m) => !m.author?.bot && String(m.content || '').length >= 12);
        if (hit) { found = hit; break; }
      }
    }
    if (!found) { console.log('nobody has posted anything anywhere - nothing real to announce'); await client.destroy(); process.exit(1); }

    console.log(`announcing a real message by ${found.author.tag} from #${found.channel.name}`);
    console.log(`into #${to.name}\n`);

    // Stand in for what start() found, so announce() posts where this test can see it.
    sug.live.hub = to;
    const ok = await sug.announce(found, (m) => console.log('  ' + m));
    console.log('\nannounce() returned ' + ok);

    const posted = (await to.messages.fetch({ limit: 1 })).first();
    console.log('\nwhat landed, as Discord has it:\n');
    console.log(posted.content.split('\n').map((l) => '  | ' + l).join('\n'));
    console.log(`\n  mentions: ${posted.mentions.users.map((u) => u.tag).join(', ') || 'nobody'}`);
    console.log(`  pinged everyone: ${posted.mentions.everyone}`);
    console.log(`  roles pinged: ${posted.mentions.roles.size}`);
  } catch (e) {
    console.log('probe failed: ' + e.message);
  }
  await client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
