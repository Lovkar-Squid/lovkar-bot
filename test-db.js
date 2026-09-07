/** No Discord, no network: the book on its own, in a directory that is thrown away afterwards. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-db-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const db = require('./db');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };
const quiet = () => {};

// ---- before it is opened, everything is a shrug -------------------------------------------------
if (db.ready) fail('the book should not be open yet');
db.line('this goes nowhere');
if (db.lines().length) fail('a closed book should hand back nothing');
if (db.videosSeen().size) fail('a closed book should know no videos');

// ---- open it ------------------------------------------------------------------------------------
db.open(quiet);
if (!db.ready) fail('the book did not open: ' + db.why);
if (db.where !== process.env.DB_PATH) fail('it opened the wrong file: ' + db.where);
if (db.open(quiet) !== undefined && !db.ready) fail('opening twice should be harmless');

// ---- the log ------------------------------------------------------------------------------------
for (let i = 1; i <= 5; i++) db.line('line ' + i);
const lines = db.lines(3);
if (lines.length !== 3) fail('asked for three lines, got ' + lines.length);
if (lines[2] !== 'line 5') fail('the newest line should come last: ' + lines[2]);
if (lines[0] !== 'line 3') fail('the window is wrong: ' + lines[0]);

// ---- counters -----------------------------------------------------------------------------------
db.bump('triaged');
db.bump('triaged');
db.bump('rolesGiven', 7);
const c = db.counters();
if (c.triaged !== 2) fail('triaged should be 2, is ' + c.triaged);
if (c.rolesGiven !== 7) fail('rolesGiven should be 7, is ' + c.rolesGiven);

// ---- packs --------------------------------------------------------------------------------------
db.pack({ kind: 'sneak', channel: 'sneak-peek', files: 8, bytes: 1234, who: 'the terminal',
  caption: 'a caption', names: ['a.png', 'b.jpg'], url: 'https://discord.com/x' });
const p = db.packs(5);
if (p.length !== 1) fail('one pack expected, got ' + p.length);
if (p[0].names !== 'a.png, b.jpg') fail('the file names were not kept: ' + p[0].names);
if (p[0].kind !== 'sneak') fail('the kind is wrong: ' + p[0].kind);

// ---- videos: writing the same one twice must not double it ---------------------------------------
db.videoPosted({ id: 'abc123', title: 'A trailer', url: 'https://youtu.be/abc123', published: 1 });
db.videoPosted({ id: 'abc123', title: 'A trailer (again)', url: 'https://youtu.be/abc123' });
const seen = db.videosSeen();
if (seen.size !== 1) fail('the same video was written twice: ' + seen.size);
if (!seen.has('abc123')) fail('the video id is not in the set');
if (db.videos()[0].title !== 'A trailer') fail('the first title should have stood');

// ---- reports: re-triaging the same post overwrites its own row ------------------------------------
db.report({ id: 't1', title: 'crash on load', author: 'someone', severity: 'Critical', needsLog: true, why: 'a stack trace' });
db.report({ id: 't1', title: 'crash on load', author: 'someone', severity: 'Major', needsLog: false, why: 'on second thought' });
const r = db.reports();
if (r.length !== 1) fail('re-triage should not add a row: ' + r.length);
if (r[0].severity !== 'Major') fail('the second verdict should have won: ' + r[0].severity);
if (r[0].needs_log !== 0) fail('needs log should have been cleared');

// ---- kv -----------------------------------------------------------------------------------------
db.set('last-video', 'abc123');
if (db.get('last-video') !== 'abc123') fail('the setting did not come back');
db.set('last-video', 'def456');
if (db.get('last-video') !== 'def456') fail('the setting did not change');
if (db.get('nothing-here') !== null) fail('an unknown key should be null');

// ---- events -------------------------------------------------------------------------------------
db.event('join', 'someone', 'gave Dreamer');
if (db.events()[0].kind !== 'join') fail('the event did not land');

// ---- it survives being closed and opened again ----------------------------------------------------
const before = db.stats();
if (!before.bytes) fail('the file has no size');
db.close();
if (db.ready) fail('it should be closed now');
delete require.cache[require.resolve('./db')];
const again = require('./db');
again.open(quiet);
if (again.counters().triaged !== 2) fail('the counters did not survive a reopen');
if (again.lines(10).length !== 5) fail('the log did not survive a reopen');
again.close();

// ---- nowhere to write: the bot must not care --------------------------------------------------------
delete require.cache[require.resolve('./db')];
process.env.DB_PATH = path.join(dir, 'a-file', 'sentinel.db');   // the parent is a file, so there is nowhere to put it
fs.writeFileSync(path.join(dir, 'a-file'), 'not a directory');
const homeless = require('./db');
homeless.open(quiet);
if (homeless.ready) fail('it should not have opened a file under /proc');
homeless.line('this goes nowhere, quietly');
if (homeless.lines().length) fail('a homeless book should still hand back nothing');
if (homeless.counters().triaged) fail('a homeless book should count nothing');

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} case(s) failed` : 'all db cases pass');
process.exit(bad ? 1 : 0);
