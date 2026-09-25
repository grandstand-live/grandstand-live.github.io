/* Grandstand API — a Cloudflare Worker with one D1 database.

   Accounts, the calls leaderboard, post-match ratings, and web push for
   kick-offs, goals and results. Everything lives in the D1 binding `DB`;
   the tables are created on first use and the push keys are generated on
   first use, so deploying is: paste this file, bind the database, add a
   cron trigger. See README.md next to it.

   The Worker only talks to ESPN's public scoreboards. Whether ESPN answers
   a Cloudflare request is checked at /api/health — if it doesn't, pushes
   and server-side settling stand down and the rest keeps working. */

const ORIGINS = ['https://grandstand-live.github.io', 'http://localhost:8099'];
// site.api.espn.com turns Cloudflare away (403); site.web.api serves the same API and answers
const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports/';
const DAY = 86400000;

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
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
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
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS picks (user_id INTEGER NOT NULL, pkey TEXT NOT NULL, sport TEXT, event TEXT,
       league TEXT, side TEXT, starts INTEGER, made INTEGER, home TEXT, away TEXT, result TEXT, score TEXT,
       hit INTEGER, settled INTEGER, verified INTEGER DEFAULT 0, PRIMARY KEY (user_id, pkey))`,
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
  schemaReady = true;
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
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?1, ?2, ?3)')
    .bind(token, userId, Date.now()).run();
  return token;
}
async function whoIs(req, env) {
  const m = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  return await env.DB.prepare(
    'SELECT u.id, u.nick, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1'
  ).bind(m[1]).first();
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
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  // the same work and the same answer whether or not the address exists
  const hash = await hashPassword(String(b.password || ''), u ? u.salt : 'AAAAAAAAAAAAAAAAAAAAAA', u ? u.iter : DEFAULT_ITER);
  if (!u || !sameString(hash, u.hash)) throw new HttpError(401, 'wrong email or password');
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
  await env.DB.prepare(`INSERT INTO picks (user_id, pkey, sport, event, league, side, starts, made, home, away)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT (user_id, pkey) DO UPDATE SET side = excluded.side, made = excluded.made`)
    .bind(u.id, pkey, sport, event, String(b.league || ''), String(b.side).slice(0, 200), starts, Date.now(),
      String(b.home || '').slice(0, 60), String(b.away || '').slice(0, 60)).run();
  return { ok: true };
}

// Settlement the app reports. Football and NBA are checked against ESPN by
// the cron afterwards and corrected if they disagree; other sports stand
// as reported.
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
  // only once the match is over, and for three days after, when ESPN can say
  if (b.league) {
    try {
      const s = await espn('soccer/' + encodeURIComponent(b.league) + '/summary?event=' + encodeURIComponent(event));
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
  f1done: { zh: (gp, s) => `${gp} ${s} 结果`, en: (gp, s) => `${gp} ${s} result` }
};
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

async function tick(env) {
  await ensureSchema(env);
  const subs = (await env.DB.prepare('SELECT * FROM subs WHERE fails < 20').all()).results || [];
  const out = [];   // [sub, message]
  const leagues = {}, nba = {};
  let f1 = false;
  subs.forEach((s) => {
    let f = {};
    try { f = JSON.parse(s.follows || '{}'); } catch (e) {}
    s.f = f;
    (f.football || []).forEach((t) => { (leagues[t.league] = leagues[t.league] || new Set()).add(String(t.id)); });
    (f.nba || []).forEach((t) => { nba[String(t.id)] = 1; });
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

  if (out.length) {
    const keys = await vapidKeys(env);
    // a handful at a time, so one slow push service holds up nothing else
    for (let i = 0; i < out.length; i += 6) {
      await Promise.all(out.slice(i, i + 6).map(([s, m]) => sendPush(env, keys, s, m).catch(() => 0)));
    }
  }

  await verifyPicks(env);
}

/* Football and NBA calls are settled from ESPN's own result, whatever the
   app reported, and a call ESPN dates after kick-off is voided. A few per
   minute, oldest first. */
async function verifyPicks(env) {
  const rows = (await env.DB.prepare(`SELECT * FROM picks WHERE verified = 0 AND sport IN ('football', 'basketball')
      AND starts < ?1 ORDER BY starts LIMIT 8`).bind(Date.now() - 2.5 * 3600000).all()).results || [];
  for (const p of rows) {
    const path = p.sport === 'football' ? 'soccer/' + (p.league || 'all') : 'basketball/nba';
    let s;
    try { s = await espn(path + '/summary?event=' + encodeURIComponent(p.event)); } catch (e) { continue; }
    const comp = (((s.header || {}).competitions) || [])[0] || {};
    const st = ((comp.status || {}).type || {});
    if (st.state !== 'post') {
      // postponed or abandoned: leave it, and stop looking after a week
      if (Date.now() - p.starts > 7 * DAY) {
        await env.DB.prepare('UPDATE picks SET verified = 2 WHERE user_id = ?1 AND pkey = ?2').bind(p.user_id, p.pkey).run();
      }
      continue;
    }
    const cs = comp.competitors || [];
    const home = cs.find((x) => x.homeAway === 'home') || {}, away = cs.find((x) => x.homeAway === 'away') || {};
    const outcome = home.winner ? 'home' : away.winner ? 'away' : 'draw';
    const started = Date.parse(comp.date || '') || p.starts;
    const valid = p.made < started;
    await env.DB.prepare(`UPDATE picks SET result = ?3, score = ?4, hit = ?5, settled = COALESCE(settled, ?6), verified = 1
        WHERE user_id = ?1 AND pkey = ?2`)
      .bind(p.user_id, p.pkey, outcome, (home.score || '') + '-' + (away.score || ''),
        valid && p.side === outcome ? 1 : 0, Date.now()).run();
  }
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
async function health(req, env) {
  const espn = {};
  await Promise.all(Object.keys(ESPN_PROBES).map(async (k) => {
    try {
      const r = await fetch(ESPN_PROBES[k], {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
          'Accept': 'application/json' }
      });
      espn[k] = r.status + (r.ok ? ' ok' : '');
    } catch (e) { espn[k] = 'error: ' + e.message; }
  }));
  const n = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM subs) AS subs').first();
  return { ok: true, espn, users: n.users, subs: n.subs };
}

const ROUTES = {
  'GET /api/health': health,
  'POST /api/register': register,
  'POST /api/login': login,
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
      if (e instanceof HttpError) return json(req, { error: e.message }, e.status);
      return json(req, { error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // exercised by the test page; nothing routes here
  _test: { encryptPayload, hashPassword, b64u, unb64u, tick, verifyPicks }
};
