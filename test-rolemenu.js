/** No Discord, no network: the setting read, the roles asked for, and the button pressed both ways. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-roles-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const { MessageFlags } = require('discord.js');   // for the one constant, not for a connection
const db = require('./db');
const menu = require('./rolemenu');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const quiet = () => {};
const EPHEMERAL = MessageFlags.Ephemeral;

// ---- reading the setting ------------------------------------------------------------------------
const four = menu.parse(menu.CONF.menu);
if (four.length !== 4) fail('the four defaults should read as four: ' + four.length);
if (four.map((r) => r.key).join(',') !== 'releases,sneaks,streams,giveaways') {
  fail('the keys are wrong: ' + four.map((r) => r.key).join(','));
}
if (four.map((r) => r.name).join('|') !== 'New releases|Sneak peeks|Streams|Giveaways') {
  fail('the role name is the middle field: ' + four.map((r) => r.name).join('|'));
}
if (four[0].emoji !== '📦') fail('the emoji did not come through: ' + JSON.stringify(four[0].emoji));

// extra whitespace anywhere in an entry
const spaced = menu.parse('  releases : New releases : 📦 ,\tstreams:Streams:🎥 ');
if (spaced.length !== 2) fail('spaces should not cost an entry: ' + spaced.length);
if (spaced[0].key !== 'releases') fail('the key was not trimmed: ' + JSON.stringify(spaced[0].key));
if (spaced[0].name !== 'New releases') fail('the name was not trimmed: ' + JSON.stringify(spaced[0].name));
if (spaced[0].emoji !== '📦') fail('the emoji was not trimmed: ' + JSON.stringify(spaced[0].emoji));

// no emoji at all
const bare = menu.parse('news:Newsletter');
if (bare.length !== 1) fail('an entry without an emoji is still an entry: ' + bare.length);
if (bare[0].emoji !== '') fail('a missing emoji should be nothing: ' + JSON.stringify(bare[0].emoji));
if (menu.parse('news:Newsletter:')[0].emoji !== '') fail('a trailing colon is not an emoji either');

// a trailing comma, and a few of them
if (menu.parse('news:Newsletter:📰,').length !== 1) fail('a trailing comma is not an entry');
if (menu.parse('news:Newsletter:📰,,, ,').length !== 1) fail('nor are several of them');

// rubbish, on its own and in company
for (const junk of ['', null, undefined, '   ', ',,,', 'just-a-word', ':', '::', ':Name:📦',
  'key:', 'key: :📦', 'two words:A name']) {
  const got = menu.parse(junk);
  if (got.length) fail(`"${junk}" should have given nothing, gave ${JSON.stringify(got)}`);
}
const mixed = menu.parse('rubbish,releases:New releases:📦,more rubbish,streams:Streams');
if (mixed.length !== 2) fail('the good entries either side of the rubbish should stand: ' + mixed.length);
if (mixed[1].name !== 'Streams') fail('the wrong entries survived: ' + JSON.stringify(mixed));

// two entries with one key would give one button two meanings, so the first of them wins
const dup = menu.parse('news:First,news:Second');
if (dup.length !== 1 || dup[0].name !== 'First') fail('a repeated key should not make two buttons');
if (menu.parse('NEWS:Newsletter')[0].key !== 'news') fail('a key should come back in one case');

// the emoji field is whatever is left, colons and all, and anything that is not an emoji is dropped
const custom = menu.parse('pop:Pop:<:pop:123456789012345678>')[0];
if (custom.emoji !== '<:pop:123456789012345678>') fail('a custom emoji has colons in it: ' + custom.emoji);
const typo = menu.parse('bad:Bad:not-an-emoji');
if (typo.length !== 1) fail('a bad emoji should cost the emoji, not the button');
if (typo[0].emoji !== '') fail('a word is not an emoji: ' + JSON.stringify(typo[0].emoji));

// ---- a server, in as much of its shape as this module ever looks at ------------------------------

/** A discord.js Collection is a Map with a find on it, and that is all of one that is used here. */
function collection(entries = []) {
  const map = new Map(entries);
  map.find = function (f) { return [...this.values()].find(f); };
  return map;
}

function fakeChannel(name) {
  let n = 0;
  const store = collection();
  const channel = {
    id: 'c-' + name,
    name,
    type: 0,
    sent: [],
    edits: [],
    send: async (body) => {
      channel.sent.push(body);
      const id = 'm' + (++n);
      const msg = {
        id,
        url: `https://discord.com/channels/g/${channel.id}/${id}`,
        edit: async (b) => { channel.edits.push(b); return msg; },
      };
      store.set(id, msg);
      return msg;
    },
    messages: {
      store,
      fetch: async (id) => {
        const msg = store.get(id);
        if (!msg) throw new Error('Unknown Message');   // deleted, as Discord says it
        return msg;
      },
    },
  };
  return channel;
}

