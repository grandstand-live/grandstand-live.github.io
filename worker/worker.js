/* Grandstand API — a Cloudflare Worker with one D1 database.

   Accounts, the calls leaderboard, post-match ratings, and web push for
   kick-offs, goals and results. Everything lives in the D1 binding `DB`;
   the tables are created on first use and the push keys are generated on
   first use, so deploying is: paste this file, bind the database, add a
   cron trigger. See README.md next to it.

   The Worker reads ESPN's public scoreboards, the LoL esports API, and the
   CS2 and Valorant files the site itself publishes. Whether each answers a
   Cloudflare request is checked at /api/health — if one doesn't, what
   depends on it stands down and the rest keeps working. Password-reset
   mail goes out through Brevo or Resend when a key for one is set. */

const ORIGINS = ['https://grandstand-live.github.io', 'http://localhost:8099'];
// site.api.espn.com turns Cloudflare away (403); site.web.api serves the same API and answers
const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports/';
const LOL = 'https://esports-api.lolesports.com/persisted/gw/';
// the public key the lolesports site itself sends
const LOL_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const DAY = 86400000;
const MIN = 60000;
// a login lasts as long as it keeps being used, and ends after this long unused
const SESSION_IDLE = 30 * DAY;
const RESET_TTL = 30 * MIN;

// Password hashing has to fit the free plan's 10 ms of CPU per request, so
// the iteration count is modest and can be raised with a PBKDF2_ITER
// variable on a paid plan. Each hash stores its own count, so raising it
// later never locks anyone out.
const DEFAULT_ITER = 10000;

/* ---------------------------------------------------------------- utils */

const enc = new TextEncoder();
function b64u(bytes) {
  let s = '';
  bytes = new Uint8Array(bytes);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function randomToken(n = 24) { return b64u(crypto.getRandomValues(new Uint8Array(n))); }

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(req, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) }
  });
}
class HttpError extends Error {
  constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; }
}
const bad = (msg) => new HttpError(400, msg);

async function body(req) {
  try { return await req.json(); } catch (e) { throw bad('invalid json'); }
}

/* --------------------------------------------------------------- schema */

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL,
       nick TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, iter INTEGER NOT NULL,
       created INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL,
       seen INTEGER)`,
    `CREATE TABLE IF NOT EXISTS picks (user_id INTEGER NOT NULL, pkey TEXT NOT NULL, sport TEXT, event TEXT,
       league TEXT, side TEXT, starts INTEGER, made INTEGER, home TEXT, away TEXT, result TEXT, score TEXT,
       hit INTEGER, settled INTEGER, verified INTEGER DEFAULT 0, ref TEXT, PRIMARY KEY (user_id, pkey))`,
    `CREATE TABLE IF NOT EXISTS attempts (k TEXT PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL, until INTEGER)`,
    `CREATE TABLE IF NOT EXISTS resets (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ratings (user_id INTEGER NOT NULL, event TEXT NOT NULL, player TEXT NOT NULL,
       name TEXT, team TEXT, score INTEGER NOT NULL, at INTEGER, PRIMARY KEY (user_id, event, player))`,
    `CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
       user_id INTEGER, follows TEXT, lang TEXT, created INTEGER, fails INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS watch (event TEXT PRIMARY KEY, state TEXT, score TEXT, notified TEXT, at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`,
    `CREATE INDEX IF NOT EXISTS picks_user ON picks(user_id)`,
    `CREATE INDEX IF NOT EXISTS picks_open ON picks(verified, starts)`,
    `CREATE INDEX IF NOT EXISTS ratings_event ON ratings(event)`
  ].map((s) => env.DB.prepare(s)));
  // columns added since the first release, to a database made before them
  const v = await env.DB.prepare("SELECT v FROM config WHERE k = 'schema'").first();
  if (!v || Number(v.v) < 2) {
    for (const s of ['ALTER TABLE sessions ADD COLUMN seen INTEGER', 'ALTER TABLE picks ADD COLUMN ref TEXT']) {
      try { await env.DB.prepare(s).run(); } catch (e) { /* already there */ }
    }
    await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('schema', '2')").run();
  }
  schemaReady = true;
}

/* ----------------------------------------------------------- rate limits
   Counted per key — an address, or where the request came from — in a
   window. Past the limit the key is shut until the window has run out
   again; the check comes before any password is hashed, so a flood costs
   next to nothing. */

const LIMITS = {
  login: [5, 15 * MIN],       // wrong passwords for one address
  loginIp: [30, 15 * MIN],    // wrong passwords from one place, any address
  register: [5, 60 * MIN],
  reset: [3, 60 * MIN],       // reset mails to one address
  resetIp: [10, 60 * MIN],
  resetUse: [10, 15 * MIN]    // bad reset links from one place
};
function ipOf(req) { return req.headers.get('CF-Connecting-IP') || 'local'; }

async function shut(env, keys) {
  const now = Date.now();
  for (const k of keys) {
    const row = await env.DB.prepare('SELECT until FROM attempts WHERE k = ?1').bind(k).first();
    if (row && row.until && row.until > now) {
      throw new HttpError(429, 'too many attempts', { retry: Math.ceil((row.until - now) / MIN) });
    }
  }
}
async function strike(env, k, kind) {
  const [max, win] = LIMITS[kind];
  const now = Date.now();
  const row = await env.DB.prepare('SELECT * FROM attempts WHERE k = ?1').bind(k).first();
  const fresh = !row || row.since < now - win;
  const n = fresh ? 1 : row.n + 1;
  await env.DB.prepare(`INSERT INTO attempts (k, n, since, until) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (k) DO UPDATE SET n = excluded.n, since = excluded.since, until = excluded.until`)
    .bind(k, n, fresh ? now : row.since, n >= max ? now + win : null).run();
}
async function forgive(env, k) {
  await env.DB.prepare('DELETE FROM attempts WHERE k = ?1').bind(k).run();
}

/* ------------------------------------------------------------- accounts */

async function hashPassword(password, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(saltB64), iterations: iter }, key, 256);
  return b64u(bits);
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function session(env, userId) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created, seen) VALUES (?1, ?2, ?3, ?3)')
    .bind(token, userId, now).run();
  return token;
}
async function whoIs(req, env) {
  const m = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const u = await env.DB.prepare(
    'SELECT u.id, u.nick, u.email, COALESCE(s.seen, s.created) AS seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1'
  ).bind(m[1]).first();
  if (!u) return null;
  const now = Date.now();
  if (u.seen < now - SESSION_IDLE) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(m[1]).run();
    return null;
  }
  // kept alive by use; written at most once a day
  if (u.seen < now - DAY) await env.DB.prepare('UPDATE sessions SET seen = ?2 WHERE token = ?1').bind(m[1], now).run();
  return u;
}
async function sha256(text) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
async function mustBe(req, env) {
  const u = await whoIs(req, env);
  if (!u) throw new HttpError(401, 'login required');
  return u;
}

async function register(req, env) {
  const b = await body(req);
  const email = String(b.email || '').trim().toLowerCase();
  const nick = String(b.nick || '').trim();
  const password = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) throw bad('email');
  if (nick.length < 2 || nick.length > 16) throw bad('nick');
  if (password.length < 8 || password.length > 200) throw bad('password');
  const ip = 'register:' + ipOf(req);
  await shut(env, [ip]);
  await strike(env, ip, 'register');
  const iter = Number(env.PBKDF2_ITER) || DEFAULT_ITER;
  const salt = randomToken(16);
  const hash = await hashPassword(password, salt, iter);
  try {
    const r = await env.DB.prepare(
      'INSERT INTO users (email, nick, salt, hash, iter, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(email, nick, salt, hash, iter, Date.now()).run();
    const id = r.meta.last_row_id;
    return { token: await session(env, id), nick };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) {
      throw new HttpError(409, /nick/.test(String(e.message)) ? 'nick taken' : 'email taken');
    }
    throw e;
  }
}

async function login(req, env) {
  const b = await body(req);
  const email = String(b.email || '').trim().toLowerCase();
  const byMail = 'login:' + email, byIp = 'login-ip:' + ipOf(req);
  await shut(env, [byMail, byIp]);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  // the same work and the same answer whether or not the address exists
  const hash = await hashPassword(String(b.password || ''), u ? u.salt : 'AAAAAAAAAAAAAAAAAAAAAA', u ? u.iter : DEFAULT_ITER);
  if (!u || !sameString(hash, u.hash)) {
    await strike(env, byMail, 'login');
    await strike(env, byIp, 'loginIp');
    throw new HttpError(401, 'wrong email or password');
  }
  await forgive(env, byMail);
  return { token: await session(env, u.id), nick: u.nick };
}

/* ------------------------------------------------------- password reset
   A link by mail, good for half an hour and for one use. The request
   answers the same whether or not the address has an account, and the
   mail goes out after the answer, so neither the words nor the timing
   says which. Only a hash of the link's token is kept. */

function mailer(env) {
  if (env.BREVO_KEY && env.MAIL_FROM) return 'brevo';
  if (env.RESEND_KEY) return 'resend';
  return null;
}
async function sendMail(env, to, subject, text) {
  const html = '<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#17150F">' +
    text.split('\n').map((l) => /^https:\/\//.test(l)
      ? '<p><a href="' + l + '" style="color:#1D6B4C">' + l + '</a></p>'
      : '<p>' + l.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>').join('') + '</div>';
  let r;
  if (mailer(env) === 'brevo') {
    r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ sender: { name: 'Grandstand', email: env.MAIL_FROM }, to: [{ email: to }],
        subject, textContent: text, htmlContent: html })
    });
  } else {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Grandstand <' + (env.MAIL_FROM || 'onboarding@resend.dev') + '>', to: [to],
        subject, text, html })
    });
  }
  if (!r.ok) throw new Error('mail ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function resetRequest(req, env, ctx) {
  if (!mailer(env)) throw new HttpError(503, 'mail off');
  const b = await body(req);
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email');
  const byMail = 'reset:' + email, byIp = 'reset-ip:' + ipOf(req);
  await shut(env, [byMail, byIp]);
  await strike(env, byMail, 'reset');
  await strike(env, byIp, 'resetIp');
  const u = await env.DB.prepare('SELECT id, nick FROM users WHERE email = ?1').bind(email).first();
  if (u) {
    const token = randomToken(24);
    await env.DB.prepare('DELETE FROM resets WHERE user_id = ?1').bind(u.id).run();
    await env.DB.prepare('INSERT INTO resets (token, user_id, expires) VALUES (?1, ?2, ?3)')
      .bind(await sha256(token), u.id, Date.now() + RESET_TTL).run();
    const o = req.headers.get('Origin') || '';
    const link = (ORIGINS.includes(o) ? o : ORIGINS[0]) + '/?reset=' + token;
    const en = b.lang === 'en';
    const text = en
      ? `Hi ${u.nick},\nOpen this link to set a new password for Grandstand. It works once, for the next 30 minutes:\n${link}\nIf you didn't ask for this, ignore this mail — your password stays as it is.`
      : `${u.nick}，你好：\n点下面的链接给 Grandstand 设一个新密码，30 分钟内有效，只能用一次：\n${link}\n如果不是你本人操作，忽略这封邮件就行，密码不会变。`;
    const send = sendMail(env, email, en ? 'Reset your Grandstand password' : 'Grandstand 重设密码', text)
      .catch((e) => env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('mailError', ?1)")
        .bind(JSON.stringify({ at: Date.now(), error: String(e.message).replace(/\S+@\S+/g, '…').slice(0, 300) })).run());   // health is public: no addresses in it
    if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
  }
  return { ok: true };
}

