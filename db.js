/**
 * The book: the little that is worth remembering after a restart.
 *
 * <p>For a long time this bot deliberately had no database. Discord held the record - the tags on
 * a post, the roles on a member, the messages in #announcements - and the bot read it back off the
 * gateway every time it woke up. That is still true of everything Discord can answer for, and it
 * is why a redeploy has never lost anything that mattered.</p>
 *
 * <p>What it did lose was the bot's own account of itself: the log the dashboard shows, how many
 * posts it has ever triaged, which pictures went out and when. Discord cannot answer for those, so
 * they are written here - one SQLite file, no server, no dependency (SQLite ships inside Node).</p>
 *
 * <p>Two rules keep this honest. Nothing that Discord can be asked for is duplicated here as the
 * truth; the watcher still reads #announcements and merely <em>adds</em> what it finds to the ids
 * it already knew. And the bot must run without the file: if the disk is read-only, or SQLite is
 * missing from the runtime, every call here quietly does nothing and the bot behaves exactly as it
 * did before there was a book at all.</p>
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Where the file lives, unless DB_PATH says otherwise. A bind mount is expected at /data. */
const DEFAULT_PATH = process.env.DB_PATH || '/data/sentinel.db';
/** How many log lines are kept. A few weeks of a quiet server, and a couple of megabytes. */
const LOG_KEEP = Number(process.env.DB_LOG_KEEP || 5000);
/** Trimming on every line would be silly; every so many is plenty. */
const TRIM_EVERY = 200;

const SCHEMA = [
  // v1 - everything the first version of the book holds
  `
  CREATE TABLE IF NOT EXISTS log (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    at    INTEGER NOT NULL,
    line  TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,
    kind    TEXT    NOT NULL,
    subject TEXT,
    detail  TEXT
  );
  CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at);
  CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS packs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       INTEGER NOT NULL,
    kind     TEXT    NOT NULL,
    channel  TEXT,
    files    INTEGER NOT NULL DEFAULT 0,
    bytes    INTEGER NOT NULL DEFAULT 0,
    who      TEXT,
    caption  TEXT,
    names    TEXT,
    url      TEXT
  );
  CREATE TABLE IF NOT EXISTS videos (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    url        TEXT,
    published  INTEGER,
    posted_at  INTEGER,
    message_id TEXT
  );
  CREATE TABLE IF NOT EXISTS reports (
    id        TEXT PRIMARY KEY,
    at        INTEGER NOT NULL,
    title     TEXT,
    author    TEXT,
    severity  TEXT,
    project   TEXT,
    needs_log INTEGER NOT NULL DEFAULT 0,
    why       TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT,
    at    INTEGER NOT NULL
  );
  `,
];

/** A book that is not there: every call is a shrug, so no caller needs to check first. */
const CLOSED = {
  ready: false,
  where: 'nowhere',
  why: 'not opened',
  line() {}, lines() { return []; },
  event() {}, events() { return []; },
  bump() {}, counters() { return {}; },
  pack() {}, packs() { return []; },
  videoPosted() {}, videosSeen() { return new Set(); }, videos() { return []; },
  report() {}, reports() { return []; },
  set() {}, get() { return null; },
  stats() { return { ready: false, where: 'nowhere' }; },
  close() {},
};

let book = CLOSED;

/** Somewhere to write, in the order the deployment is likely to have meant. */
function candidates() {
  const out = [DEFAULT_PATH];
  if (!process.env.DB_PATH) out.push(path.join(process.cwd(), 'data', 'sentinel.db'));
  return out;
}

function usable(file) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the book, or decide to live without one.
 *
 * <p>Safe to call twice: the second call hands back the same handle.</p>
 *
 * @param log  the bot's logger, so the choice it made shows up in the dashboard
 */
