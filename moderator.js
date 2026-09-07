/**
 * One-off: a Moderator role, and the broadcast channels locked to Lovkar and the bot.
 *
 * <p>The moderator set is deliberately the conservative one: enough to actually keep a room in
 * order - delete a message, time somebody out, kick, tidy threads, read the audit log - and
 * nothing that lets a moderator reshape the server. Ban, roles and channels stay with the owner.
 * Each of those is one toggle away in Server Settings if that turns out to be too tight.</p>
 *
 * <p>Locking a channel means denying @everyone the four ways of writing into it (messages,
 * threads, and messages inside threads) and then allowing the bot back in explicitly - otherwise
 * the deny catches Sentinel too, and it needs to post the joins. The owner bypasses overwrites
 * entirely, but the Lovkar role is allowed as well so the channels stay writable for him even if
 * he ever hands the server over.</p>
 */
'use strict';

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const F = PermissionsBitField.Flags;
const MOD_ROLE = 'Moderator';

// What a moderator gets. Everything else - Ban, Manage Roles, Manage Channels, Administrator -
// is left with the owner on purpose.
const MOD_PERMS = [
  F.ViewAuditLog,
  F.ManageMessages,
  F.ManageThreads,
  F.ModerateMembers,          // timeout
  F.KickMembers,
  F.MuteMembers,
  F.DeafenMembers,
  F.MoveMembers,
  F.ReadMessageHistory,
  F.SendMessages,
  F.EmbedLinks,
  F.AttachFiles,
  F.AddReactions,
  F.UseExternalEmojis,
  F.Connect,
  F.Speak,
];

// The channels that are Lovkar talking, not the room talking.
const LOCK = [
  'welcome', 'announcements', 'changelog', 'links', 'joins',
  'dev-builds', 'sneak-peek', 'behind-the-scenes',
];

const WRITE = [F.SendMessages, F.CreatePublicThreads, F.CreatePrivateThreads, F.SendMessagesInThreads];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('clientReady', async (c) => {
  try {
    const g = c.guilds.cache.first();
    await g.roles.fetch();
    const me = await g.members.fetchMe();

    // ---- 1. the Moderator role ---------------------------------------------------------------
    let mod = g.roles.cache.find((r) => r.name.toLowerCase() === MOD_ROLE.toLowerCase());
    if (mod) {
      await mod.setPermissions(MOD_PERMS, 'moderator toolkit');
      console.log(`role "${mod.name}": already there, permissions refreshed`);
    } else {
      mod = await g.roles.create({
        name: MOD_ROLE,
        colors: { primaryColor: 0x4EA8DE },
        hoist: true,                       // shown in its own group in the member list
        mentionable: false,
        permissions: MOD_PERMS,
        reason: 'somebody other than the owner has to be able to keep order',
      });
      console.log(`role "${mod.name}" created`);
    }
    // A moderator can only act on members whose highest role sits below theirs, so the role has to
    // clear every role an ordinary member can wear - Bug Hunter and the parked Patreon tiers
    // included, not just Dreamer. Putting it only above Dreamer looks right and quietly leaves a
    // moderator unable to touch anyone who has earned a badge.
    const memberRoles = ['Bug Hunter', 'Tester', 'Dreamer', 'OG', 'Titan', 'Colossus', 'Waker'];
    const top = Math.max(0, ...memberRoles.map((n) => g.roles.cache.find((r) => r.name === n)?.position ?? 0));
    try {
      if (mod.position <= top) {
        await mod.setPosition(top + 1, { reason: 'above every role an ordinary member can wear' });
        await g.roles.fetch();
        console.log(`   moved it to position ${g.roles.cache.get(mod.id).position}`);
      }
    } catch (e) {
      console.log(`   could not move it: ${e.message} - drag it above Bug Hunter by hand`);
    }
    console.log('   grants: ' + new PermissionsBitField(MOD_PERMS).toArray().join(', '));

    // ---- 2. lock the broadcast channels -------------------------------------------------------
    const lovkarRole = g.roles.cache.find((r) => r.name === 'Lovkar');
    for (const name of LOCK) {
      const ch = g.channels.cache.find((x) => x.name === name);
      if (!ch) { console.log(`#${name}: not here`); continue; }
      try {
        const before = ch.permissionsFor(g.roles.everyone).has(F.SendMessages);
        await ch.permissionOverwrites.edit(g.roles.everyone,
          Object.fromEntries(WRITE.map((f) => [new PermissionsBitField(f).toArray()[0], false])),
          { reason: 'Lovkar and the bot post here; everyone else reads' });
        // the deny above would catch the bot as well, so let it back in
        await ch.permissionOverwrites.edit(me.id,
          { SendMessages: true, SendMessagesInThreads: true, EmbedLinks: true, AttachFiles: true },
          { reason: 'the bot still has to be able to post here' });
        if (lovkarRole) {
          await ch.permissionOverwrites.edit(lovkarRole,
            { SendMessages: true, SendMessagesInThreads: true, EmbedLinks: true, AttachFiles: true,
              CreatePublicThreads: true },
            { reason: 'and so does Lovkar' });
        }
        console.log(`#${name}: locked${before ? '' : ' (already was)'}`);
      } catch (e) {
        console.log(`#${name}: could not lock - ${e.message}`);
      }
    }

    // ---- 3. what it looks like now -------------------------------------------------------------
    console.log('\n   after:');
    for (const name of LOCK) {
      const ch = await g.channels.fetch(
        g.channels.cache.find((x) => x.name === name)?.id, { force: true }).catch(() => null);
      if (!ch) continue;
      const ev = ch.permissionsFor(g.roles.everyone);
      const bot = ch.permissionsFor(me);
      console.log(`      #${ch.name.padEnd(20)} @everyone can write: ${String(ev.has(F.SendMessages)).padEnd(5)}` +
        `  bot can write: ${bot.has(F.SendMessages)}`);
    }
    const open = ['general', 'off-topic', 'waking-world', 'help', 'ideas-and-feedback'];
    console.log('\n   left open (people still talk here):');
    for (const name of open) {
      const ch = g.channels.cache.find((x) => x.name === name);
      if (ch) console.log(`      #${ch.name.padEnd(20)} @everyone can write: ${ch.permissionsFor(g.roles.everyone).has(F.SendMessages)}`);
    }
  } catch (e) {
    console.log('FAILED:', e.message);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