async function resetConfirm(req, env) {
  const b = await body(req);
  const password = String(b.password || '');
  if (password.length < 8 || password.length > 200) throw bad('password');
  const byIp = 'reset-use:' + ipOf(req);
  await shut(env, [byIp]);
  const key = await sha256(String(b.token || ''));
  const row = await env.DB.prepare('SELECT * FROM resets WHERE token = ?1').bind(key).first();
  if (!row || row.expires < Date.now()) {
    await strike(env, byIp, 'resetUse');
    throw new HttpError(400, 'reset expired');
  }
  const u = await env.DB.prepare('SELECT id, nick, email FROM users WHERE id = ?1').bind(row.user_id).first();
  if (!u) throw new HttpError(400, 'reset expired');
  const iter = Number(env.PBKDF2_ITER) || DEFAULT_ITER;
  const salt = randomToken(16);
  const hash = await hashPassword(password, salt, iter);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET salt = ?2, hash = ?3, iter = ?4 WHERE id = ?1').bind(u.id, salt, hash, iter),
    env.DB.prepare('DELETE FROM resets WHERE user_id = ?1').bind(u.id),
    // every phone logged in with the old password is logged out
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM attempts WHERE k = ?1').bind('login:' + u.email)
  ]);
  return { token: await session(env, u.id), nick: u.nick };
}

/* ---------------------------------------------------------------- ESPN */

async function espn(path) {
  const r = await fetch(ESPN + path, { headers: { 'User-Agent': 'Mozilla/5.0 (grandstand-live)' }, cf: { cacheTtl: 20 } });
  if (!r.ok) throw new Error('espn ' + r.status);
  return r.json();
}
function ymdUTC(t) {
  const d = new Date(t);
  return '' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}
function sides(ev) {
  const c = (ev.competitions || [])[0] || {};
  const cs = c.competitors || [];
  return {
    comp: c,
    home: cs.find((x) => x.homeAway === 'home') || cs[0] || {},
    away: cs.find((x) => x.homeAway === 'away') || cs[1] || {},
    state: ((c.status || ev.status || {}).type || {}).state || 'pre'
  };
}
function scoreOf(x) { return String((x && x.score && (x.score.displayValue || x.score.value)) ?? (x && x.score) ?? ''); }

/* --------------------------------------------------------------- picks */

async function putPick(req, env) {
  const u = await mustBe(req, env);
  const b = await body(req);
  const sport = String(b.sport || ''), event = String(b.id || '');
  const starts = Number(b.when) || Date.parse(b.when) || 0;
  if (!sport || !event || !b.side) throw bad('pick');
  // a call counts only if it reached us before the start
  if (!starts || Date.now() > starts - 30000) throw new HttpError(409, 'already started');
  const pkey = sport + ':' + event;
  const cur = await env.DB.prepare('SELECT result FROM picks WHERE user_id = ?1 AND pkey = ?2').bind(u.id, pkey).first();
  if (cur && cur.result) throw new HttpError(409, 'settled');
  // `ref` is what the server checks against where `side` alone can't be:
  // an F1 podium's drivers by their ESPN names, since `side` holds the app's own
  await env.DB.prepare(`INSERT INTO picks (user_id, pkey, sport, event, league, side, starts, made, home, away, ref)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT (user_id, pkey) DO UPDATE SET side = excluded.side, made = excluded.made, ref = excluded.ref`)
    .bind(u.id, pkey, sport, event, String(b.league || ''), String(b.side).slice(0, 200), starts, Date.now(),
      String(b.home || '').slice(0, 60), String(b.away || '').slice(0, 60), b.ref ? String(b.ref).slice(0, 200) : null).run();
  return { ok: true };
}