function open(log = console.log) {
  if (book !== CLOSED) return book;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    book = { ...CLOSED, why: `this Node has no node:sqlite (${e.message})` };
    log(`[db] no database: ${book.why} - running the old way, remembering nothing`);
    return book;
  }

  let db = null;
  let where = null;
  for (const file of candidates()) {
    if (!usable(file)) continue;
    try {
      db = new DatabaseSync(file);
      where = file;
      break;
    } catch (e) {
      log(`[db] could not open ${file}: ${e.message}`);
    }
  }
  if (!db) {
    book = { ...CLOSED, why: 'nowhere writable to keep it' };
    log('[db] no database: nowhere writable (mount a volume at /data or set DB_PATH)'
      + ' - running the old way, remembering nothing');
    return book;
  }

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 4000');

  const at = db.prepare('PRAGMA user_version').get();
  let version = Number(at ? Object.values(at)[0] : 0) || 0;
  for (let v = version; v < SCHEMA.length; v++) db.exec(SCHEMA[v]);
  if (version < SCHEMA.length) {
    db.exec(`PRAGMA user_version = ${SCHEMA.length}`);
    version = SCHEMA.length;
  }

  book = make(db, where, version, log);
  const n = book.counters();
  log(`[db] ${where} (schema v${version})`
    + `${n.triaged ? `, ${n.triaged} post(s) triaged so far` : ''}`);
  return book;
}

