/** No Discord: that every command is one Discord would actually accept, and the wizard's shape. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cmd-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const commands = require('./commands');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

// ---- every command must survive Discord's own rules ---------------------------------------------
const defs = commands.definitions();
const names = defs.map((d) => d.name).sort();
for (const want of ['bug', 'giveaway', 'pack', 'poll', 'queue', 'roles', 'version']) {
  if (!names.includes(want)) fail(`/${want} is missing`);
}
if (new Set(names).size !== names.length) fail('two commands share a name');

function check(where, o) {
  if (!/^[-_\p{L}\p{N}]{1,32}$/u.test(o.name)) fail(`${where}: "${o.name}" is not a name Discord takes`);
  if (o.name !== o.name.toLowerCase()) fail(`${where}: "${o.name}" must be lower case`);
  if (!o.description || o.description.length > 100) fail(`${where}: the description is missing or too long`);
  for (const sub of o.options || []) check(`${where}/${o.name}`, sub);
  // a required option may never follow an optional one
  let seenOptional = false;
  for (const opt of o.options || []) {
    if (opt.type > 2) {                                  // not a subcommand or a group
      if (opt.required) { if (seenOptional) fail(`${where}/${o.name}: "${opt.name}" is required after an optional one`); }
      else seenOptional = true;
    }
  }
}
for (const d of defs) check('/', d);

// the two that everybody may use must not be locked to staff, and the rest must be
const open = new Set(['bug', 'version']);
for (const d of defs) {
  const locked = d.default_member_permissions != null && d.default_member_permissions !== '0';
  if (open.has(d.name) && locked) fail(`/${d.name} should be open to everyone`);
  if (!open.has(d.name) && !locked) fail(`/${d.name} should be staff only`);
}

// /pack must ask for one picture and offer more, and Discord takes at most 25 options
const pack = defs.find((d) => d.name === 'pack');
const pics = pack.options.filter((o) => o.type === 11);
if (pics.length < 3) fail('/pack should take several pictures');
if (!pics[0].required) fail('/pack should need at least one picture');
if (pics.slice(1).some((o) => o.required)) fail('only the first picture may be required');
for (const d of defs) if ((d.options || []).length > 25) fail(`/${d.name} has more options than Discord allows`);

// ---- the wizard ------------------------------------------------------------------------------------
const modal = commands.bugModal().toJSON();
if (modal.custom_id !== commands.BUG_MODAL) fail('the modal id is wrong');
if (modal.components.length !== 5) fail('the wizard should ask five things, not ' + modal.components.length);
const fields = modal.components.map((r) => r.components[0]);
for (const want of ['title', 'what', 'version', 'loader', 'mods']) {
  if (!fields.find((f) => f.custom_id === want)) fail(`the wizard does not ask for "${want}"`);
}
if (fields.find((f) => f.custom_id === 'mods').required !== false) fail('the other-mods field should be optional');
if (fields.find((f) => f.custom_id === 'version').required !== true) fail('the version field must be required');
if (fields.filter((f) => f.style === 2).length < 2) fail('the long answers should be paragraphs');
if (modal.title.length > 45) fail('the modal title is too long for Discord');

// ---- it must not tread on the giveaway button ---------------------------------------------------------
if (commands.BUG_MODAL.startsWith('gw:') || commands.BUG_MODAL.startsWith('role:')) {
  fail('the modal id collides with a button prefix');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} case(s) failed` : 'all command cases pass');
process.exit(bad ? 1 : 0);