// Settlement the app reports. Football, NBA, F1 and esports are checked
// against the source by the cron afterwards and corrected if they
// disagree; other sports stand as reported.
async function settlePick(req, env) {
  const u = await mustBe(req, env);
  const b = await body(req);
  const pkey = String(b.sport || '') + ':' + String(b.id || '');
  const row = await env.DB.prepare('SELECT * FROM picks WHERE user_id = ?1 AND pkey = ?2').bind(u.id, pkey).first();
  if (!row) return { ok: false };
  if (row.result) return { ok: true };
  if (Date.now() < row.starts) throw new HttpError(409, 'not started');
  await env.DB.prepare('UPDATE picks SET result = ?3, score = ?4, hit = ?5, settled = ?6 WHERE user_id = ?1 AND pkey = ?2')
    .bind(u.id, pkey, String(b.outcome || '').slice(0, 200), String(b.score || '').slice(0, 30), b.hit ? 1 : 0, Date.now()).run();
  return { ok: true };
}

async function leaderboard(req, env) {
  const url = new URL(req.url);
  const since = url.searchParams.get('period') === 'month' ? Date.now() - 30 * DAY : 0;
  const rows = await env.DB.prepare(`
      SELECT u.nick AS nick, SUM(p.hit) AS hits, COUNT(*) AS total
      FROM picks p JOIN users u ON u.id = p.user_id
      WHERE p.result IS NOT NULL AND p.starts >= ?1
      GROUP BY p.user_id HAVING total >= 3
      ORDER BY hits DESC, (1.0 * hits / total) DESC, total ASC LIMIT 50`).bind(since).all();
  const me = await whoIs(req, env);
  let mine = null;
  if (me) {
    mine = await env.DB.prepare(`SELECT SUM(hit) AS hits, COUNT(*) AS total FROM picks
        WHERE user_id = ?1 AND result IS NOT NULL AND starts >= ?2`).bind(me.id, since).first();
    mine.nick = me.nick;
  }
  return { rows: rows.results || [], me: mine };
}

/* -------------------------------------------------------------- ratings */

async function getRatings(req, env) {
  const event = new URL(req.url).searchParams.get('event') || '';
  if (!event) throw bad('event');
  const agg = await env.DB.prepare(`SELECT player, name, team, AVG(score) AS avg, COUNT(*) AS n
      FROM ratings WHERE event = ?1 GROUP BY player`).bind(event).all();
  const me = await whoIs(req, env);
  let mine = {};
  if (me) {
    const r = await env.DB.prepare('SELECT player, score FROM ratings WHERE event = ?1 AND user_id = ?2').bind(event, me.id).all();
    (r.results || []).forEach((x) => { mine[x.player] = x.score; });
  }
  return { players: agg.results || [], mine };
}

async function putRating(req, env) {
  const u = await mustBe(req, env);
  const b = await body(req);
  const score = Math.round(Number(b.score));
  if (!(score >= 1 && score <= 10)) throw bad('score');
  const event = String(b.event || ''), player = String(b.player || '');
  if (!event || !player) throw bad('rating');
  // only once the match is over, and for three days after, when ESPN can say.
  // A basketball game comes as "nba:<id>", so it never shares a football id.
  const nba = /^nba:(\d+)$/.exec(event);
  if (b.league || nba) {
    try {
      const s = await espn(nba ? 'basketball/nba/summary?event=' + nba[1]
        : 'soccer/' + encodeURIComponent(b.league) + '/summary?event=' + encodeURIComponent(event));
      const comp = (((s.header || {}).competitions) || [])[0] || {};
      const st = ((comp.status || {}).type || {}).state;
      if (st && st !== 'post') throw new HttpError(409, 'not finished');
      if (comp.date && Date.now() - Date.parse(comp.date) > 3 * DAY + 3 * 3600000) throw new HttpError(409, 'closed');
    } catch (e) { if (e instanceof HttpError) throw e; }
  }
  await env.DB.prepare(`INSERT INTO ratings (user_id, event, player, name, team, score, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT (user_id, event, player) DO UPDATE SET score = excluded.score, at = excluded.at`)
    .bind(u.id, event, player, String(b.name || '').slice(0, 60), String(b.team || '').slice(0, 60), score, Date.now()).run();
  return { ok: true };
}

/* ----------------------------------------------------------------- push
   Web Push without a library: a VAPID JWT signed with ES256, and the
   payload encrypted as RFC 8291 aes128gcm. The key pair is made the first
   time it is needed and kept in the config table. */

async function vapidKeys(env) {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first();
  if (row) {
    const k = JSON.parse(row.v);
    return { pub: k.pub, priv: await crypto.subtle.importKey('jwk', k.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
  await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('vapid', ?1)").bind(JSON.stringify({ jwk, pub })).run();
  return vapidKeys(env);   // read back, so two first requests agree on one pair
}

async function vapidAuth(env, endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:push@grandstand-live.github.io'
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.priv, enc.encode(head + '.' + claims));
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + keys.pub;
}

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

async function encryptPayload(p256dh, authSecret, text) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, secret, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key,
    concat(enc.encode(text), new Uint8Array([2]))));   // 0x02: the last (and only) record
  const rs = new Uint8Array([0, 0, 16, 0]);            // record size 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function sendPush(env, keys, sub, message) {
  const payload = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(message));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidAuth(env, sub.endpoint, keys),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      'TTL': '3600', 'Urgency': 'high'
    },
    body: payload
  });
  if (r.status === 404 || r.status === 410) {
    // the phone has let this subscription go
    await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?1').bind(sub.endpoint).run();
  } else if (!r.ok) {
    await env.DB.prepare('UPDATE subs SET fails = fails + 1 WHERE endpoint = ?1').bind(sub.endpoint).run();
  }
  return r.status;
}

