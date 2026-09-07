/** No network, no Discord: the two parsers, the changelog cleaner and the "is this new" rule. */
'use strict';
const rel = require('./releases');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- Modrinth ----------------------------------------------------------------------------------
// What /v2/project/<slug>/version answers with, cut down to the fields the watcher reads.
const MODRINTH = [
  {
    id: 'AbCdEf12',
    project_id: 'ZzYyXx99',
    name: 'Waking World 0.2.1',
    version_number: '0.2.1',
    version_type: 'release',
    date_published: '2026-09-06T18:00:00Z',
    changelog: '## Added\n\nThe Colossi & their wandering paths.\n\n## Fixed\n   nothing yet',
    game_versions: ['1.20.1', '1.21'],
    loaders: ['fabric', 'neoforge'],
    files: [{ url: 'https://cdn.modrinth.com/data/ZzYyXx99/versions/0.2.1/waking.jar' }],
  },
  {
    id: 'GhIjKl34',
    project_id: 'ZzYyXx99',
    name: '0.3.0-alpha.1',
    version_number: '0.3.0-alpha.1',
    version_type: 'alpha',
    date_published: '2026-09-07T09:00:00Z',
    changelog: null,
    game_versions: ['1.21'],
    loaders: ['fabric'],
  },
];

const mod = rel.parseModrinth(MODRINTH, 'waking-world');
if (mod.length !== 2) fail(`two Modrinth versions expected, got ${mod.length}`);
if (mod[0].id !== 'modrinth:AbCdEf12') fail('the id should be prefixed by its source: ' + mod[0].id);
if (mod[0].source !== 'modrinth') fail('the source is wrong: ' + mod[0].source);
if (mod[0].project !== 'waking-world') fail('the project is wrong: ' + mod[0].project);
if (mod[0].name !== 'Waking World 0.2.1') fail('the name is wrong: ' + mod[0].name);
if (mod[0].version !== '0.2.1') fail('the version is wrong: ' + mod[0].version);
if (mod[0].url !== 'https://modrinth.com/mod/waking-world/version/0.2.1') fail('the link is wrong: ' + mod[0].url);
if (mod[0].published !== Date.parse('2026-09-06T18:00:00Z')) fail('the date is wrong: ' + mod[0].published);
if (mod[0].type !== 'release') fail('the type is wrong: ' + mod[0].type);
if (!same(mod[0].gameVersions, ['1.20.1', '1.21'])) fail('the game versions are wrong: ' + mod[0].gameVersions);
if (!same(mod[0].loaders, ['Fabric', 'NeoForge'])) fail('the loaders are wrong: ' + mod[0].loaders);
if (!mod[0].changelog.includes('Colossi')) fail('the changelog lost its text: ' + mod[0].changelog);
if (mod[0].changelog.includes('#')) fail('markdown headings should be stripped: ' + mod[0].changelog);
if (mod[1].type !== 'alpha') fail('an alpha should say so: ' + mod[1].type);
if (mod[1].changelog !== '') fail('a missing changelog is an empty one, not null: ' + mod[1].changelog);
if (mod[1].url !== 'https://modrinth.com/mod/waking-world/version/0.3.0-alpha.1') fail('the link is wrong: ' + mod[1].url);

// A version does not carry its own slug, so without one the project id makes the link instead.
const noSlug = rel.parseModrinth(MODRINTH, '');
if (noSlug[0].project !== 'ZzYyXx99') fail('the project id should stand in for a missing slug: ' + noSlug[0].project);
if (noSlug[0].url !== 'https://modrinth.com/mod/ZzYyXx99/version/0.2.1') fail('the fallback link is wrong: ' + noSlug[0].url);

// ---- CurseForge --------------------------------------------------------------------------------
// What the api.curse.tools proxy answers with for /v1/mods/<id>/files.
const CURSE = {
  data: [
    {
      id: 4567890,
      modId: 238222,
      displayName: 'Waking World 0.2.1',
      fileName: 'wakingworld-1.20.1-0.2.1.jar',
      fileDate: '2026-09-06T18:12:31.4Z',
      releaseType: 1,
      gameVersions: ['1.20.1', 'Forge', 'Client', 'Server', 'Java 17'],
      changelog: '<h2>Added</h2><p>The   Colossi &amp; their wandering paths.</p>'
        + '<ul><li>one</li><li>two</li></ul>',
    },
    {
      id: 4567123,
      modId: 238222,
      displayName: 'Waking World 0.2.2 beta',
      fileName: 'wakingworld-1.20.1-0.2.2-beta.jar',
      fileDate: '2026-09-07T06:30:00Z',
      releaseType: 2,
      gameVersions: ['1.20.1', 'NeoForge'],
    },
  ],
};