function fakeGuild(channels = [], roleNames = []) {
  let n = 0;
  const roles = collection();
  const guild = {
    name: 'a test server',
    made: [],            // what roles.create was asked for, so the test can look at it
    fetched: 0,
    channels: { cache: collection(channels.map((c) => [c.id, c])) },
    roles: {
      cache: roles,
      fetch: async () => { guild.fetched++; return roles; },
      create: async (o) => {
        guild.made.push(o);
        return guild.addRole(o.name);
      },
    },
    members: { fetchMe: async () => ({ roles: { highest: { position: 10 } } }) },
  };
  guild.addRole = (name, position = 1) => {
    const role = { id: 'r' + (++n), name, position };
    roles.set(role.id, role);
    return role;
  };
  for (const name of roleNames) guild.addRole(name);
  return guild;
}

function fakeMember(tag = 'someone') {
  const cache = collection();
  return {
    user: { id: 'u1', tag },
    roles: {
      cache,
      add: async (role) => { cache.set(role.id, role); },
      remove: async (role) => { cache.delete(role.id); },
    },
  };
}

function fakePress(customId, guild, member) {
  const it = {
    customId,
    guild,
    member,
    user: member.user,
    replies: [],
    reply: async (r) => { it.replies.push(r); return r; },
  };
  return it;
}

