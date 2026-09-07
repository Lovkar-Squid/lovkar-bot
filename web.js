/**
 * The dashboard.
 *
 * <p>A small HTTP server bolted onto the same process as the bot, so it can answer from the live
 * gateway connection instead of a database. That is the whole design: the bot still holds no data
 * of its own. Bug reports are read out of the forum when the page asks for them, the numbers come
 * off the guild object, and the log is the last few hundred lines the bot printed, kept in memory.
 * Restart it and the log starts again - everything else is still on Discord where it belongs.</p>
 *
 * <p>Sign-in is Discord's own OAuth2, and it only establishes <em>who</em> you are. Whether you may
 * see anything is decided here, against the guild: you must be a member of it and either own it or
 * wear one of {@code DASH_ROLES}. Being logged in to Discord is not a permission.</p>
 *
 * <p>No framework: node's http, a signed cookie, and one page.</p>
 */

'use strict';

const packs = require('./packs');
const giveaways = require('./giveaways');

const http = require('node:http');
const crypto = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;

// ---- little helpers ------------------------------------------------------------------------

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString();

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/** Constant-time compare, so a wrong signature cannot be found a character at a time. */
function sameSig(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function seal(obj, secret) {
  const body = b64(JSON.stringify(obj));
  return `${body}.${sign(body, secret)}`;
}

function unseal(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!sameSig(sign(body, secret), sig)) return null;
  try {
    const obj = JSON.parse(unb64(body));
    return obj.exp && obj.exp > Date.now() ? obj : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString());
}

// ---- the server ----------------------------------------------------------------------------

/**
 * @param client       the logged-in discord.js client
 * @param opts.log     (...args) => void, the bot's own logger
 * @param opts.recent  () => string[], the log ring buffer
 * @param opts.stats   () => object, counters the bot keeps
 * @param opts.retriage (thread) => Promise<void>, re-run the triage on one post
 * @param opts.llm     the llm module, for describe()
 * @param opts.db      the book ({@link ./db.js}); the History tab is what it is for
 */