async function subscribe(req, env) {
  const b = await body(req);
  const s = b.sub || {};
  const keys = s.keys || {};
  if (!/^https:\/\//.test(s.endpoint || '') || !keys.p256dh || !keys.auth) throw bad('subscription');
  const u = await whoIs(req, env);
  const follows = JSON.stringify(b.follows || {}).slice(0, 4000);
  await env.DB.prepare(`INSERT INTO subs (endpoint, p256dh, auth, user_id, follows, lang, created)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
        user_id = excluded.user_id, follows = excluded.follows, lang = excluded.lang, fails = 0`)
    .bind(s.endpoint, keys.p256dh, keys.auth, u ? u.id : null, follows, String(b.lang || 'zh'), Date.now()).run();
  return { ok: true };
}

async function testPush(req, env) {
  const b = await body(req);
  const sub = await env.DB.prepare('SELECT * FROM subs WHERE endpoint = ?1').bind(String(b.endpoint || '')).first();
  if (!sub) throw new HttpError(404, 'not subscribed');
  const en = sub.lang === 'en';
  const status = await sendPush(env, await vapidKeys(env), sub, {
    title: 'Grandstand', body: en ? 'Notifications are on.' : '推送已开启，比赛有动静会第一时间告诉你。', tag: 'test'
  });
  return { status };
}

/* ------------------------------------------------------ what happened now
   Once a minute: the scoreboards of whatever anyone follows, compared with
   what was seen last time. A change that matters becomes one push to each
   follower, in their language. */

const T = {
  soon: { zh: (a, b) => `${a} vs ${b} 还有 15 分钟开赛`, en: (a, b) => `${a} v ${b} starts in 15 minutes` },
  kick: { zh: (a, b) => `开赛：${a} vs ${b}`, en: (a, b) => `Kick-off: ${a} v ${b}` },
  tip: { zh: (a, b) => `比赛开始：${a} vs ${b}`, en: (a, b) => `Tip-off: ${a} v ${b}` },
  goal: { zh: (s) => `进球！${s}`, en: (s) => `Goal! ${s}` },
  final: { zh: (s) => `完场：${s}`, en: (s) => `Full time: ${s}` },
  finalNba: { zh: (s) => `终场：${s}`, en: (s) => `Final: ${s}` },
  f1soon: { zh: (gp, s) => `${gp} ${s} 15 分钟后开始`, en: (gp, s) => `${gp} ${s} starts in 15 minutes` },
  f1done: { zh: (gp, s) => `${gp} ${s} 结果`, en: (gp, s) => `${gp} ${s} result` },
  ufcOn: { zh: (a, b) => `开打：${a} vs ${b}`, en: (a, b) => `Fight on: ${a} v ${b}` },
  ufcWin: { zh: (w, l) => `${w} 胜 ${l}`, en: (w, l) => `${w} beats ${l}` },
  ufcEnd: { zh: (a, b) => `${a} vs ${b} 结束`, en: (a, b) => `${a} v ${b} is over` },
  esOn: { zh: (a, b) => `比赛开始：${a} vs ${b}`, en: (a, b) => `Match on: ${a} v ${b}` },
  esEnd: { zh: (s) => `比赛结束：${s}`, en: (s) => `Final: ${s}` },
  snChamp: { zh: (w, e) => `${w} 夺得${e}冠军`, en: (w, e) => `${w} wins the ${e}` },
  srcFail: { zh: (n) => `数据源出错：${n}`, en: (n) => `Data source failing: ${n}` }
};
// how a bout ended, from ESPN's "Unofficial Winner …" detail
function ufcMethod(comp, lang) {
  const d = (comp.details || []).find((x) => /Unofficial Winner/i.test((x.type && x.type.text) || ''));
  const t = (d && d.type && d.type.text) || '';
  const en = lang === 'en';
  if (/kotko|\bko\b/i.test(t)) return 'KO/TKO';
  if (/submission/i.test(t)) return en ? 'Submission' : '降服';
  if (/decision/i.test(t)) return en ? 'Decision' : '判定';
  return '';
}
function say(key, lang, ...args) { return T[key][lang === 'en' ? 'en' : 'zh'](...args); }

// ESPN's title carries the sponsor ("Qatar Airways Azerbaijan Grand Prix");
// the race is the word or two before "Grand Prix"
const GP_TWO = ['Las Vegas', 'Abu Dhabi', 'Mexico City', 'São Paulo', 'Sao Paulo', 'Emilia Romagna', 'United States', 'Saudi Arabian'];
function gpShort(name) {
  const s = String(name || '');
  const two = GP_TWO.find((p) => s.endsWith(p + ' Grand Prix'));
  if (two) return two + ' Grand Prix';
  const m = /(\S+) Grand Prix$/.exec(s);
  return m ? m[1] + ' Grand Prix' : s;
}

// a followed team's own name, as its follower saved it; the rest in English
function teamName(team, followed, lang) {
  if (lang === 'zh' && followed && followed.name) return followed.name;
  return (team && (team.shortDisplayName || team.displayName)) || '';
}

/* Every run leaves a note of when it ran, how long it took and what it
   did, which /api/health reads back: a cron that has stopped shows as a
   stale time there rather than as silence. */
async function tick(env) {
  const t0 = Date.now();
  const note = { at: t0 };
  try {
    await ensureSchema(env);
    note.pushes = await watch(env);
    note.settled = await verifyPicks(env);
    if (new Date(t0).getUTCMinutes() === 0) await sweep(env);
    if (new Date(t0).getUTCMinutes() % 10 === 0) note.alerts = await checkSources(env);
  } catch (e) {
    note.error = String((e && e.message) || e).slice(0, 300);
  }
  note.ms = Date.now() - t0;
  try {
    await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('tick', ?1)").bind(JSON.stringify(note)).run();
  } catch (e) {}
}

/* Every ten minutes: the collector's own report of its last run. A source
   that failed three runs running — Wikipedia changed a table, a page moved —
   is told once a day to whoever asked for these alerts; a collector that has
   not run for three quarters of an hour is told at once. One read of the
   same run counts once, however many times it is read. */
async function readStatus() {
  try {
    const r = await fetch(ORIGINS[0] + '/data/status.json', { cf: { cacheTtl: 60 } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function checkSources(env) {
  const st = await readStatus();
  const now = Date.now();
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'srcwatch'").first();
  let w = {};
  try { w = JSON.parse((row && row.v) || '{}'); } catch (e) {}
  w.fails = w.fails || {};
  w.told = w.told || {};
  const failing = {};
  if (st) {
    Object.keys(st.sources || {}).forEach((k) => {
      const x = st.sources[k];
      if (x && x.ok === false) failing[k] = String(x.error || 'failed').slice(0, 140);
    });
  }
  const alerts = [];
  const run = st ? st.ranAt : 'unreachable';
  if (run !== w.lastRun) {
    w.lastRun = run;
    if (!st) failing.status = 'status.json unreachable';
    Object.keys(w.fails).forEach((k) => { if (!failing[k]) { delete w.fails[k]; delete w.told[k]; } });
    Object.keys(failing).forEach((k) => {
      w.fails[k] = (w.fails[k] || 0) + 1;
      if (w.fails[k] >= 3 && (!w.told[k] || now - w.told[k] > DAY)) { w.told[k] = now; alerts.push([k, failing[k]]); }
    });
  }
  const age = st ? now - Date.parse(st.ranAt) : 0;
  if (st && age > 45 * MIN) {
    if (!w.told.collector || now - w.told.collector > DAY) {
      w.told.collector = now;
      alerts.push(['collector', 'last run ' + Math.round(age / MIN) + ' min ago']);
    }
  } else if (st) delete w.told.collector;
  await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('srcwatch', ?1)").bind(JSON.stringify(w)).run();
  if (!alerts.length) return 0;
  const subs = ((await env.DB.prepare('SELECT * FROM subs WHERE fails < 20').all()).results || []).filter((s) => {
    try { return !!JSON.parse(s.follows || '{}').alerts; } catch (e) { return false; }
  });
  if (!subs.length) return 0;
  const keys = await vapidKeys(env);
  let sent = 0;
  for (const s of subs) {
    const msg = {
      title: say('srcFail', s.lang, alerts.map((a) => a[0]).join(', ')),
      body: alerts.map((a) => a[0] + ': ' + a[1]).join('\n').slice(0, 240), tag: 'srcfail', url: '/'
    };
    sent += await sendPush(env, keys, s, msg).then(() => 1, () => 0);
  }
  return sent;
}

// once an hour: logins gone unused, spent reset links, old attempt counts
async function sweep(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE COALESCE(seen, created) < ?1').bind(now - SESSION_IDLE),
    env.DB.prepare('DELETE FROM resets WHERE expires < ?1').bind(now),
    env.DB.prepare('DELETE FROM attempts WHERE since < ?1 AND (until IS NULL OR until < ?2)').bind(now - DAY, now)
  ]);
}

async function watch(env) {
  const subs = (await env.DB.prepare('SELECT * FROM subs WHERE fails < 20').all()).results || [];
  const out = [];   // [sub, message]
  const leagues = {}, nba = {}, ufc = {};
  let f1 = false;
  subs.forEach((s) => {
    let f = {};
    try { f = JSON.parse(s.follows || '{}'); } catch (e) {}
    s.f = f;
    (f.football || []).forEach((t) => { (leagues[t.league] = leagues[t.league] || new Set()).add(String(t.id)); });
    (f.nba || []).forEach((t) => { nba[String(t.id)] = 1; });
    (f.ufc || []).forEach((t) => { ufc[String(t.id)] = 1; });
    if (f.f1) f1 = true;
  });

  const now = Date.now();
  const days = [ymdUTC(now), ymdUTC(now - DAY)];

  async function seen(event) {
    return await env.DB.prepare('SELECT * FROM watch WHERE event = ?1').bind(event).first();
  }
  async function note(event, state, score, notified) {
    await env.DB.prepare(`INSERT INTO watch (event, state, score, notified, at) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (event) DO UPDATE SET state = excluded.state, score = excluded.score, notified = excluded.notified, at = excluded.at`)
      .bind(event, state, score, notified, now).run();
  }

  // ---- football and the NBA share one shape
  async function board(path, isFollowed, whoFollows, kind) {
    let evs = [];
    for (const d of days) {
      try { evs = evs.concat((await espn(path + '/scoreboard?dates=' + d)).events || []); } catch (e) {}
    }
    const done = new Set();
    for (const ev of evs) {
      if (done.has(ev.id)) continue;
      done.add(ev.id);
      const s = sides(ev);
      const hid = String(s.home.team && s.home.team.id), aid = String(s.away.team && s.away.team.id);
      if (!isFollowed(hid) && !isFollowed(aid)) continue;
      const score = scoreOf(s.home) + '-' + scoreOf(s.away);
      const prev = await seen(ev.id);
      const flags = new Set(((prev && prev.notified) || '').split(',').filter(Boolean));
      const events = [];
      const start = Date.parse(ev.date);
      if (s.state === 'pre' && start - now < 16 * 60000 && start - now > 0 && !flags.has('soon')) events.push('soon');
      if (s.state === 'in' && !flags.has('kick')) events.push('kick');
      if (kind === 'football' && s.state === 'in' && prev && prev.score && prev.score !== score && flags.has('kick')) events.push('goal');
      if (s.state === 'post' && !flags.has('final') && prev) events.push('final');
      for (const e of events) {
        flags.add(e);
        for (const sub of whoFollows(hid, aid)) {
          const fh = sub.pick(hid), fa = sub.pick(aid);
          const A = teamName(s.home.team, fh, sub.lang), B = teamName(s.away.team, fa, sub.lang);
          const line = `${A} ${scoreOf(s.home)}-${scoreOf(s.away)} ${B}`;
          let msg;
          if (e === 'soon') msg = { title: say('soon', sub.lang, A, B) };
          else if (e === 'kick') msg = { title: say(kind === 'nba' ? 'tip' : 'kick', sub.lang, A, B) };
          else if (e === 'goal') {
            const g = ((s.comp.details || []).filter((x) => x.scoringPlay).pop()) || {};
            const who = ((g.athletesInvolved || [])[0] || {}).displayName || '';
            msg = { title: say('goal', sub.lang, line), body: [who, (g.clock || {}).displayValue].filter(Boolean).join(' ') };
          } else msg = { title: say(kind === 'nba' ? 'finalNba' : 'final', sub.lang, line) };
          msg.tag = 'ev' + ev.id;
          msg.url = kind === 'nba' ? '/?go=basketball' : '/?go=football';
          out.push([sub.s, msg]);
        }
      }
      if (!prev || events.length || prev.state !== s.state || prev.score !== score) {
        await note(ev.id, s.state, score, [...flags].join(','));
      }
    }
  }

  function followersOf(test) {
    return (hid, aid) => subs.filter((s) => test(s, hid) || test(s, aid)).map((s) => ({
      s, lang: s.lang,
      pick: (id) => (s.f.football || []).concat(s.f.nba || []).find((t) => String(t.id) === id)
    }));
  }

  for (const lg of Object.keys(leagues).slice(0, 10)) {
    const ids = leagues[lg];
    await board('soccer/' + lg, (id) => ids.has(id),
      followersOf((s, id) => (s.f.football || []).some((t) => t.league === lg && String(t.id) === id)), 'football');
  }
  if (Object.keys(nba).length) {
    await board('basketball/nba', (id) => !!nba[id], followersOf((s, id) => (s.f.nba || []).some((t) => String(t.id) === id)), 'nba');
  }

  // ---- F1: fifteen minutes before qualifying and the race, then the result
  if (f1) {
    try {
      const sb = await espn('racing/f1/scoreboard');
      for (const ev of sb.events || []) {
        for (const c of ev.competitions || []) {
          const t = (c.type && (c.type.abbreviation || c.type.text)) || '';
          if (!/^(Qual|Race|Sprint|SR)$/.test(t)) continue;
          const key = 'f1:' + c.id;
          const st = ((c.status || {}).type || {}).state || 'pre';
          const start = Date.parse(c.date);
          const prev = await seen(key);
          const flags = new Set(((prev && prev.notified) || '').split(',').filter(Boolean));
          const fire = [];
          if (st === 'pre' && start - now < 16 * 60000 && start - now > 0 && !flags.has('soon')) fire.push('soon');
          if (st === 'post' && prev && !flags.has('final')) fire.push('final');
          const gp = gpShort(ev.name);
          const session = { Qual: ['排位赛', 'Qualifying'], Race: ['正赛', 'Race'], Sprint: ['冲刺赛', 'Sprint'], SR: ['冲刺赛', 'Sprint'] }[t];
          for (const e of fire) {
            flags.add(e);
            const top = (c.competitors || []).slice().sort((a, b) => (a.order || 99) - (b.order || 99)).slice(0, 3)
              .map((x, i) => (i + 1) + '. ' + ((x.athlete || {}).shortName || (x.athlete || {}).displayName || '')).join('  ');
            subs.filter((s) => s.f.f1).forEach((s) => {
              const sName = session[s.lang === 'en' ? 1 : 0];
              out.push([s, e === 'soon'
                ? { title: say('f1soon', s.lang, gp, sName), tag: key, url: '/?go=f1' }
                : { title: say('f1done', s.lang, gp, sName), body: top, tag: key, url: '/?go=f1' }]);
            });
          }
          if (!prev || fire.length || prev.state !== st) await note(key, st, '', [...flags].join(','));
        }
      }
    } catch (e) {}
  }

  // ---- UFC: a followed fighter's bout, when it starts and when it is decided
  if (Object.keys(ufc).length) {
    let evs = [];
    for (const d of days) {
      try { evs = evs.concat((await espn('mma/ufc/scoreboard?dates=' + d)).events || []); } catch (e) {}
    }
    const done = new Set();
    for (const ev of evs) {
      for (const c of ev.competitions || []) {
        if (done.has(c.id)) continue;
        done.add(c.id);
        const cs = c.competitors || [];
        const ids = cs.map((x) => String(x.id || (x.athlete || {}).id || ''));
        if (!ids.some((id) => ufc[id])) continue;
        const key = 'ufc:' + c.id;
        const st = ((c.status || {}).type || {}).state || 'pre';
        const prev = await seen(key);
        const flags = new Set(((prev && prev.notified) || '').split(',').filter(Boolean));
        const fire = [];
        if (st === 'in' && !flags.has('kick')) fire.push('kick');
        if (st === 'post' && prev && !flags.has('final')) fire.push('final');
        const nm = (x) => ((x && x.athlete) || {}).displayName || '';
        const a = cs[0], b = cs[1];
        const w = cs.find((x) => x.winner), l = w && cs.find((x) => x !== w);
        for (const e of fire) {
          flags.add(e);
          subs.filter((s) => (s.f.ufc || []).some((t) => ids.includes(String(t.id)))).forEach((s) => {
            let msg;
            if (e === 'kick') msg = { title: say('ufcOn', s.lang, nm(a), nm(b)), body: ev.shortName || ev.name || '' };
            else {
              // a decision goes the distance: the round, not the clock
              const dec = ufcMethod(c, 'en') === 'Decision';
              const how = [ufcMethod(c, s.lang), c.status && c.status.period ? 'R' + c.status.period : '',
                c.status && c.status.displayClock && !dec ? c.status.displayClock : ''].filter(Boolean).join(' ');
              msg = w ? { title: say('ufcWin', s.lang, nm(w), nm(l)), body: how }
                : { title: say('ufcEnd', s.lang, nm(a), nm(b)), body: how };
            }
            msg.tag = key;
            msg.url = '/?go=fight';
            out.push([s, msg]);
          });
        }
        if (!prev || fire.length || prev.state !== st) await note(key, st, '', [...flags].join(','));
      }
    }
  }

  // ---- boxing: a followed boxer's result, once the site's own file has it.
  // The file comes from Wikipedia, a few hours after the fight; nothing there
  // says when the first bell goes, so there is no "under way" push.
  const boxFollow = subs.filter((s) => (s.f.box || []).length);
  if (boxFollow.length) {
    let card = null;
    try {
      const r = await fetch(ORIGINS[0] + '/data/boxing.json', { cf: { cacheTtl: 300 } });
      if (r.ok) card = await r.json();
    } catch (e) {}
    const norm = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const METHOD_EN = { '一致判定': 'Unanimous decision', '分歧判定': 'Split decision', '多数判定': 'Majority decision',
      '技术判定': 'Technical decision', '完场': 'Result', '平局': 'Draw' };
    for (const b of (card && card.recent) || []) {
      if (b.winner !== 'a' && b.winner !== 'b') continue;
      const an = norm((b.a || {}).name), bn = norm((b.b || {}).name);
      const who = boxFollow.filter((s) => s.f.box.some((f) => [an, bn].includes(norm(f.name))));
      if (!who.length) continue;
      const key = 'box:' + an + '~' + bn + '~' + String(b.start || '').slice(0, 10);
      const prev = await seen(key);
      if (prev) continue;
      // only a fight from the last few days; an old one first seen now is just noted
      const fresh = Date.now() - Date.parse(b.start || 0) < 4 * DAY;
      if (fresh) {
        const w = b.winner === 'a' ? b.a : b.b, l = b.winner === 'a' ? b.b : b.a;
        who.forEach((s) => {
          const en = s.lang === 'en';
          const how = [en ? (METHOD_EN[b.method] || b.method) : b.method, b.round ? 'R' + b.round : ''].filter(Boolean).join(' ');
          out.push([s, { title: say('ufcWin', s.lang, w.name, l.name), body: [how, b.event].filter(Boolean).join(' · '), tag: key, url: '/?go=fight' }]);
        });
      }
      await note(key, 'post', '', fresh ? 'final' : 'old');
    }
  }

  /* ---- tennis: a followed player's match, when it starts and when it is decided.
     Both tours' boards come from ESPN; a player is known by ESPN's id. */
  const tnFollow = subs.filter((s) => (s.f.tennis || []).length);
  for (const tour of ['atp', 'wta']) {
    const who = tnFollow.filter((s) => s.f.tennis.some((t) => t.tour === tour));
    if (!who.length) continue;
    let evs = [];
    try { evs = (await espn('tennis/' + tour + '/scoreboard')).events || []; } catch (e) {}
    for (const ev of evs) {
      for (const g of ev.groupings || []) {
        if (!/singles/i.test(((g.grouping || {}).displayName) || '')) continue;
        for (const c of g.competitions || []) {
          const cs = c.competitors || [];
          const ids = cs.map((x) => String(x.id));
          const fans = who.filter((s) => s.f.tennis.some((t) => ids.includes(String(t.id))));
          if (!fans.length) continue;
          const key = 'tn:' + c.id;
          const st = ((c.status || {}).type || {}).state || 'pre';
          const prev = await seen(key);
          const flags = new Set(((prev && prev.notified) || '').split(',').filter(Boolean));
          const fire = [];
          if (st === 'in' && !flags.has('kick')) fire.push('kick');
          if (st === 'post' && prev && !flags.has('final')) fire.push('final');
          const nm = (x) => ((x && x.athlete) || {}).displayName || 'TBD';
          const a = cs[0], b = cs[1];
          const w = cs.find((x) => x.winner), l = w && cs.find((x) => x !== w);
          const where = [ev.name, (c.round || {}).displayName].filter(Boolean).join(' · ');
          const sets = w ? (w.linescores || []).map((ls, i) => ls.value + '-' + (((l.linescores || [])[i] || {}).value ?? 0)).join(' ') : '';
          for (const e of fire) {
            flags.add(e);
            fans.forEach((s) => {
              out.push([s, e === 'kick'
                ? { title: say('esOn', s.lang, nm(a), nm(b)), body: where, tag: key, url: '/?go=tennis' }
                : w ? { title: say('ufcWin', s.lang, nm(w), nm(l)), body: [sets, where].filter(Boolean).join(' · '), tag: key, url: '/?go=tennis' }
                  : { title: say('ufcEnd', s.lang, nm(a), nm(b)), body: where, tag: key, url: '/?go=tennis' }]);
            });
          }
          if (!prev || fire.length || prev.state !== st) await note(key, st, '', [...flags].join(','));
        }
      }
    }
  }

  /* ---- snooker: a followed player's results, and each tournament's champion,
     from the site's own file (Wikipedia, read every half hour). Only a result
     from the last few days is told; an older one first seen now is noted. */
  const snFollow = subs.filter((s) => (s.f.snooker || []).length);
  if (snFollow.length) {
    let d = null;
    try {
      const r = await fetch(ORIGINS[0] + '/data/snooker.json', { cf: { cacheTtl: 300 } });
      if (r.ok) d = await r.json();
    } catch (e) {}
    const norm = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const since = new Date(now - 3 * DAY).toISOString().slice(0, 10);
    for (const t of (d && d.calendar) || []) {
      const fresh = (t.end || t.start || '') >= since;
      for (const r of ((d.draws || {})[t.page]) || []) {
        for (const m of r.matches || []) {
          if (m.w !== 'a' && m.w !== 'b') continue;
          const names = [norm(m.a), norm(m.b)];
          const fans = snFollow.filter((s) => s.f.snooker.some((f) => names.includes(norm(f.name))));
          if (!fans.length) continue;
          const key = 'sn:' + t.page + ':' + r.name + ':' + names.join('|');
          if (await seen(key)) continue;
          if (fresh) {
            const W = m.w === 'a' ? m.a : m.b, L = m.w === 'a' ? m.b : m.a;
            const ws = m.w === 'a' ? m.s1 : m.s2, ls = m.w === 'a' ? m.s2 : m.s1;
            const score = typeof ws === 'number' && typeof ls === 'number' ? ws + '-' + ls : 'w/o';
            fans.forEach((s) => out.push([s, { title: say('ufcWin', s.lang, W, L), body: `${score} · ${t.name} · ${r.name}`, tag: key, url: '/?go=snooker' }]));
          }
          await note(key, 'post', '', fresh ? 'final' : 'old');
        }
      }
      if (t.winner) {
        const key = 'snc:' + t.page;
        if (!(await seen(key))) {
          if (fresh) snFollow.forEach((s) => out.push([s, { title: say('snChamp', s.lang, t.winner, t.name), body: [t.score, t.runner].filter(Boolean).join(' vs '), tag: key, url: '/?go=snooker' }]));
          await note(key, 'post', '', fresh ? 'final' : 'old');
        }
      }
    }
  }

  /* ---- esports: a followed team's series, when it starts and when it ends.
     League of Legends from Riot's own schedule, which lists every league's
     matches either side of now in one answer; CS2 and Valorant from the
     site's own files, which the collector refreshes every five minutes. */
  async function series(key, st, a, b, sa, sb, where, who, url) {
    const prev = await seen(key);
    const flags = new Set(((prev && prev.notified) || '').split(',').filter(Boolean));
    const fire = [];
    if (st === 'in' && !flags.has('kick')) fire.push('kick');
    // a series first seen already over is only noted: it was over before anyone could be told
    if (st === 'post' && prev && !flags.has('final')) fire.push('final');
    for (const e of fire) {
      flags.add(e);
      who.forEach((s) => {
        out.push([s, e === 'kick'
          ? { title: say('esOn', s.lang, a, b), body: where, tag: key, url }
          : { title: say('esEnd', s.lang, `${a} ${sa}-${sb} ${b}`), body: where, tag: key, url }]);
      });
    }
    if (!prev || fire.length || prev.state !== st) await note(key, st, `${sa}-${sb}`, [...flags].join(','));
  }
  const lolFollow = subs.filter((s) => (s.f.lol || []).length);
  if (lolFollow.length) {
    let evs = [];
    try {
      const r = await fetch(LOL + 'getSchedule?hl=en-US', { headers: { 'x-api-key': LOL_KEY } });
      if (r.ok) evs = (((await r.json()).data || {}).schedule || {}).events || [];
    } catch (e) {}
    for (const ev of evs) {
      const m = ev.match, ts = (m && m.teams) || [];
      if (ev.type !== 'match' || ts.length !== 2) continue;
      const codes = ts.map((t) => String(t.code || '').toUpperCase());
      const who = lolFollow.filter((s) => s.f.lol.some((t) => codes.includes(String(t.code || '').toUpperCase())));
      if (!who.length) continue;
      const st = ev.state === 'inProgress' ? 'in' : ev.state === 'completed' ? 'post' : 'pre';
      const w = (t) => ((t.result || {}).gameWins != null ? t.result.gameWins : 0);
      await series('lol:' + m.id, st, ts[0].code, ts[1].code, w(ts[0]), w(ts[1]),
        [ev.league && ev.league.name, ev.blockName].filter(Boolean).join(' · '), who, '/?go=esports&eg=lol');
    }
  }
  for (const game of ['cs2', 'valorant']) {
    const follow = subs.filter((s) => (s.f[game] || []).length);
    if (!follow.length) continue;
    let d = null;
    try {
      const r = await fetch(ORIGINS[0] + '/data/' + game + '.json', { cf: { cacheTtl: 60 } });
      if (r.ok) d = await r.json();
    } catch (e) {}
    for (const m of ((d && d.upcoming) || []).concat((d && d.recent) || [])) {
      const ts = m.teams || [];
      if (ts.length !== 2) continue;
      const ids = ts.map((t) => String((t && t.id) || ''));
      const who = follow.filter((s) => s.f[game].some((t) => ids.includes(String(t.id))));
      if (!who.length) continue;
      const st = m.status === 'running' ? 'in' : m.status === 'finished' ? 'post' : 'pre';
      const nm = (t) => (t && (t.acronym || t.name)) || '';
      await series(game + ':' + m.id, st, nm(ts[0]), nm(ts[1]), ts[0].score || 0, ts[1].score || 0,
        [m.league, m.event].filter(Boolean).join(' · '), who, '/?go=esports&eg=' + game);
    }
  }

  if (out.length) {
    const keys = await vapidKeys(env);
    // a handful at a time, so one slow push service holds up nothing else
    for (let i = 0; i < out.length; i += 6) {
      await Promise.all(out.slice(i, i + 6).map(([s, m]) => sendPush(env, keys, s, m).catch(() => 0)));
    }
  }
  return out.length;
}

/* Calls are settled from the source's own result, whatever the app
   reported, and a call the source dates after the start is voided. Each
   reader answers null while the result isn't in yet. */

// ESPN's summary for one football or NBA match
async function espnResult(p) {
  const path = p.sport === 'football' ? 'soccer/' + (p.league || 'all') : 'basketball/nba';
  const s = await espn(path + '/summary?event=' + encodeURIComponent(p.event));
  const comp = (((s.header || {}).competitions) || [])[0] || {};
  if (((comp.status || {}).type || {}).state !== 'post') return null;
  const cs = comp.competitors || [];
  const home = cs.find((x) => x.homeAway === 'home') || {}, away = cs.find((x) => x.homeAway === 'away') || {};
  return {
    outcome: home.winner ? 'home' : away.winner ? 'away' : 'draw',
    score: (home.score || '') + '-' + (away.score || ''),
    started: Date.parse(comp.date || '')
  };
}

// a driver's surname without accents or case: "Nico HÜLKENBERG" and "Nico Hulkenberg" agree
function surname(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z ]/g, ' ').trim().split(/\s+/).pop() || '';
}

/* An F1 podium: the race's top three from the scoreboard of its week. The
   app's call is three of its own driver keys; `ref` carries the same three
   by name, which is what can be matched here. Calls made before `ref` was
   sent stand as the app settled them (hit: null). */
async function f1Result(p, cache) {
  const range = ymdUTC(p.starts - 3 * DAY) + '-' + ymdUTC(p.starts + DAY);
  const sb = cache['f1' + range] || (cache['f1' + range] = await espn('racing/f1/scoreboard?dates=' + range));
  const ev = (sb.events || []).find((e) => String(e.id) === String(p.event));
  const race = ev && (ev.competitions || []).find((c) => ((c.type || {}).abbreviation) === 'Race');
  if (!race || ((race.status || {}).type || {}).state !== 'post') return null;
  const top = (race.competitors || []).slice().sort((a, b) => (a.order || 99) - (b.order || 99)).slice(0, 3)
    .map((x) => (x.athlete || {}).displayName || '');
  if (top.filter(Boolean).length < 3) return null;   // over, but the order isn't filled in yet
  const res = { outcome: 'p:' + top.join('~'), score: '', started: Date.parse(race.date || ''), hit: null };
  if (p.ref) {
    const mine = String(p.ref).replace(/^p:/, '').split('~').map(surname);
    const real = top.map(surname);
    const on = mine.filter((s) => s && real.includes(s)).length;
    res.hit = mine.filter(Boolean).length === 3 && on === 3;
    res.score = mine.filter((s, i) => s && s === real[i]).length + '/3';
  }
  return res;
}

// a LoL series: over once one side has won more than half its games
async function lolResult(p) {
  const r = await fetch(LOL + 'getEventDetails?hl=en-US&id=' + encodeURIComponent(p.event), { headers: { 'x-api-key': LOL_KEY } });
  if (!r.ok) throw new Error('lol ' + r.status);
  const m = ((((await r.json()).data || {}).event) || {}).match || {};
  const t = m.teams || [];
  if (t.length < 2) return null;
  const need = Math.floor(((m.strategy || {}).count || 1) / 2) + 1;
  const a = (t[0].result || {}).gameWins || 0, b = (t[1].result || {}).gameWins || 0;
  if (a < need && b < need) return null;
  return { outcome: a > b ? 'home' : 'away', score: a + '-' + b };
}

// CS2 and Valorant: the files the site publishes, which the app reads too
async function pandaResult(p, cache) {
  const f = p.sport;
  if (!cache[f]) {
    const r = await fetch(ORIGINS[0] + '/data/' + f + '.json', { cf: { cacheTtl: 60 } });
    if (!r.ok) throw new Error(f + ' ' + r.status);
    cache[f] = await r.json();
  }
  const m = [].concat(cache[f].recent || [], cache[f].upcoming || []).find((x) => String(x.id) === String(p.event));
  if (!m || m.status !== 'finished') return null;
  const t = m.teams || [];
  if (t.length < 2 || t[0].score == null || t[1].score == null || t[0].score === t[1].score) return null;
  return { outcome: t[0].score > t[1].score ? 'home' : 'away', score: t[0].score + '-' + t[1].score, started: Date.parse(m.start || '') };
}

const RESULTS = { football: espnResult, basketball: espnResult, f1: f1Result, esports: lolResult, cs2: pandaResult, valorant: pandaResult };

// A few per minute, in no fixed order, so a result that won't come in
// never holds up the ones behind it.
async function verifyPicks(env) {
  const sports = Object.keys(RESULTS).map((s) => "'" + s + "'").join(', ');
  const rows = (await env.DB.prepare(`SELECT * FROM picks WHERE verified = 0 AND sport IN (${sports})
      AND starts < ?1 ORDER BY RANDOM() LIMIT 8`).bind(Date.now() - 2.5 * 3600000).all()).results || [];
  const cache = {};
  let settled = 0;
  for (const p of rows) {
    let r;
    try { r = await RESULTS[p.sport](p, cache); } catch (e) { continue; }
    if (!r || r.hit === null) {
      // postponed, abandoned, or nothing here to check against: stop looking after a week
      if (r || Date.now() - p.starts > 7 * DAY) {
        await env.DB.prepare('UPDATE picks SET verified = 2 WHERE user_id = ?1 AND pkey = ?2').bind(p.user_id, p.pkey).run();
      }
      continue;
    }
    const valid = p.made < (r.started || p.starts);
    const hit = valid && (r.hit !== undefined ? r.hit : p.side === r.outcome);
    await env.DB.prepare(`UPDATE picks SET result = ?3, score = ?4, hit = ?5, settled = COALESCE(settled, ?6), verified = 1
        WHERE user_id = ?1 AND pkey = ?2`)
      .bind(p.user_id, p.pkey, r.outcome, r.score, hit ? 1 : 0, Date.now()).run();
    settled++;
  }
  return settled;
}

/* --------------------------------------------------------------- router */

/* ESPN serves the same scoreboards from several hosts, and turned the first
   one away from Cloudflare (403). Each is tried here, so the one that
   answers can be seen and used. */
const ESPN_PROBES = {
  site: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
  siteWeb: 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
  core: 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.1/events?limit=1',
  cdn: 'https://cdn.espn.com/core/soccer/scoreboard?xhr=1&league=eng.1'
};
// the other sources calls are settled from
const OTHER_PROBES = {
  lol: [LOL + 'getLeagues?hl=en-US', { 'x-api-key': LOL_KEY }],
  pages: [ORIGINS[0] + '/data/cs2.json', {}]
};
async function probe(url, headers) {
  try {
    const r = await fetch(url, { headers: Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      'Accept': 'application/json' }, headers) });
    return r.status + (r.ok ? ' ok' : '');
  } catch (e) { return 'error: ' + e.message; }
}
async function health(req, env) {
  const espn = {}, sources = {};
  await Promise.all(Object.keys(ESPN_PROBES).map(async (k) => { espn[k] = await probe(ESPN_PROBES[k], {}); })
    .concat(Object.keys(OTHER_PROBES).map(async (k) => { sources[k] = await probe(...OTHER_PROBES[k]); })));
  const n = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM subs) AS subs').first();
  const conf = {};
  ((await env.DB.prepare("SELECT k, v FROM config WHERE k IN ('tick', 'mailError')").all()).results || [])
    .forEach((r) => { try { conf[r.k] = JSON.parse(r.v); } catch (e) {} });
  const t = conf.tick;
  // the cron runs each minute; three missed in a row is a stopped cron
  const cron = t ? {
    ok: Date.now() - t.at < 3 * MIN && !t.error, last: new Date(t.at).toISOString(),
    agoSec: Math.round((Date.now() - t.at) / 1000), ms: t.ms, pushes: t.pushes, settled: t.settled, error: t.error
  } : { ok: false, last: null };
  const mail = { via: mailer(env) || 'off' };
  // the collector: when it last ran and what it reported failing
  const st = await readStatus();
  const collector = st ? {
    ok: Date.now() - Date.parse(st.ranAt) < 45 * MIN && !Object.values(st.sources || {}).some((x) => x && x.ok === false),
    agoMin: Math.round((Date.now() - Date.parse(st.ranAt)) / MIN),
    failing: Object.keys(st.sources || {}).filter((k) => st.sources[k] && st.sources[k].ok === false)
  } : { ok: false, error: 'status.json unreachable' };
  if (conf.mailError) mail.lastError = { at: new Date(conf.mailError.at).toISOString(), error: conf.mailError.error };
  return { ok: true, cron, espn, sources, collector, mail, users: n.users, subs: n.subs };
}