const cf = rel.parseCurseForge(CURSE, 'waking-world');
if (cf.length !== 2) fail(`two CurseForge files expected, got ${cf.length}`);
if (cf[0].id !== 'curseforge:4567890') fail('the id should be prefixed by its source: ' + cf[0].id);
if (cf[0].source !== 'curseforge') fail('the source is wrong: ' + cf[0].source);
if (cf[0].project !== 'waking-world') fail('the project is wrong: ' + cf[0].project);
if (cf[0].name !== 'Waking World 0.2.1') fail('the name is wrong: ' + cf[0].name);
if (cf[0].version !== '0.2.1') fail('the version should come out of the display name: ' + cf[0].version);
if (cf[0].url !== 'https://www.curseforge.com/minecraft/mc-mods/waking-world/files/4567890') fail('the link is wrong: ' + cf[0].url);
if (cf[0].published !== Date.parse('2026-09-06T18:12:31.4Z')) fail('the date is wrong: ' + cf[0].published);
if (cf[0].type !== 'release') fail('releaseType 1 is a release: ' + cf[0].type);
if (cf[1].type !== 'beta') fail('releaseType 2 is a beta: ' + cf[1].type);
// CurseForge keeps loaders, Minecraft versions and "Client"/"Java 17" in one list; only two of
// those three are worth showing anybody.
if (!same(cf[0].gameVersions, ['1.20.1'])) fail('the game versions are wrong: ' + cf[0].gameVersions);
if (!same(cf[0].loaders, ['Forge'])) fail('the loaders are wrong: ' + cf[0].loaders);
if (!same(cf[1].loaders, ['NeoForge'])) fail('the loaders are wrong: ' + cf[1].loaders);
if (cf[0].changelog.includes('<') || cf[0].changelog.includes('>')) fail('the HTML was not stripped: ' + cf[0].changelog);
if (!cf[0].changelog.includes('Colossi')) fail('the changelog lost its text: ' + cf[0].changelog);
if (!cf[0].changelog.includes('&')) fail('&amp; should come back as an ampersand: ' + cf[0].changelog);
if (!cf[0].changelog.includes('one') || !cf[0].changelog.includes('two')) fail('the list items were lost: ' + cf[0].changelog);
if (cf[0].changelog.includes('  ')) fail('the whitespace was not collapsed: ' + JSON.stringify(cf[0].changelog));
if (cf[1].changelog !== '') fail('a file with no changelog gets an empty one: ' + cf[1].changelog);
if (rel.parseCurseForge(CURSE.data, 'waking-world').length !== 2) fail('a bare array should parse too');

// ---- rubbish in, nothing out --------------------------------------------------------------------
// Both of these are read straight off somebody else's server, so anything at all may arrive.
for (const [what, got] of [
  ['null', rel.parseModrinth(null, 'x')],
  ['nothing', rel.parseModrinth(undefined, 'x')],
  ['a string', rel.parseModrinth('not json', 'x')],
  ['an object', rel.parseModrinth({ data: [] }, 'x')],
  ['junk in the array', rel.parseModrinth([null, 3, {}, { id: '' }], 'x')],
]) {
  if (!Array.isArray(got) || got.length !== 0) fail(`Modrinth ${what} should give back nothing, got ${JSON.stringify(got)}`);
}
for (const [what, got] of [
  ['null', rel.parseCurseForge(null, 'x')],
  ['nothing', rel.parseCurseForge(undefined, 'x')],
  ['a string', rel.parseCurseForge('not json', 'x')],
  ['an empty object', rel.parseCurseForge({}, 'x')],
  ['data that is not a list', rel.parseCurseForge({ data: 'no' }, 'x')],
  ['junk in the list', rel.parseCurseForge({ data: [null, 7, {}] }, 'x')],
]) {
  if (!Array.isArray(got) || got.length !== 0) fail(`CurseForge ${what} should give back nothing, got ${JSON.stringify(got)}`);
}