function start(client, opts) {
  const {
    log, recent, stats, retriage, llm,
    db = require('./db'),
    gw = opts.giveaways || giveaways,
    port = Number(process.env.DASH_PORT || 8081),
    guildId = process.env.GUILD_ID,
    clientId = process.env.DISCORD_CLIENT_ID,
    clientSecret = process.env.DISCORD_CLIENT_SECRET,
    baseUrl = process.env.DASH_BASE_URL,
    roles = (process.env.DASH_ROLES || 'Lovkar').split(',').map((s) => s.trim()).filter(Boolean),
    forumName = process.env.BUG_FORUM_NAME || 'bug-reports',
  } = opts;

  if (!clientId || !clientSecret || !baseUrl) {
    log('[dash] not started: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DASH_BASE_URL are all required');
    return null;
  }
  // The cookie secret is generated if none is given: that is safe, it only means everybody is
  // signed out when the bot restarts.
  const secret = process.env.DASH_SECRET || crypto.randomBytes(32).toString('hex');
  const redirect = `${baseUrl.replace(/\/+$/, '')}/callback`;

  const guild = () => (guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first());

  function forum(g) {
    return g.channels.cache.find(
      (c) => c.type === 15 && c.name.toLowerCase() === forumName.toLowerCase(),
    ) || null;
  }

  /** Who is asking, and may they. Returns null when they may not. */
  async function who(req) {
    const s = unseal(cookies(req).sid, secret);
    if (!s) return null;
    const g = guild();
    if (!g) return null;
    let member;
    try {
      member = await g.members.fetch(s.id);
    } catch {
      return null;                                       // left the server, or never was in it
    }
    const allowed = g.ownerId === s.id || member.roles.cache.some((r) => roles.includes(r.name));
    if (!allowed) return null;
    return { id: s.id, name: s.name, avatar: s.avatar, owner: g.ownerId === s.id };
  }

  // ---- what the page asks for --------------------------------------------------------------

  async function reports(g) {
    const f = forum(g);
    if (!f) return { forum: null, tags: [], posts: [] };
    const fetched = await f.threads.fetchActive().catch(() => null);
    const archived = await f.threads.fetchArchived({ limit: 50 }).catch(() => null);
    const all = new Map();
    for (const bag of [fetched, archived]) {
      if (bag) for (const [id, t] of bag.threads) all.set(id, t);
    }
    const byId = new Map(f.availableTags.map((t) => [t.id, t.name]));
    const posts = [...all.values()].map((t) => ({
      id: t.id,
      name: t.name,
      url: `https://discord.com/channels/${g.id}/${t.id}`,
      author: t.ownerId,
      created: t.createdTimestamp,
      archived: !!t.archived,
      messages: t.messageCount ?? 0,
      tags: (t.appliedTags || []).map((id) => byId.get(id)).filter(Boolean),
    }));
    posts.sort((a, b) => (b.created || 0) - (a.created || 0));
    return { forum: f.name, tags: f.availableTags.map((t) => t.name), posts };
  }

  async function server(g) {
    await g.members.fetch().catch(() => null);
    const roleRows = [...g.roles.cache.values()]
      .filter((r) => r.name !== '@everyone')
      .map((r) => ({ name: r.name, count: r.members.size, colour: r.hexColor }))
      .sort((a, b) => b.count - a.count);
    const joins = {};
    for (const m of g.members.cache.values()) {
      if (!m.joinedTimestamp) continue;
      const d = new Date(m.joinedTimestamp).toISOString().slice(0, 10);
      joins[d] = (joins[d] || 0) + 1;
    }
    return {
      name: g.name,
      members: g.memberCount,
      bots: g.members.cache.filter((m) => m.user.bot).size,
      boosts: g.premiumSubscriptionCount ?? 0,
      tier: g.premiumTier ?? 0,
      boosterRole: g.roles.premiumSubscriberRole?.name ?? null,
      channels: g.channels.cache.filter((c) => c.type !== 4).size,
      roles: roleRows,
      joins: Object.entries(joins).sort().map(([day, n]) => ({ day, n })),
    };
  }

  // ---- routes ------------------------------------------------------------------------------

  const server_ = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/healthz') return send(res, 200, { ok: true });

      if (path === '/login') {
        const state = seal({ n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 10 * 60 * 1000 }, secret);
        const to = new URL('https://discord.com/oauth2/authorize');
        to.searchParams.set('client_id', clientId);
        to.searchParams.set('redirect_uri', redirect);
        to.searchParams.set('response_type', 'code');
        to.searchParams.set('scope', 'identify');
        to.searchParams.set('state', state);
        return send(res, 302, '', {
          location: to.toString(),
          'set-cookie': `st=${encodeURIComponent(state)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax; Secure`,
        });
      }

      if (path === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state || state !== cookies(req).st || !unseal(state, secret)) {
          return send(res, 400, page('That sign-in did not come from here. <a href="/login">Try again</a>.'));
        }
        const form = new URLSearchParams({
          client_id: clientId, client_secret: clientSecret,
          grant_type: 'authorization_code', code, redirect_uri: redirect,
        });
        const tok = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
        }).then((r) => r.json());
        if (!tok.access_token) {
          log(`[dash] token exchange failed: ${tok.error_description || tok.error || 'no token'}`);
          return send(res, 502, page('Discord would not complete the sign-in. <a href="/login">Try again</a>.'));
        }
        const me = await fetch('https://discord.com/api/users/@me', {
          headers: { authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.json());
        if (!me.id) return send(res, 502, page('Discord did not say who you are. <a href="/login">Try again</a>.'));
        const sid = seal({ id: me.id, name: me.global_name || me.username, avatar: me.avatar, exp: Date.now() + 7 * DAY }, secret);
        log(`[dash] signed in: ${me.username} (${me.id})`);
        return send(res, 302, '', {
          location: '/',
          'set-cookie': [
            `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax; Secure`,
            'st=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure',
          ],
        });
      }

      if (path === '/logout') {
        return send(res, 302, '', {
          location: '/',
          'set-cookie': 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure',
        });
      }

      if (path === '/') {
        const user = await who(req);
        return send(res, 200, user ? page(null, user) : page(
          '<p class="lead">Sentinel keeps the bug forum in order for Lovkar\'s mods.</p>' +
          '<p><a class="btn" href="/login">Sign in with Discord</a></p>' +
          '<p class="dim small">Only the server\'s own staff can see anything here.</p>'));
      }

      // everything below wants a signed-in, allowed member
      const user = await who(req);
      if (!user) return send(res, 401, { error: 'not allowed' });
      const g = guild();
      if (!g) return send(res, 503, { error: 'the bot is not in a guild yet' });

      if (path === '/api/me') return send(res, 200, user);
      if (path === '/api/reports') return send(res, 200, await reports(g));
      if (path === '/api/server') return send(res, 200, await server(g));
      if (path === '/api/status') {
        return send(res, 200, {
          up: process.uptime(),
          started: Date.now() - process.uptime() * 1000,
          tag: client.user?.tag,
          ping: Math.round(client.ws.ping),
          llm: llm.describe(),
          ...stats(),
          log: recent(),
        });
      }

      if (path === '/api/history') {
        return send(res, 200, {
          book: db.stats(),
          packs: db.packs(20),
          videos: db.videos(15),
          reports: db.reports(20),
          events: db.events(40),
        });
      }

      // ---- the two things that write ---------------------------------------------------------
      if (req.method === 'POST' && path.startsWith('/api/reports/')) {
        // a cross-site form cannot set this header, and the cookie is SameSite=Lax
        if (req.headers['x-sentinel'] !== '1') return send(res, 403, { error: 'bad request' });
        const [, , , id, what] = path.split('/');
        const thread = await g.channels.fetch(id).catch(() => null);
        if (!thread || !thread.parent || thread.parent.name.toLowerCase() !== forumName.toLowerCase()) {
          return send(res, 404, { error: 'no such post in the bug forum' });
        }

        if (what === 'retriage') {
          await retriage(thread);
          log(`[dash] ${user.name} re-ran the triage on "${thread.name}"`);
          return send(res, 200, { ok: true });
        }

        if (what === 'tags') {
          const body = await readJson(req);
          const wanted = Array.isArray(body.tags) ? body.tags.map(String) : null;
          if (!wanted) return send(res, 400, { error: 'tags must be a list of tag names' });
          const ids = wanted
            .map((n) => thread.parent.availableTags.find((t) => t.name.toLowerCase() === n.toLowerCase()))
            .filter(Boolean).map((t) => t.id).slice(0, 5);
          await thread.setAppliedTags(ids, `changed by ${user.name} from the dashboard`);
          log(`[dash] ${user.name} set tags on "${thread.name}": ${wanted.join(', ') || '(none)'}`);
          return send(res, 200, { ok: true, tags: wanted });
        }
      }

      // ---- giveaways: a prize, a deadline, a button ------------------------------------------
      if (path === '/giveaways') return send(res, 200, giveawaysPage(user, g));

      if (path === '/api/giveaways') return send(res, 200, { book: db.ready, list: gw.list(30) });

      if (req.method === 'POST' && path.startsWith('/api/giveaways')) {
        if (req.headers['x-sentinel'] !== '1') return send(res, 403, { error: 'bad request' });
        const body = await readJson(req);
        const [, , , id, what] = path.split('/');
        try {
          if (!id) {
            const out = await gw.start(g, {
              prize: body.prize, lasts: body.lasts, winners: body.winners,
              channel: body.channel, role: body.role, host: user.name,
            }, log);
            return send(res, 200, { ok: true, ...out });
          }
          if (what === 'end') {
            const out = await gw.finish(client, id, log, 'ended early by ' + user.name);
            if (!out) return send(res, 409, { error: 'that one is not running' });
            log(`[giveaway] ${user.name} ended one early`);
            return send(res, 200, { ok: true, ...out });
          }
          if (what === 'reroll') {
            const more = await gw.reroll(client, id, Number(body.howMany) || 1, log);
            log(`[giveaway] ${user.name} redrew one`);
            return send(res, 200, { ok: true, winners: more });
          }
          if (what === 'cancel') {
            const out = await gw.cancel(client, id, log);
            log(`[giveaway] ${user.name} called one off`);
            return send(res, 200, { ok: true, ...out });
          }
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
        return send(res, 404, { error: 'no such thing here' });
      }

      // ---- packs: a handful of pictures, straight to the channel they belong in ---------------
      if (path === '/packs') {
        return send(res, 200, packsPage(user));
      }

      if (req.method === 'POST' && path === '/api/packs') {
        if (req.headers['x-sentinel'] !== '1') return send(res, 403, { error: 'bad request' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          // the per-file limit times the file limit, and a little room for the form itself
          if (size > packs.MAX_BYTES * packs.MAX_FILES + 65536) {
            return send(res, 413, { error: 'that is more than this will carry' });
          }
          chunks.push(chunk);
        }
        let form;
        try {
          form = packs.multipart(Buffer.concat(chunks), req.headers['content-type']);
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
        try {
          const out = await packs.post(g, form.fields.kind, form.files, form.fields.caption,
            user.name, log);
          return send(res, 200, { ok: true, ...out });
        } catch (e) {
          log(`[packs] ${user.name}: ${e.message}`);
          return send(res, 400, { error: e.message });
        }
      }

      return send(res, 404, { error: 'no such thing here' });
    } catch (e) {
      log(`[dash] ${req.method} ${path}: ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: 'something broke - it is in the log' });
    }
  });

  server_.listen(port, '0.0.0.0', () => log(`[dash] listening on :${port}  (${baseUrl})`));
  return server_;
}

// ---- the page ------------------------------------------------------------------------------

function page(message, user) {
  const shell = (inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel</title><style>
:root{--bg:#0e0e12;--card:#16161c;--line:#2a2a33;--ink:#ece6de;--dim:#928e8a;--gold:#e2b24a;
--hot:#ff7a45;--warm:#ffab3d;--cool:#7fc4ff;--ok:#6fcf7f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
a{color:var(--gold)}.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px;flex-wrap:wrap}
h1{font-size:20px;margin:0;letter-spacing:.2px}.dim{color:var(--dim)}.small{font-size:12px}
.lead{font-size:16px;color:var(--dim);max-width:52ch}
.btn{display:inline-block;background:var(--gold);color:#1a1408;padding:9px 16px;border-radius:7px;
text-decoration:none;font-weight:600;border:0;cursor:pointer;font-size:14px}
.btn.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
nav{margin-left:auto;display:flex;gap:6px}
nav button{background:transparent;border:1px solid transparent;color:var(--dim);padding:6px 12px;
border-radius:7px;cursor:pointer;font:inherit}
nav button.on{background:var(--card);border-color:var(--line);color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:16px 18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;letter-spacing:.09em;
text-transform:uppercase;color:var(--dim);font-weight:600;padding:0 10px 8px 0}
td{padding:10px 10px 10px 0;border-top:1px solid var(--line);vertical-align:top}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);
margin:0 4px 4px 0;color:var(--dim);white-space:nowrap}
.tag.critical{color:var(--hot);border-color:#5a2a18}.tag.major{color:var(--warm);border-color:#5a4018}
.tag.minor{color:#d9d36a;border-color:#4d4a1c}.tag.fixed{color:var(--ok);border-color:#20421f}
.tag.needslog{color:var(--cool);border-color:#1d3a52}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 16px}
.stat b{display:block;font-size:24px;font-weight:600;letter-spacing:-.5px}
pre{background:#0b0b0e;border:1px solid var(--line);border-radius:9px;padding:12px;overflow:auto;
max-height:460px;font-size:12px;line-height:1.55;margin:0}
select,input{background:#0b0b0e;color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font:inherit}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bar{height:7px;background:#0b0b0e;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--gold)}
.empty{color:var(--dim);padding:22px 0;text-align:center}
</style></head><body><div class="wrap">${inner}</div></body></html>`;

  if (!user) {
    return shell(`<header><h1>Sentinel</h1><span class="dim small">Lovkar's mods</span></header>
      <div class="card">${message || ''}</div>`);
  }
  return shell(`<header><h1>Sentinel</h1>
    <span class="dim small">signed in as ${escapeHtml(user.name)}</span>
    <nav>
      <button class="on" data-tab="reports">Reports</button>
      <button data-tab="server">Server</button>
      <button data-tab="bot">Bot</button>
      <button data-tab="history">History</button>
      <a class="btn ghost" href="/packs" style="padding:6px 12px">Packs</a>
      <a class="btn ghost" href="/giveaways" style="padding:6px 12px">Giveaways</a>
      <a class="btn ghost" href="/logout" style="padding:6px 12px">Sign out</a>
    </nav></header>
    <div id="view"><div class="empty">loading…</div></div>
    <script>${APP}</script>`);
}

/**
 * The Packs page: pick a pack, drop the pictures on it, say a line, send.
 *
 * <p>Deliberately its own page rather than a tab: it is the one place in this dashboard that
 * writes something everybody in the server will see, and it should feel like it.</p>
 */
function packsPage(user) {
  const options = packs.kinds().map((k) => {
    const p = packs.about(k);
    return `<label class="pick"><input type="radio" name="kind" value="${k}"${k === 'sneak' ? ' checked' : ''}>
      <span><b>${escapeHtml(p.label)}</b><br><span class="dim small">#${escapeHtml(p.channel)} — ${escapeHtml(p.blurb)}</span></span></label>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Packs · Sentinel</title><style>
:root{--bg:#0e0e12;--card:#16161c;--line:#2a2a33;--ink:#ece6de;--dim:#928e8a;--gold:#e2b24a;--ok:#6fcf7f;--bad:#ff7a45}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
a{color:var(--gold)}.wrap{max-width:760px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--line);
padding-bottom:14px;margin-bottom:22px;flex-wrap:wrap}
h1{font-size:20px;margin:0}.dim{color:var(--dim)}.small{font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
.pick{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid var(--line);
border-radius:10px;margin-bottom:10px;cursor:pointer}
.pick:has(input:checked){border-color:var(--gold);background:#1c1a16}
input[type=file]{width:100%;padding:14px;border:1px dashed var(--line);border-radius:10px;
background:#101016;color:var(--ink)}
textarea{width:100%;min-height:74px;padding:10px;border:1px solid var(--line);border-radius:10px;
background:#101016;color:var(--ink);font:inherit;resize:vertical}
.btn{display:inline-block;background:var(--gold);color:#1a1408;border:0;border-radius:8px;
padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
.btn[disabled]{opacity:.5;cursor:default}
.btn.ghost{background:transparent;color:var(--gold);border:1px solid var(--line);font-weight:400}
#out{margin-top:14px}.ok{color:var(--ok)}.bad{color:var(--bad)}
ul{margin:8px 0 0;padding-left:18px}
</style></head><body><div class="wrap">
<header><h1>Packs</h1><span class="dim small">signed in as ${escapeHtml(user.name)}</span>
  <span style="margin-left:auto"><a class="btn ghost" href="/" style="padding:6px 12px">Back</a></span>
</header>
<div class="card">
  <p class="dim">A handful of pictures, posted to the channel they belong in. Nothing is kept here —
  they go straight to Discord.</p>
  <form id="f">
    ${options}
    <p style="margin:16px 0 6px" class="dim small">Pictures or clips — up to ${packs.MAX_FILES},
      ${packs.MAX_BYTES / 1048576} MB each. More than ${packs.PER_MESSAGE} becomes several messages.</p>
    <input type="file" name="files" multiple accept="image/*,video/mp4,video/webm">
    <p style="margin:16px 0 6px" class="dim small">What to say above them (optional).</p>
    <textarea name="caption" placeholder="Leave it empty and the pack says its own line."></textarea>
    <p style="margin-top:16px"><button class="btn" id="go">Post it</button></p>
  </form>
  <div id="out"></div>
</div>
<script>
const f = document.getElementById('f'), go = document.getElementById('go'), out = document.getElementById('out');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(f);
  if (!data.getAll('files').filter((x) => x.size).length) {
    out.innerHTML = '<span class="bad">Pick some pictures first.</span>'; return;
  }
  go.disabled = true; out.textContent = 'sending…';
  try {
    const r = await fetch('/api/packs', { method: 'POST', headers: { 'x-sentinel': '1' }, body: data });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'it did not go');
    out.innerHTML = '<span class="ok">Posted ' + j.files + ' to #' + j.channel + '.</span><ul>' +
      j.urls.map((u) => '<li><a href="' + u + '">' + u + '</a></li>').join('') + '</ul>';
    f.reset();
  } catch (err) {
    out.innerHTML = '<span class="bad">' + err.message + '</span>';
  } finally { go.disabled = false; }
});
</script>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The Giveaways page: a prize, how long, how many win, and the button does the rest.
 *
 * <p>Its own page for the same reason Packs is: it writes something the whole server sees. The
 * list underneath is read out of the book, which is the only place the entrants exist.</p>
 */
function giveawaysPage(user, guild) {
  const channels = [...guild.channels.cache.values()]
    .filter((c) => typeof c.send === 'function' && c.type !== 4)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => `<option value="${escapeHtml(c.name)}"${c.name === (process.env.GIVEAWAY_CHANNEL || 'giveaways') ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`)
    .join('');
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.name !== '@everyone')
    .sort((a, b) => b.rawPosition - a.rawPosition)
    .map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Giveaways · Sentinel</title><style>
:root{--bg:#0e0e12;--card:#16161c;--line:#2a2a33;--ink:#ece6de;--dim:#928e8a;--gold:#e2b24a;--ok:#6fcf7f;--bad:#ff7a45}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
a{color:var(--gold)}.wrap{max-width:860px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--line);
padding-bottom:14px;margin-bottom:22px;flex-wrap:wrap}
h1{font-size:20px;margin:0}h3{margin:0 0 12px;font-size:15px}.dim{color:var(--dim)}.small{font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
label{display:block;margin-bottom:12px}label>span{display:block;margin-bottom:5px}
input,select,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:9px;
background:#101016;color:var(--ink);font:inherit}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1 1 160px}
.btn{display:inline-block;background:var(--gold);color:#1a1408;border:0;border-radius:8px;
padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
.btn[disabled]{opacity:.5;cursor:default}
.btn.ghost{background:transparent;color:var(--gold);border:1px solid var(--line);font-weight:400;padding:6px 12px}
table{width:100%;border-collapse:collapse}td{padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}
tr:first-child td{border-top:0}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
.won{color:var(--gold);margin-top:2px}
.live{color:#1a1408;background:var(--gold);border-color:var(--gold)}
#out{margin-top:14px}.ok{color:var(--ok)}.bad{color:var(--bad)}
.empty{color:var(--dim);padding:20px 0;text-align:center}
</style></head><body><div class="wrap">
<header><h1>Giveaways</h1><span class="dim small">signed in as ${escapeHtml(user.name)}</span>
  <span style="margin-left:auto"><a class="btn ghost" href="/">Back</a></span>
</header>

<div class="card">
  <p class="dim">The bot posts it, people press the button, and it draws the winners itself when the
  time is up — even if it was restarted in between.</p>
  <form id="f">
    <label><span>Prize</span><input name="prize" placeholder="A copy of the modpack, early access, a key…" maxlength="200" required></label>
    <div class="row">
      <label><span>Runs for</span><input name="lasts" value="24h" placeholder="30m · 2h · 3d" required></label>
      <label><span>Winners</span><input name="winners" type="number" min="1" max="${giveaways.MAX_WINNERS}" value="1"></label>
    </div>
    <div class="row">
      <label><span>Channel</span><select name="channel">${channels}</select></label>
      <label><span>Only this role may enter</span><select name="role"><option value="">anyone</option>${roles}</select></label>
    </div>
    <p style="margin-top:8px"><button class="btn" id="go">Start it</button></p>
  </form>
  <div id="out"></div>
</div>

<div class="card"><h3>What has been run</h3><div id="list"><div class="empty">loading…</div></div></div>

<script>
const f = document.getElementById('f'), go = document.getElementById('go'), out = document.getElementById('out');
const list = document.getElementById('list');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when = (ms) => {
  const s = (ms - Date.now()) / 1000, a = Math.abs(s);
  const n = a < 90 ? Math.round(a) + 's' : a < 5400 ? Math.round(a / 60) + ' min' : a < 172800 ? Math.round(a / 3600) + ' h' : Math.round(a / 86400) + ' d';
  return s > 0 ? 'in ' + n : n + ' ago';
};
const call = (p, body) => fetch(p, {
  method: 'POST', headers: { 'x-sentinel': '1', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'it did not go'); return j; });

async function draw() {
  const d = await fetch('/api/giveaways', { headers: { 'x-sentinel': '1' } }).then(r => r.json());
  if (!d.book) { list.innerHTML = '<div class="empty">The bot is not keeping a book, so it cannot run a giveaway. Mount a volume at <b>/data</b> and restart it.</div>'; return; }
  if (!d.list.length) { list.innerHTML = '<div class="empty">none yet</div>'; return; }
  list.innerHTML = '<table><tbody>' + d.list.map(g => {
    const live = g.state === 'running';
    const won = (g.won || []).length;
    const names = (g.won || []).map(w => esc(w.tag || w.id)).join(', ');
    return '<tr data-id="' + g.id + '">' +
      '<td><b>' + esc(g.prize) + '</b>' +
        (won ? '<div class="won">🎉 ' + names + '</div>'
             : !live && g.state !== 'cancelled' ? '<div class="small dim">nobody entered</div>' : '') +
        '<div class="small dim">' +
        (live ? 'ends ' + when(g.ends) : g.state === 'cancelled' ? 'called off' : 'ended ' + when(g.ended_at || g.ends)) +
        ' · ' + g.entries + ' ' + (g.entries === 1 ? 'entry' : 'entries') +
        ' · ' + g.winners + ' winner' + (g.winners === 1 ? '' : 's') +
        (g.host ? ' · by ' + esc(g.host) : '') + '</div></td>' +
      '<td style="width:90px"><span class="pill' + (live ? ' live' : '') + '">' + (live ? 'running' : g.state) + '</span></td>' +
      '<td style="width:210px;text-align:right">' +
        (live
          ? '<button class="btn ghost end">end now</button> <button class="btn ghost off">call off</button>'
          : (g.entries > won ? '<button class="btn ghost again">draw another</button>' : '')) +
      '</td></tr>';
  }).join('') + '</tbody></table>';

  list.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    const run = async (what, body) => {
      tr.style.opacity = .5;
      try { await call('/api/giveaways/' + id + '/' + what, body); } catch (e) { out.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; }
      draw();
    };
    tr.querySelector('.end')?.addEventListener('click', () => run('end'));
    tr.querySelector('.off')?.addEventListener('click', () => run('cancel'));
    tr.querySelector('.again')?.addEventListener('click', () => run('reroll', { howMany: 1 }));
  });
}

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  go.disabled = true; out.textContent = 'starting…';
  const d = Object.fromEntries(new FormData(f));
  try {
    const j = await call('/api/giveaways', d);
    out.innerHTML = '<span class="ok">It is up in #' + esc(j.channel) + '.</span> <a href="' + esc(j.url) + '">open it</a>';
    f.reset();
  } catch (err) {
    out.innerHTML = '<span class="bad">' + esc(err.message) + '</span>';
  }
  go.disabled = false;
  draw();
});

draw();
setInterval(() => { if (document.visibilityState === 'visible') draw(); }, 20000);
</script>
</div></body></html>`;
}

// The page's own script. Kept as one string so the whole dashboard is a single file.
const APP = String.raw`
const view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cls = (t) => 'tag ' + t.toLowerCase().replace(/[^a-z]/g, '');
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};
const get = (p) => fetch(p, { headers: { 'x-sentinel': '1' } }).then(r => r.json());
const post = (p, body) => fetch(p, {
  method: 'POST', headers: { 'x-sentinel': '1', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json());

let tab = 'reports';
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  tab = b.dataset.tab; draw();
});

const SEV = ['Critical', 'Major', 'Minor'];

async function drawReports() {
  const d = await get('/api/reports');
  if (!d.posts || !d.posts.length) { view.innerHTML = '<div class="card"><div class="empty">No posts in #' + esc(d.forum || 'bug-reports') + ' yet.</div></div>'; return; }
  const counts = {};
  for (const p of d.posts) for (const t of p.tags) counts[t] = (counts[t] || 0) + 1;
  const chips = SEV.map(s => '<div class="stat"><b>' + (counts[s] || 0) + '</b><span class="dim small">' + s + '</span></div>').join('')
    + '<div class="stat"><b>' + (counts['needs log'] || 0) + '</b><span class="dim small">needs log</span></div>'
    + '<div class="stat"><b>' + (counts['fixed'] || 0) + '</b><span class="dim small">fixed</span></div>'
    + '<div class="stat"><b>' + d.posts.length + '</b><span class="dim small">posts</span></div>';
  const rows = d.posts.map(p => {
    const sev = p.tags.find(t => SEV.includes(t)) || '';
    return '<tr data-id="' + p.id + '">' +
      '<td><a href="' + p.url + '" target="_blank" rel="noreferrer">' + esc(p.name) + '</a>' +
      '<div class="small dim">' + ago(p.created) + ' · ' + p.messages + ' replies' + (p.archived ? ' · archived' : '') + '</div></td>' +
      '<td>' + p.tags.map(t => '<span class="' + cls(t) + '">' + esc(t) + '</span>').join('') + '</td>' +
      '<td class="row">' +
        '<select class="sev">' + ['(none)', ...SEV].map(s => '<option' + (s === (sev || '(none)') ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>' +
        '<button class="btn ghost fix">' + (p.tags.includes('fixed') ? 'unfix' : 'fixed') + '</button>' +
        '<button class="btn ghost again">re-triage</button>' +
      '</td></tr>';
  }).join('');
  view.innerHTML = '<div class="grid" style="margin-bottom:16px">' + chips + '</div>' +
    '<div class="card"><table><thead><tr><th>Post</th><th>Tags</th><th style="width:330px">Change</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<p class="dim small">Tags written here go straight onto the post in Discord.</p>';

  view.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    const p = d.posts.find(x => x.id === id);
    const setTags = async (tags) => { tr.style.opacity = .5; await post('/api/reports/' + id + '/tags', { tags }); draw(); };
    tr.querySelector('.sev').onchange = (e) => {
      const keep = p.tags.filter(t => !SEV.includes(t));
      setTags(e.target.value === '(none)' ? keep : [...keep, e.target.value]);
    };
    tr.querySelector('.fix').onclick = () => {
      const has = p.tags.includes('fixed');
      setTags(has ? p.tags.filter(t => t !== 'fixed') : [...p.tags, 'fixed']);
    };
    tr.querySelector('.again').onclick = async () => { tr.style.opacity = .5; await post('/api/reports/' + id + '/retriage'); setTimeout(draw, 1500); };
  });
}

async function drawServer() {
  const s = await get('/api/server');
  const most = Math.max(1, ...s.roles.map(r => r.count));
  view.innerHTML =
    '<div class="grid" style="margin-bottom:16px">' +
      '<div class="stat"><b>' + s.members + '</b><span class="dim small">members</span></div>' +
      '<div class="stat"><b>' + s.bots + '</b><span class="dim small">bots</span></div>' +
      '<div class="stat"><b>' + s.boosts + '</b><span class="dim small">boosts · tier ' + s.tier + '</span></div>' +
      '<div class="stat"><b>' + s.channels + '</b><span class="dim small">channels</span></div>' +
    '</div>' +
    '<div class="card"><h3 style="margin:0 0 12px">Roles</h3><table><tbody>' +
      s.roles.map(r => '<tr><td style="width:180px">' + esc(r.name) + '</td>' +
        '<td><div class="bar"><i style="width:' + (r.count / most * 100) + '%;background:' + (r.colour === '#000000' ? 'var(--gold)' : r.colour) + '"></i></div></td>' +
        '<td style="width:50px;text-align:right" class="dim">' + r.count + '</td></tr>').join('') +
    '</tbody></table></div>' +
    (s.boosterRole ? '' : '<p class="dim small">No <b>Server Booster</b> role yet — Discord makes it with the first boost. The bot opens the boosted channels to it the moment it appears.</p>') +
    '<div class="card"><h3 style="margin:0 0 12px">Who joined, by day</h3><table><tbody>' +
      s.joins.slice(-14).map(j => '<tr><td style="width:110px" class="dim small">' + j.day + '</td>' +
        '<td><div class="bar"><i style="width:' + Math.min(100, j.n * 20) + '%"></i></div></td>' +
        '<td style="width:40px;text-align:right" class="dim">' + j.n + '</td></tr>').join('') +
    '</tbody></table></div>';
}

async function drawBot() {
  const s = await get('/api/status');
  const h = Math.floor(s.up / 3600), m = Math.floor((s.up % 3600) / 60);
  view.innerHTML =
    '<div class="grid" style="margin-bottom:16px">' +
      '<div class="stat"><b>' + (h ? h + 'h ' : '') + m + 'm</b><span class="dim small">uptime</span></div>' +
      '<div class="stat"><b>' + s.ping + ' ms</b><span class="dim small">gateway</span></div>' +
      '<div class="stat"><b>' + (s.triaged ?? 0) + '</b><span class="dim small">posts triaged</span></div>' +
      '<div class="stat"><b>' + (s.rolesGiven ?? 0) + '</b><span class="dim small">roles handed out</span></div>' +
      '<div class="stat"><b>' + (s.ogGiven ?? 0) + '</b><span class="dim small">OG badges</span></div>' +
      '<div class="stat"><b>' + (s.videosPosted ?? 0) + '</b><span class="dim small">videos announced</span></div>' +
    '</div>' +
    '<p class="dim small" style="margin:-6px 0 16px">Totals since the bot first ran' +
      (s.since ? ' — this run: ' + Object.entries(s.since).filter(([, n]) => n).map(([k, n]) => n + ' ' + k).join(', ') || ' — nothing yet this run' : '') + '</p>' +
    '<div class="card"><div class="row"><b>' + esc(s.tag || '') + '</b>' +
      '<span class="dim small">second opinion: ' + esc(s.llm || 'none') + '</span>' +
      '<span class="dim small">book: ' + (s.book && s.book.ready ? esc(s.book.where) + ' · ' + bytes(s.book.bytes) : 'none — nothing is being remembered') + '</span>' +
    '</div></div>' +
    '<div class="card"><h3 style="margin:0 0 12px">Log</h3><pre>' + esc((s.log || []).join('\n')) + '</pre></div>';
}

const bytes = (n) => !n ? '0 B' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

async function drawHistory() {
  const d = await get('/api/history');
  if (!d.book || !d.book.ready) {
    view.innerHTML = '<div class="card"><div class="empty">The bot is not keeping a book right now, so there is no history.' +
      '<div class="small" style="margin-top:8px">Mount a volume at <b>/data</b> (or set <b>DB_PATH</b>) and restart it.</div></div></div>';
    return;
  }
  const rows = (list, cols) => list.length
    ? '<table><tbody>' + list.map(r => '<tr>' + cols(r).map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
    : '<div class="empty">nothing yet</div>';

  view.innerHTML =
    '<div class="grid" style="margin-bottom:16px">' +
      '<div class="stat"><b>' + (d.book.rows ? d.book.rows.packs : 0) + '</b><span class="dim small">packs posted</span></div>' +
      '<div class="stat"><b>' + (d.book.rows ? d.book.rows.videos : 0) + '</b><span class="dim small">videos announced</span></div>' +
      '<div class="stat"><b>' + (d.book.rows ? d.book.rows.reports : 0) + '</b><span class="dim small">posts triaged</span></div>' +
      '<div class="stat"><b>' + bytes(d.book.bytes) + '</b><span class="dim small">the book</span></div>' +
    '</div>' +
    '<div class="card"><h3 style="margin:0 0 12px">Packs</h3>' + rows(d.packs, p => [
      '<b>' + esc(p.kind === 'bts' ? 'Behind the scenes' : 'Sneak peek') + '</b>' +
        '<div class="small dim">' + esc(p.names || '') + '</div>',
      '<span class="dim small">#' + esc(p.channel || '') + ' · ' + p.files + ' file' + (p.files === 1 ? '' : 's') +
        ' · ' + bytes(p.bytes) + '</span>',
      '<span class="dim small">' + esc(p.who || '') + ' · ' + ago(p.at) + '</span>',
      p.url ? '<a href="' + esc(p.url) + '" target="_blank" rel="noreferrer">open</a>' : '',
    ]) + '</div>' +
    '<div class="card"><h3 style="margin:0 0 12px">Videos</h3>' + rows(d.videos, v => [
      '<a href="' + esc(v.url || '#') + '" target="_blank" rel="noreferrer">' + esc(v.title || v.id) + '</a>',
      '<span class="dim small">' + ago(v.posted_at) + '</span>',
    ]) + '</div>' +
    '<div class="card"><h3 style="margin:0 0 12px">What happened</h3>' + rows(d.events, e => [
      '<span class="tag ' + esc(e.kind) + '">' + esc(e.kind) + '</span>',
      esc(e.subject || ''),
      '<span class="dim small">' + esc(e.detail || '') + '</span>',
      '<span class="dim small">' + ago(e.at) + '</span>',
    ]) + '</div>';
}

async function draw() {
  view.innerHTML = '<div class="empty">loading…</div>';
  try {
    if (tab === 'reports') await drawReports();
    else if (tab === 'server') await drawServer();
    else if (tab === 'history') await drawHistory();
    else await drawBot();
  } catch (e) {
    view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>';
  }
}
draw();
setInterval(() => { if (document.visibilityState === 'visible') draw(); }, 30000);
`;

// the crypto and cookie helpers are exported so test-web.js can hold them to account
module.exports = { start, _internals: { seal, unseal, sign, sameSig, cookies, page, packsPage, giveawaysPage } };