const ROUTES = {
  'GET /api/health': health,
  'POST /api/register': register,
  'POST /api/login': login,
  'POST /api/reset/request': resetRequest,
  'POST /api/reset/confirm': resetConfirm,
  // what the settings sheet offers: no reset link while no mail can go out
  'GET /api/features': async (req, env) => ({ mail: !!mailer(env) }),
  'POST /api/logout': async (req, env) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') || '');
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(m[1]).run();
    return { ok: true };
  },
  'GET /api/me': async (req, env) => { const u = await mustBe(req, env); return { nick: u.nick, email: u.email }; },
  'GET /api/vapid': async (req, env) => ({ key: (await vapidKeys(env)).pub }),
  'POST /api/push/subscribe': subscribe,
  'POST /api/push/unsubscribe': async (req, env) => {
    const b = await body(req);
    await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?1').bind(String(b.endpoint || '')).run();
    return { ok: true };
  },
  'POST /api/push/test': testPush,
  'POST /api/picks': putPick,
  'POST /api/picks/settle': settlePick,
  'GET /api/leaderboard': leaderboard,
  'GET /api/ratings': getRatings,
  'POST /api/ratings': putRating
};

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const route = ROUTES[req.method + ' ' + new URL(req.url).pathname];
    if (!route) return json(req, { error: 'not found' }, 404);
    try {
      await ensureSchema(env);
      return json(req, await route(req, env, ctx));
    } catch (e) {
      if (e instanceof HttpError) return json(req, Object.assign({ error: e.message }, e.extra), e.status);
      return json(req, { error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // exercised by the test page; nothing routes here
  _test: { encryptPayload, hashPassword, b64u, unb64u, tick, verifyPicks, sweep, surname, SESSION_IDLE, checkSources }
};