// A version with nothing but an id still parses, with empty fields rather than undefined ones.
const bare = rel.parseModrinth([{ id: 'Bare' }], 'x');
if (bare.length !== 1) fail('a version with only an id should still parse');
if (bare[0].published !== 0) fail('a missing date is 0, not NaN: ' + bare[0].published);
if (bare[0].version !== '' || bare[0].type !== 'release') fail('the fallbacks are wrong: ' + JSON.stringify(bare[0]));
if (!same(bare[0].gameVersions, []) || !same(bare[0].loaders, [])) fail('missing lists should be empty ones');
if (bare[0].url !== 'https://modrinth.com/mod/x') fail('with no version number the link is the project: ' + bare[0].url);
const bareFile = rel.parseCurseForge({ data: [{ id: 77 }] }, 'x');
if (bareFile.length !== 1 || bareFile[0].id !== 'curseforge:77') fail('a numeric id should still parse: ' + JSON.stringify(bareFile));

// ---- the two sources cannot collide --------------------------------------------------------------
const clash = [
  ...rel.parseModrinth([{ id: '9000', version_number: '1.0.0', date_published: '2026-09-07T10:00:00Z' }], 'a'),
  ...rel.parseCurseForge({ data: [{ id: 9000, displayName: 'Other 1.0.0', fileDate: '2026-09-07T11:00:00Z' }] }, 'b'),
];
if (clash[0].id !== 'modrinth:9000') fail('the Modrinth id is wrong: ' + clash[0].id);
if (clash[1].id !== 'curseforge:9000') fail('the CurseForge id is wrong: ' + clash[1].id);
if (clash[0].id === clash[1].id) fail('two sources sharing a raw id must not share an id here');