(async () => {
  db.open(quiet);

  const welcome = fakeChannel('welcome');
  const guild = fakeGuild([welcome], ['Streams']);     // one of the four is already in the server

  // ---- putting the menu up -----------------------------------------------------------------------
  const first = await menu.post(guild, { log: quiet });
  if (!first) fail('the menu did not go up');
  if (first.edited) fail('the first call posts, it does not edit');
  if (welcome.sent.length !== 1) fail('the menu should have gone up once: ' + welcome.sent.length);
  if (!guild.fetched) fail('the role list should be asked for before roles are made from a stale cache');

  // only what was missing
  if (guild.made.length !== 3) fail('only the three missing roles should be made: ' + guild.made.length);
  if (guild.made.map((o) => o.name).join('|') !== 'New releases|Sneak peeks|Giveaways') {
    fail('the wrong roles were made: ' + guild.made.map((o) => o.name).join('|'));
  }
  if (guild.roles.cache.size !== 4) fail('the server should end up with four roles: ' + guild.roles.cache.size);
  for (const o of guild.made) {
    if (!Array.isArray(o.permissions) || o.permissions.length) fail(`"${o.name}" was given permissions`);
    if (o.mentionable !== true) fail(`"${o.name}" cannot be pinged, which is the whole point of it`);
  }

  // ---- what was posted ----------------------------------------------------------------------------
  const body = welcome.sent[0];
  const embed = body.embeds[0].toJSON();
  if (embed.color !== 0xe2b24a) fail('the colour is wrong: ' + embed.color);
  if (embed.title !== menu.CONF.title) fail('the title is wrong: ' + embed.title);
  if (!/notified/.test(embed.description || '')) fail('it should say the roles only decide notifications');
  if (body.components.length !== 1) fail('four buttons fit on one row: ' + body.components.length);
  const row = body.components[0].toJSON();
  if (row.components.length !== 4) fail('a button per role: ' + row.components.length);
  if (row.components[0].custom_id !== 'role:releases') fail('the id is wrong: ' + row.components[0].custom_id);
  if (row.components[0].label !== 'New releases') fail('the label is wrong: ' + row.components[0].label);
  if (row.components[0].emoji?.name !== '📦') fail('the emoji did not reach the button');
  if (row.components.some((b) => String(b.custom_id).startsWith('gw:'))) fail('that prefix belongs to giveaways.js');

  // it wrote down where it put it, or it would post another one next time
  if (db.get('rolemenu:message') !== first.id) fail('the message id was not written down');
  if (db.get('rolemenu:channel') !== welcome.id) fail('the channel id was not written down');

  // ---- a second call edits it rather than posting a second menu ------------------------------------
  const again = await menu.post(guild, { log: quiet });
  if (welcome.sent.length !== 1) fail('the menu was posted twice: ' + welcome.sent.length);
  if (welcome.edits.length !== 1) fail('the second call should have edited the first: ' + welcome.edits.length);
  if (!again.edited) fail('the second call should say that is what it did');
  if (again.id !== first.id) fail('it edited some other message: ' + again.id);
  if (guild.made.length !== 3) fail('the roles were made all over again: ' + guild.made.length);

  // ---- ...and puts up a fresh one when the old message has been deleted -----------------------------
  welcome.messages.store.delete(first.id);
  const third = await menu.post(guild, { log: quiet });
  if (welcome.sent.length !== 2) fail('a deleted menu should be replaced: ' + welcome.sent.length);
  if (third.edited) fail('there was nothing left to edit');
  if (db.get('rolemenu:message') !== third.id) fail('the new message id was not written down');

  // ---- a server with nowhere to put it ---------------------------------------------------------------
  try {
    await menu.post(fakeGuild([fakeChannel('general')]), { log: quiet });
    fail('a server with no #welcome should have been refused');
  } catch (e) {
    if (!/there is no #welcome/.test(e.message)) fail('refused for the wrong reason: ' + e.message);
  }

  // ---- pressing a button ------------------------------------------------------------------------------
  const sneaks = guild.roles.cache.find((r) => r.name === 'Sneak peeks');
  const member = fakeMember('someone');

  const on = fakePress('role:sneaks', guild, member);
  await menu.press(on, quiet);
  if (!member.roles.cache.has(sneaks.id)) fail('the role was not given');
  if (on.replies.length !== 1) fail('one press, one answer: ' + on.replies.length);
  if (on.replies[0].content !== 'You will be pinged about **Sneak peeks**.') {
    fail('it said: ' + on.replies[0].content);
  }
  if (on.replies[0].flags !== EPHEMERAL) fail('the answer was not ephemeral');

  const off = fakePress('role:sneaks', guild, member);
  await menu.press(off, quiet);
  if (member.roles.cache.has(sneaks.id)) fail('the role was not taken back off');
  if (off.replies[0].content !== 'You will not be pinged about **Sneak peeks** any more.') {
    fail('it said: ' + off.replies[0].content);
  }
  if (off.replies[0].flags !== EPHEMERAL) fail('the second answer was not ephemeral either');

  // ---- a button that means nothing --------------------------------------------------------------------
  for (const id of ['role:nonsense', 'role:', 'gw:abc123', '']) {
    const stranger = fakePress(id, guild, fakeMember());
    await menu.press(stranger, quiet);                          // must answer rather than throw
    if (stranger.replies.length !== 1) fail(`"${id}" should still be answered once`);
    if (stranger.replies[0]?.flags !== EPHEMERAL) fail(`"${id}" was answered in the open`);
  }

  // ---- a role somebody has deleted since -----------------------------------------------------------------
  const releases = guild.roles.cache.find((r) => r.name === 'New releases');
  guild.roles.cache.delete(releases.id);
  const gone = fakePress('role:releases', guild, fakeMember());
  const said = [];
  await menu.press(gone, (m) => said.push(m));
  if (gone.replies.length !== 1) fail('a missing role should be answered, not thrown over');
  if (!/New releases/.test(gone.replies[0]?.content || '')) fail('it should name the missing role: ' + gone.replies[0]?.content);
  if (gone.replies[0]?.flags !== EPHEMERAL) fail('that answer was not ephemeral');
  if (!said.some((m) => /New releases/.test(m))) fail('a missing role should be in the log for whoever can fix it');

  // ---- a role sitting above the bot's own highest ----------------------------------------------------------
  const highRole = guild.roles.cache.find((r) => r.name === 'Giveaways');
  highRole.position = 99;                                       // above the bot, so Discord would refuse
  const highMember = fakeMember('somebody else');
  const high = fakePress('role:giveaways', guild, highMember);
  const grumbles = [];
  await menu.press(high, (m) => grumbles.push(m));
  if (high.replies.length !== 1) fail('that should be answered too');
  if (!/above my own highest role/.test(high.replies[0]?.content || '')) {
    fail('it should say plainly why: ' + high.replies[0]?.content);
  }
  if (highMember.roles.cache.size) fail('nothing should have been handed out');
  if (!grumbles.some((m) => /highest role/.test(m))) fail('it should be in the log as well, with the fix in it');

  // ---- what the rest of the bot pings ------------------------------------------------------------------------
  const streams = guild.roles.cache.find((r) => r.name === 'Streams');
  if (menu.mention(guild, 'streams') !== `<@&${streams.id}>`) fail('the mention is wrong: ' + menu.mention(guild, 'streams'));
  if (menu.mention(guild, ' STREAMS ') !== `<@&${streams.id}>`) fail('a key should be read the way parse reads it');
  if (menu.mention(guild, 'nonsense') !== '') fail('an unknown key should be nothing at all');
  if (menu.mention(guild, 'releases') !== '') fail('a role that is gone should be nothing at all');
  if (menu.mention(guild, '') !== '') fail('no key at all should be nothing at all');
  if (menu.mention(guild, null) !== '') fail('nothing at all should be nothing at all');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} case(s) failed` : 'all role menu cases pass');
  process.exit(bad ? 1 : 0);
})();
