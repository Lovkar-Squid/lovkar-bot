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
  // v2 - giveaways, which are the first thing here that would be genuinely lost without a book
  `
  CREATE TABLE IF NOT EXISTS giveaways (
    id         TEXT PRIMARY KEY,
    channel_id TEXT    NOT NULL,
    message_id TEXT,
    prize      TEXT    NOT NULL,
    winners    INTEGER NOT NULL DEFAULT 1,
    role_id    TEXT,
    host       TEXT,
    created    INTEGER NOT NULL,
    ends       INTEGER NOT NULL,
    ended_at   INTEGER,
    state      TEXT    NOT NULL DEFAULT 'running',
    drawn      TEXT
  );
  CREATE INDEX IF NOT EXISTS giveaways_state ON giveaways (state, ends);
  CREATE TABLE IF NOT EXISTS entries (
    giveaway TEXT    NOT NULL,
    user     TEXT    NOT NULL,
    tag      TEXT,
    at       INTEGER NOT NULL,
    PRIMARY KEY (giveaway, user)
  );
  `,
  // v3 - releases, the sneak-peek queue, polls and the suggestion board
  `
  CREATE TABLE IF NOT EXISTS releases (
    id        TEXT PRIMARY KEY,
    source    TEXT NOT NULL,
    project   TEXT,
    name      TEXT,
    version   TEXT,
    url       TEXT,
    published INTEGER,
    posted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT    NOT NULL,
    file      TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    bytes     INTEGER NOT NULL DEFAULT 0,
    caption   TEXT,
    who       TEXT,
    added     INTEGER NOT NULL,
    due       INTEGER,
    posted_at INTEGER,
    url       TEXT
  );
  CREATE INDEX IF NOT EXISTS queue_waiting ON queue (posted_at, due);
  CREATE TABLE IF NOT EXISTS polls (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    channel_id TEXT,
    question   TEXT,
    answers    TEXT,
    host       TEXT,
    created    INTEGER NOT NULL,
    ends       INTEGER,
    result     TEXT
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id         TEXT PRIMARY KEY,
    channel_id TEXT,
    author     TEXT,
    excerpt    TEXT,
    url        TEXT,
    at         INTEGER NOT NULL,
    up         INTEGER NOT NULL DEFAULT 0,
    down       INTEGER NOT NULL DEFAULT 0,
    digested   INTEGER
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
  giveawayNew() {}, giveawaySent() {}, giveawayGet() { return null; },
  giveawayLive() { return []; }, giveawayDue() { return []; }, giveawayAll() { return []; },
  giveawayEnter() { return false; }, giveawayLeave() { return false; },
  giveawayEntries() { return []; }, giveawayCount() { return 0; }, giveawayClose() {},
  releaseSeen() { return new Set(); }, releasePosted() {}, releases() { return []; },
  queueAdd() {}, queueWaiting() { return []; }, queueNext() { return null; },
  queueTaken() {}, queueDrop() {}, queueList() { return []; },
  pollNew() {}, pollClose() {}, polls() { return []; },
  suggestionSeen() { return null; }, suggestionNew() {}, suggestionScore() {},
  suggestionsSince() { return []; }, suggestionDigested() {},
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
    gNew: db.prepare('INSERT INTO giveaways (id, channel_id, prize, winners, role_id, host, created, ends) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    gSent: db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?'),
    gGet: db.prepare('SELECT * FROM giveaways WHERE id = ?'),
    gLive: db.prepare("SELECT * FROM giveaways WHERE state = 'running' ORDER BY ends"),
    gDue: db.prepare("SELECT * FROM giveaways WHERE state = 'running' AND ends <= ? ORDER BY ends"),
    gAll: db.prepare('SELECT * FROM giveaways ORDER BY created DESC LIMIT ?'),
    gClose: db.prepare('UPDATE giveaways SET state = ?, ended_at = ?, drawn = ? WHERE id = ?'),
    gEnter: db.prepare('INSERT INTO entries (giveaway, user, tag, at) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(giveaway, user) DO NOTHING'),
    gLeave: db.prepare('DELETE FROM entries WHERE giveaway = ? AND user = ?'),
    gEntries: db.prepare('SELECT user, tag, at FROM entries WHERE giveaway = ? ORDER BY at'),
    gCount: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE giveaway = ?'),
    rSeen: db.prepare('SELECT id FROM releases'),
    rNew: db.prepare('INSERT INTO releases (id, source, project, name, version, url, published, posted_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'),
    rList: db.prepare('SELECT * FROM releases ORDER BY posted_at DESC LIMIT ?'),
    qAdd: db.prepare('INSERT INTO queue (kind, file, name, bytes, caption, who, added, due) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    qWaiting: db.prepare('SELECT * FROM queue WHERE posted_at IS NULL ORDER BY id'),
    qNext: db.prepare('SELECT * FROM queue WHERE posted_at IS NULL AND (due IS NULL OR due <= ?) '
      + 'ORDER BY id LIMIT 1'),
    qTaken: db.prepare('UPDATE queue SET posted_at = ?, url = ? WHERE id = ?'),
    qDrop: db.prepare('DELETE FROM queue WHERE id = ? AND posted_at IS NULL'),
    qList: db.prepare('SELECT * FROM queue ORDER BY id DESC LIMIT ?'),
    pNew: db.prepare('INSERT INTO polls (id, kind, channel_id, question, answers, host, created, ends) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    pClose: db.prepare('UPDATE polls SET result = ? WHERE id = ?'),
    pList: db.prepare('SELECT * FROM polls ORDER BY created DESC LIMIT ?'),
    sGet: db.prepare('SELECT * FROM suggestions WHERE id = ?'),
    sNew: db.prepare('INSERT INTO suggestions (id, channel_id, author, excerpt, url, at) '
      + 'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'),
    sScore: db.prepare('UPDATE suggestions SET up = ?, down = ? WHERE id = ?'),
    sSince: db.prepare('SELECT * FROM suggestions WHERE at >= ? ORDER BY (up - down) DESC, up DESC LIMIT ?'),
    sDigested: db.prepare('UPDATE suggestions SET digested = ? WHERE id = ?'),
    size: db.prepare('SELECT (SELECT COUNT(*) FROM log) AS log, (SELECT COUNT(*) FROM events) AS events, '
      + '(SELECT COUNT(*) FROM packs) AS packs, (SELECT COUNT(*) FROM videos) AS videos, '
      + '(SELECT COUNT(*) FROM reports) AS reports, '
      + '(SELECT COUNT(*) FROM giveaways) AS giveaways, '
      + '(SELECT COUNT(*) FROM releases) AS releases, '
      + "(SELECT COUNT(*) FROM queue WHERE posted_at IS NULL) AS queued, "
      + '(SELECT COUNT(*) FROM polls) AS polls, '
      + '(SELECT COUNT(*) FROM suggestions) AS suggestions'),
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

    // ---- giveaways ------------------------------------------------------------------------
    // A running giveaway is the one thing here that only exists in the book: nobody can read the
    // entrants back off Discord, because clicking a button leaves no trace anyone else can see.

    /** Write down a giveaway before its message exists, so a crash between the two loses nothing. */
    giveawayNew: safe('writing a giveaway', (g) => {
      q.gNew.run(String(g.id), String(g.channelId), String(g.prize), Number(g.winners) || 1,
        g.roleId || null, g.host || null, Date.now(), Number(g.ends));
    }),
    /** ...and the message id once Discord has given us one. */
    giveawaySent: safe('writing a giveaway message', (id, messageId) => {
      q.gSent.run(String(messageId), String(id));
    }),
    giveawayGet: safe('reading a giveaway', (id) => q.gGet.get(String(id)) || null, null),
    giveawayLive: safe('listing the running giveaways', () => q.gLive.all(), []),
    giveawayDue: safe('listing the giveaways that are up', (now = Date.now()) => q.gDue.all(now), []),
    giveawayAll: safe('listing the giveaways', (n = 25) => q.gAll.all(n), []),
    /** @returns true if this is a new entry, false if they were already in */
    giveawayEnter: safe('writing an entry', (id, user, tag) => {
      const before = q.gCount.get(String(id)).n;
      q.gEnter.run(String(id), String(user), tag || null, Date.now());
      return q.gCount.get(String(id)).n > before;
    }, false),
    /** @returns true if they were in and are not any more */
    giveawayLeave: safe('removing an entry', (id, user) => {
      const before = q.gCount.get(String(id)).n;
      q.gLeave.run(String(id), String(user));
      return q.gCount.get(String(id)).n < before;
    }, false),
    giveawayEntries: safe('reading the entries', (id) => q.gEntries.all(String(id)), []),
    giveawayCount: safe('counting the entries', (id) => q.gCount.get(String(id)).n, 0),
    giveawayClose: safe('closing a giveaway', (id, state, drawn) => {
      q.gClose.run(String(state), Date.now(), drawn ? JSON.stringify(drawn) : null, String(id));
    }),

    // ---- releases -------------------------------------------------------------------------
    releaseSeen: safe('reading the releases', () => new Set(q.rSeen.all().map((r) => r.id)), new Set()),
    releasePosted: safe('writing a release', (r) => {
      q.rNew.run(String(r.id), String(r.source), r.project || null, r.name || null,
        r.version || null, r.url || null, Number(r.published) || null, Date.now());
    }),
    releases: safe('listing the releases', (n = 20) => q.rList.all(n), []),

    // ---- the queue ------------------------------------------------------------------------
    queueAdd: safe('queueing a picture', (p) => {
      q.qAdd.run(String(p.kind), String(p.file), String(p.name), Number(p.bytes) || 0,
        p.caption || null, p.who || null, Date.now(), Number(p.due) || null);
    }),
    queueWaiting: safe('reading the queue', () => q.qWaiting.all(), []),
    queueNext: safe('taking from the queue', (now = Date.now()) => q.qNext.get(now) || null, null),
    queueTaken: safe('marking one posted', (id, url) => { q.qTaken.run(Date.now(), url || null, Number(id)); }),
    queueDrop: safe('dropping one from the queue', (id) => { q.qDrop.run(Number(id)); }),
    queueList: safe('listing the queue', (n = 50) => q.qList.all(n), []),

    // ---- polls: Discord counts the votes, this only remembers that one was asked ------------
    pollNew: safe('writing a poll', (p) => {
      q.pNew.run(String(p.id), String(p.kind), p.channelId || null, p.question || null,
        JSON.stringify(p.answers || []), p.host || null, Date.now(), Number(p.ends) || null);
    }),
    pollClose: safe('writing a poll result', (id, result) => {
      q.pClose.run(JSON.stringify(result || []), String(id));
    }),
    polls: safe('listing the polls', (n = 20) => q.pList.all(n), []),

    // ---- the suggestion board ---------------------------------------------------------------
    suggestionSeen: safe('reading a suggestion', (id) => q.sGet.get(String(id)) || null, null),
    suggestionNew: safe('writing a suggestion', (s2) => {
      q.sNew.run(String(s2.id), s2.channelId || null, s2.author || null, s2.excerpt || null,
        s2.url || null, Number(s2.at) || Date.now());
    }),
    suggestionScore: safe('scoring a suggestion', (id, up, down) => {
      q.sScore.run(Number(up) || 0, Number(down) || 0, String(id));
    }),
    suggestionsSince: safe('reading the suggestions', (since, n = 5) => q.sSince.all(Number(since), n), []),
    suggestionDigested: safe('marking a suggestion digested', (id) => { q.sDigested.run(Date.now(), String(id)); }),

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
  giveawayNew: (g) => book.giveawayNew(g),
  giveawaySent: (id, messageId) => book.giveawaySent(id, messageId),
  giveawayGet: (id) => book.giveawayGet(id),
  giveawayLive: () => book.giveawayLive(),
  giveawayDue: (now) => book.giveawayDue(now),
  giveawayAll: (n) => book.giveawayAll(n),
  giveawayEnter: (id, user, tag) => book.giveawayEnter(id, user, tag),
  giveawayLeave: (id, user) => book.giveawayLeave(id, user),
  giveawayEntries: (id) => book.giveawayEntries(id),
  giveawayCount: (id) => book.giveawayCount(id),
  giveawayClose: (id, state, drawn) => book.giveawayClose(id, state, drawn),
  releaseSeen: () => book.releaseSeen(),
  releasePosted: (r) => book.releasePosted(r),
  releases: (n) => book.releases(n),
  queueAdd: (p) => book.queueAdd(p),
  queueWaiting: () => book.queueWaiting(),
  queueNext: (now) => book.queueNext(now),
  queueTaken: (id, url) => book.queueTaken(id, url),
  queueDrop: (id) => book.queueDrop(id),
  queueList: (n) => book.queueList(n),
  pollNew: (p) => book.pollNew(p),
  pollClose: (id, result) => book.pollClose(id, result),
  polls: (n) => book.polls(n),
  suggestionSeen: (id) => book.suggestionSeen(id),
  suggestionNew: (s) => book.suggestionNew(s),
  suggestionScore: (id, up, down) => book.suggestionScore(id, up, down),
  suggestionsSince: (since, n) => book.suggestionsSince(since, n),
  suggestionDigested: (id) => book.suggestionDigested(id),
  stats: () => book.stats(),
  close: () => book.close(),
};