// ---- what counts as new ---------------------------------------------------------------------------
const NOW = Date.parse('2026-09-07T12:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const all = [...mod, ...cf];
const ids = (list) => list.map((e) => e.id).join(' ');

let out = rel.fresh(all, { seen: new Set(), maxAgeMs: 2 * DAY, types: 'release,beta', now: NOW });
if (out.length !== 3) fail(`three announceable builds expected, got ${out.length}: ${ids(out)}`);
if (out.some((e) => e.type === 'alpha')) fail('an alpha must not be announced when RELEASE_TYPES leaves it out');
if (ids(out) !== 'modrinth:AbCdEf12 curseforge:4567890 curseforge:4567123') {
  fail('they must come out oldest first, across both sources: ' + ids(out));
}

out = rel.fresh(all, { seen: new Set(), maxAgeMs: 2 * DAY, types: 'release', now: NOW });
if (out.length !== 2) fail(`only the releases expected, got ${out.length}: ${ids(out)}`);

out = rel.fresh(all, { seen: new Set(), maxAgeMs: 2 * DAY, types: null, now: NOW });
if (out.length !== 4) fail(`no type filter should let all four through, got ${out.length}`);
if (ids(out) !== 'modrinth:AbCdEf12 curseforge:4567890 curseforge:4567123 modrinth:GhIjKl34') {
  fail('oldest first, whatever the listings said: ' + ids(out));
}

out = rel.fresh(all, { seen: new Set(['modrinth:AbCdEf12', 'curseforge:4567890']), maxAgeMs: 2 * DAY, types: null, now: NOW });
if (out.length !== 2) fail(`what the book already knows must not be posted twice, got ${ids(out)}`);
if (rel.fresh(all, { seen: new Set(all.map((e) => e.id)), maxAgeMs: 2 * DAY, types: null, now: NOW }).length !== 0) {
  fail('everything seen means nothing to post');
}

// A Modrinth version being seen must not hide the CurseForge file that happens to share its number.
out = rel.fresh(clash, { seen: new Set(['modrinth:9000']), maxAgeMs: DAY, types: null, now: NOW });
if (out.length !== 1 || out[0].id !== 'curseforge:9000') fail('the source prefix is what keeps the two apart: ' + ids(out));

out = rel.fresh(all, { seen: new Set(), maxAgeMs: 6 * HOUR, types: 'release,beta', now: NOW });
if (out.length !== 1 || out[0].id !== 'curseforge:4567123') fail(`only the last six hours, got ${ids(out)}`);
if (rel.fresh(all, { seen: new Set(), maxAgeMs: 1 * HOUR, types: null, now: NOW }).length !== 0) {
  fail('nothing here is an hour old');
}
if (rel.fresh(bare, { seen: new Set(), maxAgeMs: 365 * DAY, types: null, now: NOW }).length !== 0) {
  fail('a build with no date cannot be judged and must not be posted');
}

// ---- the changelog --------------------------------------------------------------------------------
if (rel.changelog('<p>hello   <b>world</b></p>') !== 'hello world') {
  fail('tags out, whitespace collapsed: ' + JSON.stringify(rel.changelog('<p>hello   <b>world</b></p>')));
}
if (rel.changelog('# Added\n## Fixed\ntext') !== 'Added\nFixed\ntext') {
  fail('markdown headings lose their hashes: ' + JSON.stringify(rel.changelog('# Added\n## Fixed\ntext')));
}
if (rel.changelog('a &amp; b &quot;c&quot;') !== 'a & b "c"') {
  fail('the entities were not undone: ' + rel.changelog('a &amp; b &quot;c&quot;'));
}
if (rel.changelog('<script>alert(1)</script>keep') !== 'keep') fail('a script block is not changelog text');
if (rel.changelog('<br><br>') !== '') fail('tags and nothing else is nothing');
if (rel.changelog(null) !== '' || rel.changelog(undefined) !== '') fail('no changelog is an empty string');
if (rel.changelog('a short note.') !== 'a short note.') fail('short text should come back untouched');

const long = 'lorem ipsum dolor sit amet '.repeat(80);          // a good deal more than the cap
const cut = rel.changelog(long);
if (cut.length > 1000) fail(`the changelog was not trimmed: ${cut.length} characters`);
if (cut.length < 900) fail(`the changelog was trimmed too hard: ${cut.length} characters`);
if (!cut.endsWith('…')) fail('a trimmed changelog should say that it was trimmed');
const kept = cut.slice(0, -1);
if (!long.startsWith(kept)) fail('trimming changed the text: ' + JSON.stringify(kept.slice(-40)));
if (!/\S$/.test(kept)) fail('the trim left a dangling space');
if (long[kept.length] !== ' ') fail('the trim cut a word in half: ' + JSON.stringify(kept.slice(-20)));

// ---- what is configured ---------------------------------------------------------------------------
const was = { modrinth: rel.CONF.modrinth, curseforge: rel.CONF.curseforge };
rel.CONF.modrinth = ' waking-world , renamed:ZzYyXx99 ';
rel.CONF.curseforge = 'waking-world:238222, oops';
const where = rel.sources();
if (where.length !== 3) fail(`three pollable sources expected, got ${JSON.stringify(where)}`);
if (where[0].source !== 'modrinth' || where[0].slug !== 'waking-world' || where[0].id !== 'waking-world') {
  fail('a bare slug stands in for its own id on Modrinth: ' + JSON.stringify(where[0]));
}
if (where[1].slug !== 'renamed' || where[1].id !== 'ZzYyXx99') fail('slug:projectId should keep both halves: ' + JSON.stringify(where[1]));
if (where[2].source !== 'curseforge' || where[2].id !== '238222') fail('the CurseForge mod id is wrong: ' + JSON.stringify(where[2]));
if (where.some((s) => s.slug === 'oops')) fail('a CurseForge entry with no mod id cannot be polled and should be left out');

rel.CONF.modrinth = '';
rel.CONF.curseforge = '';
if (rel.sources().length !== 0) fail('nothing configured is nothing to watch');
Object.assign(rel.CONF, was);

// ---- a modpack's files live under a different path than a mod's -------------------------------
{
  const pack = { data: [{ id: 99, displayName: 'Pack 1.2.0', fileName: 'pack-1.2.0.zip',
    fileDate: new Date().toISOString(), releaseType: 1, gameVersions: ['1.21.1', 'Forge'] }] };
  const asMod = rel.parseCurseForge(pack, 'my-pack')[0];
  const asPack = rel.parseCurseForge(pack, 'my-pack', 'modpacks')[0];
  if (!asMod.url.includes('/mc-mods/')) fail('a mod should link under /mc-mods/: ' + asMod.url);
  if (!asPack.url.includes('/modpacks/')) fail('a pack should link under /modpacks/: ' + asPack.url);
  // a section that is not a path must never reach the URL
  const nasty = rel.parseCurseForge(pack, 'my-pack', '../../evil')[0];
  if (!nasty.url.includes('/mc-mods/')) fail('a bad section should fall back, got ' + nasty.url);
}

// ---- the first look at a server must be silent ---------------------------------------------------
if (rel.SEEDED !== 'releases:seeded') fail('the seeded key changed name: ' + rel.SEEDED);
if (rel.KNOWN !== 'releases:known') fail('the known-ids key changed name: ' + rel.KNOWN);
if (rel.SEEDED === rel.KNOWN) fail('the two marks must be separate keys');

console.log(bad ? `\n${bad} failing` : 'all release cases pass');
process.exit(bad ? 1 : 0);