function make(db, where, version, log) {
  const q = {
    line: db.prepare('INSERT INTO log (at, line) VALUES (?, ?)'),
    lines: db.prepare('SELECT line FROM log ORDER BY id DESC LIMIT ?'),
    trim: db.prepare('DELETE FROM log WHERE id <= (SELECT MAX(id) - ? FROM log)'),
    event: db.prepare('INSERT INTO events (at, kind, subject, detail) VALUES (?, ?, ?, ?)'),
    events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
    bump: db.prepare('INSERT INTO counters (name, value) VALUES (?, ?) '
      + 'ON CONFLICT(name) DO UPDATE SET value = value + excluded.value'),
    counters: db.prepare('SELECT name, value FROM counters'),
    pack: db.prepare('INSERT INTO packs (at, kind, channel, files, bytes, who, caption, names, url) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    packs: db.prepare('SELECT * FROM packs ORDER BY id DESC LIMIT ?'),
    video: db.prepare('INSERT INTO videos (id, title, url, published, posted_at, message_id) '
      + 'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'),
    videoIds: db.prepare('SELECT id FROM videos'),
    videos: db.prepare('SELECT * FROM videos ORDER BY posted_at DESC LIMIT ?'),
    report: db.prepare('INSERT INTO reports (id, at, title, author, severity, project, needs_log, why) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET '
      + 'severity = excluded.severity, project = excluded.project, '
      + 'needs_log = excluded.needs_log, why = excluded.why'),
    reports: db.prepare('SELECT * FROM reports ORDER BY at DESC LIMIT ?'),
    set: db.prepare('INSERT INTO kv (key, value, at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at'),
    get: db.prepare('SELECT value FROM kv WHERE key = ?'),
    size: db.prepare('SELECT (SELECT COUNT(*) FROM log) AS log, (SELECT COUNT(*) FROM events) AS events, '
      + '(SELECT COUNT(*) FROM packs) AS packs, (SELECT COUNT(*) FROM videos) AS videos, '
      + '(SELECT COUNT(*) FROM reports) AS reports'),
  };

  // One complaint per kind of failure: a database that has gone bad must not fill the log with it.
  const moaned = new Set();
  const safe = (what, fn, fallback) => (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      if (!moaned.has(what)) {
        moaned.add(what);
        log(`[db] ${what} failed and will not be mentioned again: ${e.message}`);
      }
      return fallback;
    }
  };

  let written = 0;

  return {
    ready: true,
    where,
    version,
    why: null,

    /** One line of the bot's log, kept so the dashboard survives a restart. */
    line: safe('writing the log', (text) => {
      q.line.run(Date.now(), String(text));
      if (++written % TRIM_EVERY === 0) q.trim.run(LOG_KEEP);
    }),
    /** The last n lines, oldest first - the shape the dashboard's ring wants. */
    lines: safe('reading the log', (n = 500) => q.lines.all(n).map((r) => r.line).reverse(), []),

    /** Something that happened and is worth having a date for. */
    event: safe('writing an event', (kind, subject, detail) => {
      q.event.run(Date.now(), String(kind), subject == null ? null : String(subject),
        detail == null ? null : String(detail));
    }),
    events: safe('reading the events', (n = 100) => q.events.all(n), []),

    /** Lifetime counters: the numbers on the dashboard stop going back to zero on a redeploy. */
    bump: safe('counting', (name, by = 1) => { q.bump.run(String(name), Number(by) || 0); }),
    counters: safe('reading the counters', () => {
      const out = {};
      for (const r of q.counters.all()) out[r.name] = Number(r.value);
      return out;
    }, {}),

    /** A pack that went out, so there is an answer to "when did we last post anything". */
    pack: safe('writing a pack', (p) => {
      q.pack.run(Date.now(), String(p.kind), p.channel || null, Number(p.files) || 0,
        Number(p.bytes) || 0, p.who || null, p.caption || null,
        Array.isArray(p.names) ? p.names.join(', ') : (p.names || null), p.url || null);
    }),
    packs: safe('reading the packs', (n = 20) => q.packs.all(n), []),

    /** A video the watcher has announced. Discord is still the record; this is the shortcut. */
    videoPosted: safe('writing a video', (v) => {
      q.video.run(String(v.id), v.title || null, v.url || null,
        Number(v.published) || null, Date.now(), v.messageId || null);
    }),
    videosSeen: safe('reading the videos', () => new Set(q.videoIds.all().map((r) => r.id)), new Set()),
    videos: safe('listing the videos', (n = 20) => q.videos.all(n), []),

    /** What the triage decided about a post, and why. Re-triaging overwrites its own row. */
    report: safe('writing a report', (r) => {
      q.report.run(String(r.id), Date.now(), r.title || null, r.author || null,
        r.severity || null, r.project || null, r.needsLog ? 1 : 0, r.why || null);
    }),
    reports: safe('reading the reports', (n = 50) => q.reports.all(n), []),

    /** Anything else worth one line of state. */
    set: safe('writing a setting', (key, value) => {
      q.set.run(String(key), value == null ? null : String(value), Date.now());
    }),
    get: safe('reading a setting', (key) => {
      const row = q.get.get(String(key));
      return row ? row.value : null;
    }, null),

    stats: safe('measuring itself', () => {
      let bytes = 0;
      try { bytes = fs.statSync(where).size; } catch { /* :memory: has no size */ }
      return { ready: true, where, version, bytes, rows: q.size.get() };
    }, { ready: true, where }),

    close: safe('closing', () => { db.close(); book = CLOSED; }),
  };
}

/**
 * The book itself, whatever state it is in.
 *
 * <p>Every one of these forwards to the open book, or to the shrug that stands in for it, so no
 * caller ever has to ask whether there is a database. They are written out one by one rather than
 * conjured with a proxy: this file is read more often than it is changed.</p>
 */
module.exports = {
  open,
  CLOSED,
  LOG_KEEP,
  DEFAULT_PATH,
  get ready() { return book.ready; },
  get where() { return book.where; },
  get why() { return book.why; },

  line: (text) => book.line(text),
  lines: (n) => book.lines(n),
  event: (kind, subject, detail) => book.event(kind, subject, detail),
  events: (n) => book.events(n),
  bump: (name, by) => book.bump(name, by),
  counters: () => book.counters(),
  pack: (p) => book.pack(p),
  packs: (n) => book.packs(n),
  videoPosted: (v) => book.videoPosted(v),
  videosSeen: () => book.videosSeen(),
  videos: (n) => book.videos(n),
  report: (r) => book.report(r),
  reports: (n) => book.reports(n),
  set: (key, value) => book.set(key, value),
  get: (key) => book.get(key),
  stats: () => book.stats(),
  close: () => book.close(),
};
