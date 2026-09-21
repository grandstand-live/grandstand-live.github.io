/* Grandstand data collector.
 *
 * Runs on GitHub's servers, so it is not bound by the browser's cross-origin
 * rules — that is the whole point. Everything it fetches is written into
 * data/*.json in this repo, which the site then reads same-origin.
 *
 * Two jobs:
 *   1. Capture League of Legends live stats while a match is in progress.
 *      Riot's feed only carries real numbers during the broadcast and is wiped
 *      afterwards, so whatever we snapshot here is what survives.
 *   2. Mirror the sources a static page cannot reach at all (CBA, CS2, Valorant).
 *
 * Every source is isolated: one failing feed must never stop the others, and
 * data/status.json records exactly what happened on the last run.
 */
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const UA = 'grandstand-live/1.0 (+https://grandstand-live.github.io)';
const DATA = 'data';
const LOL_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LOL_API = 'https://esports-api.lolesports.com/persisted/gw/';
const LOL_FEED = 'https://feed.lolesports.com/livestats/v1/';
// the leagues worth polling; matching the ones the site puts in front of people
const LOL_LEAGUES = ['worlds', 'msi', 'first_stand', 'lpl', 'lck', 'lec', 'lcs', 'lcp', 'pcs', 'ewc_lol'];

const status = { ranAt: new Date().toISOString(), sources: {} };

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function save(file, value) {
  const path = join(DATA, file);
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

async function load(file) {
  try { return JSON.parse(await readFile(join(DATA, file), 'utf8')); }
  catch { return null; }
}

/* A frame is only worth keeping if it actually carries numbers — Riot serves
   zero-filled frames outside the broadcast window. */
function framePopulated(frame) {
  if (!frame) return false;
  const b = frame.blueTeam || {};
  const r = frame.redTeam || {};
  return (b.totalGold || 0) + (r.totalGold || 0) > 0 || (b.totalKills || 0) + (r.totalKills || 0) > 0;
}

async function collectLol() {
  const headers = { 'x-api-key': LOL_KEY };
  const leagues = await getJSON(`${LOL_API}getLeagues?hl=zh-CN`, headers);
  const wanted = (leagues?.data?.leagues || []).filter(l => LOL_LEAGUES.includes(l.slug));

  let live = 0, captured = 0;
  for (const league of wanted) {
    let schedule;
    try {
      schedule = await getJSON(`${LOL_API}getSchedule?hl=zh-CN&leagueId=${league.id}`, headers);
    } catch { continue; }

    const events = (schedule?.data?.schedule?.events || [])
      .filter(e => e.type === 'match' && e.match && e.state === 'inProgress');

    for (const event of events) {
      live++;
      let detail;
      try {
        detail = await getJSON(`${LOL_API}getEventDetails?hl=zh-CN&id=${event.match.id}`, headers);
      } catch { continue; }

      const games = detail?.data?.event?.match?.games || [];
      const teams = detail?.data?.event?.match?.teams || [];

      for (const game of games) {
        if (game.state === 'unneeded' || game.state === 'unstarted') continue;
        let window, details;
        try { window = await getJSON(`${LOL_FEED}window/${game.id}`); } catch { continue; }
        try { details = await getJSON(`${LOL_FEED}details/${game.id}`); } catch { /* optional */ }

        const frames = window?.frames || [];
        const frame = frames[frames.length - 1];
        if (!framePopulated(frame)) continue;

        const meta = window?.gameMetadata || {};
        const playerFrames = details?.frames || [];
        const players = playerFrames[playerFrames.length - 1]?.participants || [];

        // Hold on to the fullest snapshot: a later poll during the same game
        // should only replace an earlier one if it has more of the match in it.
        const existing = await load(`lol/${game.id}.json`);
        const total = (frame.blueTeam?.totalGold || 0) + (frame.redTeam?.totalGold || 0);
        if (existing && (existing.totalGold || 0) > total) continue;

        await save(`lol/${game.id}.json`, {
          gameId: game.id,
          matchId: event.match.id,
          number: game.number,
          league: league.name,
          capturedAt: new Date().toISOString(),
          patch: meta.patchVersion || '',
          totalGold: total,
          teams: teams.map(t => ({ id: t.id, code: t.code, name: t.name })),
          blue: {
            metadata: meta.blueTeamMetadata || null,
            kills: frame.blueTeam?.totalKills || 0,
            gold: frame.blueTeam?.totalGold || 0,
            towers: frame.blueTeam?.towers || 0,
            barons: frame.blueTeam?.barons || 0,
            inhibitors: frame.blueTeam?.inhibitors || 0,
            dragons: frame.blueTeam?.dragons || []
          },
          red: {
            metadata: meta.redTeamMetadata || null,
            kills: frame.redTeam?.totalKills || 0,
            gold: frame.redTeam?.totalGold || 0,
            towers: frame.redTeam?.towers || 0,
            barons: frame.redTeam?.barons || 0,
            inhibitors: frame.redTeam?.inhibitors || 0,
            dragons: frame.redTeam?.dragons || []
          },
          players: players.map(p => ({
            id: p.participantId,
            kills: p.kills, deaths: p.deaths, assists: p.assists,
            gold: p.totalGoldEarned, cs: p.creepScore, level: p.level,
            damageShare: p.championDamageShare, killParticipation: p.killParticipation
          }))
        });
        captured++;
      }
    }
  }
  return { liveMatches: live, gamesCaptured: captured };
}

/* --- mirrors for the feeds a browser cannot reach ---
   These run with API keys held in GitHub Secrets. A key never reaches the
   published page: the Action fetches, and only the resulting JSON is committed. */

// A hand-triggered run is someone asking a question of the data, so it must
// never be answered from cache — throttles exist for the scheduled cadence.
const MANUAL = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
const PANDA = process.env.PANDASCORE_TOKEN || '';
const APISPORTS = process.env.APISPORTS_KEY || '';

/* Keep enough of a PandaScore match to render it the way the League of Legends
   board renders Riot's: grouped under its own event, with crests, a series
   score, the maps inside it and somewhere to watch. */
function pandaMatch(m) {
  const sides = (m.opponents || []).map(o => o.opponent || {});
  const scores = m.results || [];
  const scoreFor = id => {
    const hit = scores.find(r => r.team_id === id);
    return hit ? hit.score : null;
  };
  const league = m.league || {};
  const serie = m.serie || {};
  const tournament = m.tournament || {};
  const streams = (m.streams_list || []).filter(s => s.raw_url);
  const stream = streams.find(s => s.main && s.language === 'en') ||
    streams.find(s => s.main) || streams.find(s => s.language === 'zh') || streams[0];
  return {
    id: m.id,
    name: m.name || '',
    start: m.begin_at || m.scheduled_at || null,
    status: m.status || '',
    bo: m.number_of_games || null,
    // the chip row groups on this, so it has to be the bare league name
    league: league.name || '',
    leagueSlug: league.slug || '',
    leagueImage: league.image_url || '',
    // ...and the card heading is the specific event inside it
    event: [serie.full_name, tournament.name].filter(Boolean).join(' · ') ||
      serie.full_name || tournament.name || league.name || '',
    tier: tournament.tier || '',
    winner: m.winner_id || null,
    teams: sides.map(t => ({
      id: t.id,
      name: t.name || '',
      acronym: t.acronym || '',
      image: t.image_url || '',
      score: scoreFor(t.id)
    })),
    games: (m.games || []).map(g => ({
      pos: g.position || null,
      status: g.status || '',
      winner: (g.winner || {}).id || null,
      length: g.length || null
    })),
    stream: stream ? { url: stream.raw_url, lang: stream.language || '' } : null
  };
}

async function collectPanda(game, file) {
  if (!PANDA) throw new Error('missing PANDASCORE_TOKEN secret');
  const headers = { authorization: `Bearer ${PANDA}` };
  const base = `https://api.pandascore.co/${game}/matches`;
  // The board splits these rows across a dozen events, so a single page left
  // most events showing one or two matches. 100 is PandaScore's per-page cap,
  // and two pages a side is enough that picking any event has a real schedule
  // behind it.
  const page = (kind, extra, n) =>
    getJSON(`${base}/${kind}?per_page=100&page=${n}&${extra}`, headers).catch(() => []);
  const [up1, up2, past1, past2, running] = await Promise.all([
    page('upcoming', 'sort=scheduled_at', 1),
    page('upcoming', 'sort=scheduled_at', 2),
    page('past', 'sort=-scheduled_at', 1),
    page('past', 'sort=-scheduled_at', 2),
    getJSON(`${base}/running?per_page=50`, headers).catch(() => [])
  ]);
  const upcoming = (up1 || []).concat(up2 || []);
  const past = (past1 || []).concat(past2 || []);
  const live = (running || []).map(pandaMatch);
  const liveIds = new Set(live.map(m => m.id));
  const value = {
    upcoming: live.concat((upcoming || []).map(pandaMatch).filter(m => !liveIds.has(m.id))),
    recent: (past || []).map(pandaMatch)
  };
  await save(file, { updatedAt: new Date().toISOString(), source: 'pandascore', ...value });
  return {
    source: 'pandascore', live: live.length,
    upcoming: value.upcoming.length, recent: value.recent.length,
    leagues: [...new Set(value.upcoming.concat(value.recent)
      .map(m => m.league).filter(Boolean))].length
  };
}

const collectCs2 = () => collectPanda('csgo', 'cs2.json');
const collectValorant = () => collectPanda('valorant', 'valorant.json');

/* API-Sports gives 100 requests a day on the free plan, so the CBA is polled
   once an hour rather than on every five-minute tick. */
/* The free API-Sports plan stops at the 2024 season, which is no use to a live
   board. Try the sources Chinese sites use first — this runs on a US runner, so
   a block or a timeout is a real possibility and is reported rather than hidden. */
async function getText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; grandstand-live/1.0)',
      'accept': 'application/json, text/plain, */*',
      ...headers
    }
  });
  const body = await res.text();
  return { status: res.status, body };
}

function ymdLocal(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* Walk any JSON and collect objects that look like a fixture: two sides and a
   time. Shapes differ per provider, so recognise the pattern, not the schema. */
function harvestMatches(node, out = [], depth = 0) {
  if (!node || depth > 6 || out.length > 200) return out;
  if (Array.isArray(node)) {
    for (const item of node) harvestMatches(item, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  const keys = Object.keys(node);
  const pick = re => keys.find(k => re.test(k));
  const leftName = pick(/^(leftname|hostname|homename|team1|hometeam|home_?team_?name|teamaname|team_?a_?name|host_?team|homeName)$/i);
  const rightName = pick(/^(rightname|guestname|awayname|team2|awayteam|away_?team_?name|teambname|team_?b_?name|guest_?team|awayName)$/i);
  const when = pick(/^(starttime|matchtime|startdate|date|time|start_?time|match_?time|begin_?time|start_?at|matchdate|match_?date)$/i);
  if (leftName && rightName && when) {
    const g = k => (k ? node[k] : undefined);
    out.push({
      raw: node,
      start: g(when),
      status: g(pick(/^(matchperiod|matchdesc|status|state)$/i)) || '',
      home: { name: g(leftName), logo: g(pick(/^(leftbadge|leftlogo|homelogo)$/i)) || '',
        score: g(pick(/^(leftgoal|homescore|hostscore|score1)$/i)) ?? null },
      away: { name: g(rightName), logo: g(pick(/^(rightbadge|rightlogo|awaylogo)$/i)) || '',
        score: g(pick(/^(rightgoal|awayscore|guestscore|score2)$/i)) ?? null },
      league: g(pick(/^(leaguename|competitionname|matchname)$/i)) || ''
    });
    return out;
  }
  for (const k of keys) harvestMatches(node[k], out, depth + 1);
  return out;
}

/* When a source returns JSON the sniffer does not recognise, report the key
   sets of the objects it does contain — that is what names the fields. */
function sniffKeys(node, out = [], depth = 0) {
  if (!node || depth > 6 || out.length > 40) return out;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 3)) sniffKeys(item, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  const keys = Object.keys(node);
  if (keys.length >= 4) out.push(keys.slice(0, 12));
  for (const k of keys) sniffKeys(node[k], out, depth + 1);
  return out;
}

async function collectCbaChina(notes) {
  // columnId=100000 is Tencent's NBA column — it never carries a CBA fixture,
  // so ask for everything and keep only what is actually the CBA.
  // Last sweep of the Chinese sources. This runs on a US runner, so a block or
  // a redirect to an HTML page is a real possibility; each one is reported in
  // status.json rather than swallowed, and the shape sniffer below means a
  // source only has to return JSON that *contains* fixtures somewhere.
  const candidates = [
    ['tencent', `https://matchweb.sports.qq.com/matchUnion/list?startTime=${ymdLocal(-10)}&endTime=${ymdLocal(21)}`],
    ['tencent-cba', `https://matchweb.sports.qq.com/matchUnion/list?columnId=100014&startTime=${ymdLocal(-10)}&endTime=${ymdLocal(21)}`],
    ['sina', `https://match.sports.sina.com.cn/basketball/cba/api/match/get_match_list?dpc=1&date_begin=${ymdLocal(-10)}&date_end=${ymdLocal(21)}`],
    ['sina-live', 'https://interface.sina.cn/sports/basketball/cba/getMatchList.d.json?date_begin=' + ymdLocal(-10) + '&date_end=' + ymdLocal(21)],
    ['cbaleague', 'https://www.cbaleague.com/api/v1/match/list?pageSize=40&pageNum=1'],
    ['dongqiudi', 'https://api.dongqiudi.com/data/v3/basketball/match/list?competition_id=1004'],
    ['baidu', `https://tiyu.baidu.com/api/match/%E4%B8%AD%E5%9B%BD%E7%94%B7%E7%AF%AE/live/date/${ymdLocal(0)}/direction/after?showNum=40`]
  ];
  for (const [label, url] of candidates) {
    try {
      const { status, body } = await getText(url);
      if (status !== 200 || !body) { notes.push(`${label} -> HTTP ${status}`); continue; }
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { notes.push(`${label} -> not JSON: ${body.slice(0, 120)}`); continue; }

      const found = harvestMatches(parsed);
      if (!found.length) {
        // Say what the payload actually looked like, so the next attempt can
        // teach the sniffer the right key names instead of guessing again.
        notes.push(`${label} -> 200, no fixtures; top: ${Object.keys(parsed).slice(0, 6).join(',')}` +
          `; inner: ${sniffKeys(parsed).slice(0, 3).map(k => k.join('+')).join(' | ')}`);
        continue;
      }
      // Only the CBA. An earlier version fell back to "whatever came back",
      // which quietly filled the CBA tab with NBA preseason games.
      const isCba = m => /CBA|中国男子篮球/i.test(`${m.league} ${m.status}`);
      const cba = found.filter(isCba);
      const seen = [...new Set(found.map(m => m.league || m.status || '?'))].slice(0, 10);
      notes.push(`${label} -> ${found.length} fixtures, ${cba.length} CBA; saw: ${seen.join(' / ')}`);
      if (!cba.length) continue;
      return { source: label, matches: cba.map(m => ({
        start: m.start, status: m.status, league: m.league,
        home: m.home, away: m.away
      })) };
    } catch (err) {
      notes.push(`${label} -> ${String(err.message || err).slice(0, 90)}`);
    }
  }
  return null;
}

async function collectCba() {
  const notes = [];
  const live = await collectCbaChina(notes);
  if (live && live.matches.length) {
    const nowMs = Date.now();
    const shaped = live.matches.map(m => ({
      start: m.start, status: m.status,
      home: m.home, away: m.away
    }));
    const value = {
      upcoming: shaped.filter(m => new Date(m.start).getTime() >= nowMs - 3 * 3600e3).slice(0, 30),
      recent: shaped.filter(m => new Date(m.start).getTime() < nowMs - 3 * 3600e3).slice(-30).reverse()
    };
    await save('cba.json', {
      updatedAt: new Date().toISOString(), source: live.source, season: '当季', ...value
    });
    return { source: live.source, upcoming: value.upcoming.length, recent: value.recent.length, tried: notes };
  }
  // nothing live available — fall back to whatever the API-Sports plan allows
  const fallback = await collectCbaApiSports();
  return { ...fallback, tried: [...notes, ...(fallback.tried || [])] };
}

async function collectCbaApiSports() {
  if (!APISPORTS) throw new Error('missing APISPORTS_KEY secret');
  const now = new Date();
  const previous = await load('cba.json');
  // The hourly throttle exists to protect a 100-a-day quota, but it must not
  // pin a bad answer in place: a stored season from a bygone year is re-fetched
  // straight away, while a current season that simply has no fixtures yet waits.
  const era = [now.getFullYear(), now.getFullYear() - 1].map(String);
  const seasonLooksCurrent = era.some(y => String(previous?.season || '').includes(y));
  const hasGames = ((previous?.upcoming || []).length + (previous?.recent || []).length) > 0;
  const age = previous?.updatedAt ? now - new Date(previous.updatedAt) : Infinity;
  // A good answer is cached for an hour. An empty one is retried, but only every
  // three hours, so a league that is simply between seasons cannot drain the
  // 100-calls-a-day quota. A stale season is always re-fetched at once.
  const holdFor = hasGames ? 55 * 60 * 1000 : 3 * 60 * 60 * 1000;
  if (!MANUAL && seasonLooksCurrent && age < holdFor) {
    return {
      source: previous.source, season: previous.season,
      skipped: hasGames ? 'polled within the hour' : 'empty, waiting 3h before retry'
    };
  }

  const headers = { 'x-apisports-key': APISPORTS };
  const base = 'https://v1.basketball.api-sports.io/';

  let leagueId = previous?.leagueId;
  let season = seasonLooksCurrent ? previous?.season : null;
  let leagueName = previous?.leagueName;
  if (!leagueId || !season) {
    const found = await getJSON(`${base}leagues?country=China`, headers);
    const leagues = found?.response || [];
    const league = leagues.find(l => /^CBA$|Chinese Basketball/i.test(l.name || '')) ||
      leagues.find(l => /CBA/i.test(l.name || '')) || leagues[0];
    if (!league) throw new Error('no Chinese league in API-Sports response');
    leagueId = league.id;
    leagueName = league.name;
    // the seasons array is not in chronological order, so sort by start date
    const seasons = (league.seasons || []).slice().sort((a, b) =>
      new Date(b.start || 0) - new Date(a.start || 0));
    season = (seasons.find(s => s.current) || seasons[0])?.season;
  }
  if (!season) throw new Error('no season for CBA');

  // API-Sports answers 200 with an `errors` object when a plan or a parameter is
  // the problem, so surface that instead of silently showing an empty schedule.
  const notes = [];
  async function fetchSeason(value) {
    const payload = await getJSON(
      `${base}games?league=${leagueId}&season=${encodeURIComponent(value)}`, headers);
    const errs = payload?.errors;
    const errText = errs && (Array.isArray(errs) ? errs.join('; ')
      : Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('; '));
    if (errText) notes.push(`${value} -> ${errText}`);
    else notes.push(`${value} -> ${payload?.results ?? 0} games`);
    return payload;
  }

  let games = await fetchSeason(season);
  if (!(games?.response || []).length && /^\d{4}-\d{4}$/.test(season)) {
    // a season that has not started yet returns nothing — walk back a few years,
    // which also covers a free plan that only exposes older seasons
    const [a, b] = season.split('-').map(Number);
    for (let back = 1; back <= 3; back++) {
      const older = `${a - back}-${b - back}`;
      const retry = await fetchSeason(older);
      if ((retry?.response || []).length) { games = retry; season = older; break; }
    }
  }
  const all = (games?.response || []).map(g => ({
    id: g.id,
    start: g.date,
    status: g.status?.short || '',
    home: { name: g.teams?.home?.name, logo: g.teams?.home?.logo, score: g.scores?.home?.total ?? null },
    away: { name: g.teams?.away?.name, logo: g.teams?.away?.logo, score: g.scores?.away?.total ?? null }
  }));
  const nowMs = now.getTime();
  const value = {
    leagueId, season, leagueName,
    upcoming: all.filter(g => new Date(g.start).getTime() >= nowMs - 3 * 3600e3)
      .sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 30),
    recent: all.filter(g => new Date(g.start).getTime() < nowMs - 3 * 3600e3)
      .sort((a, b) => new Date(b.start) - new Date(a.start)).slice(0, 30)
  };
  await save('cba.json', {
    updatedAt: now.toISOString(), source: 'api-sports', leagueName, ...value
  });
  return {
    source: 'api-sports', league: leagueId, leagueName, season,
    upcoming: value.upcoming.length, recent: value.recent.length,
    tried: notes
  };
}

/* ==========================================================================
   UFC rankings.

   ESPN publishes a rankings endpoint, but it has been frozen since 2022 — it
   still has Usman at welterweight — so it is unusable. The UFC's own rankings
   page is server-rendered and current, so the ladder comes from there and the
   per-fighter detail the site needs (ESPN athlete id, flag, record) is looked
   up on ESPN and cached in data/ufc-athletes.json, because an id and a flag
   never change and a record changes only when the fighter fights.

   The ESPN id matters: it is what the "my fighters" tab matches against the
   competitors on ESPN's event cards.
   ========================================================================== */
const UFC_RANKINGS_PAGE = 'https://www.ufc.com/rankings';
const ESPN_SEARCH = 'https://site.web.api.espn.com/apis/search/v2';
const ESPN_ATHLETE = 'https://sports.core.api.espn.com/v2/sports/mma/athletes';

// header on ufc.com -> [key, Chinese name, order]
const UFC_DIVISIONS = [
  [/men'?s?\s*pound[\s-]*for[\s-]*pound/i, ['p4p', '男子磅对磅', 0]],
  [/women'?s?\s*pound[\s-]*for[\s-]*pound/i, ['wp4p', '女子磅对磅', 1]],
  [/^pound[\s-]*for[\s-]*pound/i, ['p4p', '男子磅对磅', 0]],
  [/women'?s?\s*strawweight/i, ['wsw', '女子草量级 (115 lb)', 20]],
  [/women'?s?\s*flyweight/i, ['wfw', '女子蝇量级 (125 lb)', 21]],
  [/women'?s?\s*bantamweight/i, ['wbw', '女子雏量级 (135 lb)', 22]],
  [/women'?s?\s*featherweight/i, ['wfe', '女子羽量级 (145 lb)', 23]],
  [/heavyweight/i, ['hw', '重量级 (265 lb)', 10]],
  [/light\s*heavyweight/i, ['lhw', '轻重量级 (205 lb)', 11]],
  [/middleweight/i, ['mw', '中量级 (185 lb)', 12]],
  [/welterweight/i, ['ww', '次中量级 (170 lb)', 13]],
  [/lightweight/i, ['lw', '轻量级 (155 lb)', 14]],
  [/featherweight/i, ['fw', '羽量级 (145 lb)', 15]],
  [/bantamweight/i, ['bw', '雏量级 (135 lb)', 16]],
  [/flyweight/i, ['flw', '蝇量级 (125 lb)', 17]]
];

function ufcDivision(header) {
  // "light heavyweight" also matches /heavyweight/, so test the long names first
  const ordered = [...UFC_DIVISIONS].sort((a, b) => b[0].source.length - a[0].source.length);
  for (const [re, meta] of ordered) if (re.test(header)) return meta;
  return null;
}

function htmlText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/* The page is a Drupal view: one .view-grouping per division, a caption
   holding the champion, then one table row per ranked fighter. Rank numbers
   and names are pulled separately and zipped, which survives the markup
   changing around them far better than one big row-shaped regex would. */
function parseUfcRankings(html) {
  const chunks = html.split('<div class="view-grouping">').slice(1);
  const out = [];
  for (const chunk of chunks) {
    const header = htmlText((chunk.match(/<div class="view-grouping-header">([\s\S]*?)<\/div>/) || [])[1]);
    if (!header) continue;
    const meta = ufcDivision(header);
    if (!meta) continue;

    // The caption holds a champion for a weight division and the number one
    // for pound-for-pound, and the only thing telling them apart is the label
    // underneath, so read that rather than assuming.
    const capMatch = chunk.match(
      /rankings--athlete--champion[\s\S]{0,1200}?<h5>\s*<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,300}?)<\/h6>/);
    const captioned = capMatch
      ? { name: htmlText(capMatch[2]), slug: capMatch[1], label: htmlText(capMatch[3]) }
      : null;
    const isChampion = !!captioned && /champion/i.test(captioned.label) &&
      meta[0] !== 'p4p' && meta[0] !== 'wp4p';

    const body = chunk.split('<tbody>')[1] || chunk;
    const ranks = [...body.matchAll(/views-field-meta-weight-class-rank"[^>]*>\s*(\d+)/g)]
      .map(m => m[1]);
    const names = [...body.matchAll(/views-field-title"[^>]*>\s*<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(m => ({ slug: m[1], name: htmlText(m[2]) }));
    if (!names.length && !captioned) continue;

    const ladder = names.map((n, i) => ({ ...n, rank: ranks[i] || String(i + 1) }));
    if (captioned && !isChampion && !ladder.some(r => r.slug === captioned.slug)) {
      ladder.unshift({ slug: captioned.slug, name: captioned.name, rank: '1' });
    }

    out.push({
      key: meta[0], nameCN: meta[1], order: meta[2], name: header,
      champion: isChampion ? { name: captioned.name, slug: captioned.slug } : null,
      ranks: ladder
    });
  }
  // the page repeats some groupings; first one wins
  const seen = new Set();
  return out.filter(d => (seen.has(d.key) ? false : (seen.add(d.key), true)));
}

/* NFD only splits accents off letters that decompose; ł, ø, đ and ß are
   letters in their own right and survive it, which is how Jan Błachowicz
   failed to match ESPN's "Blachowicz". */
const deLetter = s => String(s || '')
  .replace(/[łŁ]/g, 'l').replace(/[øØ]/g, 'o').replace(/[đĐ]/g, 'd')
  .replace(/[ıİ]/g, 'i').replace(/[ßẞ]/g, 'ss')
  .replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe').replace(/[þÞ]/g, 'th')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

const normName = n => deLetter(n)
  .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/* Find a fighter on ESPN. Everything here is best-effort: a fighter ESPN does
   not know about still shows up in the ladder, just without a flag or record. */
async function espnFighter(name) {
  // ask twice at most: as written, then with the accents flattened
  const queries = [name];
  if (deLetter(name) !== name) queries.push(deLetter(name));
  let id = '';
  for (const q of queries) {
    const url = `${ESPN_SEARCH}?region=us&lang=en&limit=5&page=1&type=player&sport=mma` +
      `&query=${encodeURIComponent(q)}`;
    try {
      const found = await getJSON(url);
      for (const group of (found && found.results) || []) {
        for (const item of group.contents || []) {
          const uid = String(item.uid || '');
          if (!/s:3301~a:(\d+)/.test(uid)) continue;
          if (normName(item.displayName) !== normName(name)) continue;
          id = uid.match(/a:(\d+)/)[1];
          break;
        }
        if (id) break;
      }
    } catch { /* fall through to an empty entry */ }
    if (id) break;
  }
  if (!id) return { id: '', flag: '', headshot: '', record: '' };

  const entry = { id, flag: '', headshot: '', record: '' };
  try {
    const a = await getJSON(`${ESPN_ATHLETE}/${id}?lang=en&region=us`);
    entry.flag = (a && a.flag && a.flag.href) || '';
    entry.headshot = (a && a.headshot && a.headshot.href) || '';
  } catch { /* a missing flag is not worth failing the run over */ }
  try {
    const r = await getJSON(`${ESPN_ATHLETE}/${id}/records/0?lang=en&region=us`);
    entry.record = (r && (r.summary || r.displayValue)) || '';
  } catch { /* same for the record */ }
  return entry;
}

/* Small pool so ESPN is never hit with 150 requests at once. */
async function mapPool(items, size, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

async function collectUfcRankings() {
  // The UFC moves this ladder once a week; a scheduled run refreshes it every
  // six hours and a hand-triggered run always refetches.
  const previous = await load('ufc-rankings.json');
  if (!MANUAL && previous && (previous.divisions || []).length &&
      Date.now() - new Date(previous.updatedAt).getTime() < 6 * 3600e3) {
    return { skipped: 'fresh', divisions: previous.divisions.length };
  }

  const page = await getText(UFC_RANKINGS_PAGE, { accept: 'text/html' });
  if (page.status !== 200) throw new Error(`ufc.com/rankings HTTP ${page.status}`);
  const parsed = parseUfcRankings(page.body);
  if (!parsed.length) {
    throw new Error(`ufc.com/rankings did not parse (${page.body.length} bytes)`);
  }

  // one cache entry per fighter: the id and flag never change, the record only
  // moves when they fight, so a day-old entry is reused as is
  const cache = (await load('ufc-athletes.json')) || { updatedAt: 0, fighters: {} };
  const stale = Date.now() - new Date(cache.updatedAt || 0).getTime() > 24 * 3600e3;

  const wanted = [];
  for (const d of parsed) {
    if (d.champion) wanted.push(d.champion.name);
    for (const r of d.ranks) wanted.push(r.name);
  }
  const unique = [...new Set(wanted)];
  const missing = unique.filter(n => stale || !cache.fighters[normName(n)]);
  const looked = await mapPool(missing, 6, espnFighter);
  missing.forEach((n, i) => { cache.fighters[normName(n)] = looked[i]; });
  cache.updatedAt = new Date().toISOString();
  await save('ufc-athletes.json', cache);

  const dress = (who, rank) => {
    if (!who) return null;
    const hit = cache.fighters[normName(who.name)] || {};
    return {
      id: hit.id || ('ufc:' + who.slug.split('/').pop()),
      name: who.name,
      flag: hit.flag || '',
      headshot: hit.headshot || '',
      record: hit.record || '',
      rank: rank,
      link: who.slug ? 'https://www.ufc.com' + who.slug : ''
    };
  };

  const divisions = parsed
    .sort((a, b) => a.order - b.order)
    .map(d => ({
      name: d.name,
      nameCN: d.nameCN,
      champion: dress(d.champion, 'C'),
      ranks: d.ranks.map(r => dress(r, r.rank)).filter(Boolean)
    }))
    .filter(d => d.champion || d.ranks.length);

  await save('ufc-rankings.json', {
    updatedAt: new Date().toISOString(), source: 'UFC.com', divisions
  });
  const fighters = divisions.reduce((n, d) => n + d.ranks.length + (d.champion ? 1 : 0), 0);
  return {
    source: 'UFC.com', divisions: divisions.length, fighters,
    lookedUp: missing.length,
    withEspnId: divisions.reduce((n, d) => n +
      [d.champion, ...d.ranks].filter(f => f && !/^ufc:/.test(f.id)).length, 0)
  };
}

/* ==========================================================================
   Round-by-round UFC numbers.

   ESPN only publishes a fight's totals — its statistics document has a single
   "All Splits" entry and asking for /1 redirects back to it. The UFC's own
   live feed does carry per-round stats (strikes by target and position,
   control time, knockdowns), and it allows cross-origin reads, so the page can
   fetch a fight directly. What it cannot do is work out *which* fight: the UFC
   keys on its own ids. So this builds the index — surnames to UFC fight id —
   and the page looks a bout up in it.
   ========================================================================== */
const UFC_LIVE = 'https://d29dxerjsp82wz.cloudfront.net/api/v3';

const surnameKey = name => deLetter(name).toLowerCase()
  .replace(/[^a-z ]/g, '').trim().split(/\s+/).pop() || '';

function fightKey(a, b) {
  return [surnameKey(a), surnameKey(b)].filter(Boolean).sort().join('|');
}

async function ufcEvent(id) {
  try {
    const d = await getJSON(`${UFC_LIVE}/event/live/${id}.json`);
    return (d && d.LiveEventDetail) || null;
  } catch { return null; }
}

async function collectUfcFights() {
  const cache = (await load('ufc-fights.json')) ||
    { maxEventId: 1240, minEventId: 1240, fights: {} };
  const seen = { ...cache.fights };
  const notes = [];

  /* Two jobs. Forward: pick up new cards and re-read the recent ones, since a
     result only lands after the fight. Backward: fill in history, because an
     index that only covers the last few events means most bouts on the board
     have no per-round numbers behind them. The back-fill walks down a block at
     a time until it reaches the start of the UFC's numbering. */
  const ids = [];
  for (let i = Math.max(1, cache.maxEventId - 6); i <= cache.maxEventId + 12; i++) ids.push(i);

  const floor = 900;   // earlier ids answer, but predate the per-round feed
  let back = cache.minEventId || cache.maxEventId;
  for (let n = 0; n < 45 && back > floor; n++) ids.push(--back);
  const minSeen = Math.min(back, cache.minEventId || Infinity);

  let maxSeen = cache.maxEventId;
  let added = 0;
  const fetched = await mapPool(ids, 6, ufcEvent);
  for (let n = 0; n < ids.length; n++) {
    const id = ids[n];
    const ev = fetched[n];
    if (!ev) continue;
    maxSeen = Math.max(maxSeen, id);
    const date = String(ev.StartTime || '').slice(0, 10);
    for (const fight of ev.FightCard || []) {
      const names = (fight.Fighters || []).map(f => (f.Name || {}).LastName || '');
      if (names.length !== 2 || !names[0] || !names[1]) continue;
      const key = fightKey(names[0], names[1]);
      if (!key) continue;
      const row = { id: fight.FightId, date, event: ev.Name || '' };
      const list = (seen[key] || []).filter(x => x.id !== row.id);
      list.push(row);
      seen[key] = list.slice(-4);   // a rematch keeps both, not a growing list
      added++;
    }
  }
  notes.push(`scanned ${ids.length} events up to ${maxSeen}`);

  await save('ufc-fights.json', {
    updatedAt: new Date().toISOString(),
    maxEventId: maxSeen, minEventId: minSeen, fights: seen
  });
  return {
    pairs: Object.keys(seen).length, indexed: added,
    maxEventId: maxSeen, minEventId: minSeen, tried: notes
  };
}

/* ==========================================================================
   Boxing — no promoter and no broadcaster publishes a free feed, and ESPN has
   no boxing league at all. Wikipedia's per-fight articles all carry the same
   {{Infobox boxing match}}, which gives date, venue, both records and the
   official result, so that is what this reads. Coverage is therefore "the
   fights notable enough to have an article", which is close to what a fan
   would look for anyway.
   ========================================================================== */
const WIKI_API = 'https://en.wikipedia.org/w/api.php';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12
};

// hometown -> IOC code, which is what ESPN's flag CDN is keyed on
const COUNTRY_CODE = {
  'us': 'usa', 'u.s.': 'usa', 'usa': 'usa', 'united states': 'usa', 'america': 'usa',
  'england': 'eng', 'scotland': 'sco', 'wales': 'wal', 'northern ireland': 'nir',
  'uk': 'gbr', 'u.k.': 'gbr', 'united kingdom': 'gbr', 'great britain': 'gbr',
  'ireland': 'irl', 'republic of ireland': 'irl',
  'mexico': 'mex', 'mex.': 'mex', 'japan': 'jpn', 'philippines': 'phi',
  'russia': 'rus', 'ukraine': 'ukr', 'kyrgyzstan': 'kgz', 'kazakhstan': 'kaz',
  'uzbekistan': 'uzb', 'georgia (country)': 'geo', 'armenia': 'arm',
  'azerbaijan': 'aze', 'sweden': 'swe', 'norway': 'nor', 'denmark': 'den',
  'finland': 'fin', 'iceland': 'isl', 'netherlands': 'ned', 'belgium': 'bel',
  'france': 'fra', 'germany': 'ger', 'spain': 'esp', 'portugal': 'por',
  'italy': 'ita', 'greece': 'gre', 'switzerland': 'sui', 'austria': 'aut',
  'poland': 'pol', 'czech republic': 'cze', 'czechia': 'cze', 'slovakia': 'svk',
  'hungary': 'hun', 'romania': 'rou', 'bulgaria': 'bul', 'serbia': 'srb',
  'croatia': 'cro', 'lithuania': 'ltu', 'latvia': 'lat', 'estonia': 'est',
  'turkey': 'tur', 'israel': 'isr', 'lebanon': 'lbn', 'iran': 'irn',
  'saudi arabia': 'ksa', 'uae': 'uae', 'united arab emirates': 'uae',
  'kuwait': 'kuw', 'egypt': 'egy', 'morocco': 'mar', 'algeria': 'alg',
  'tunisia': 'tun', 'nigeria': 'ngr', 'ghana': 'gha', 'cameroon': 'cmr',
  'kenya': 'ken', 'ethiopia': 'eth', 'tanzania': 'tan', 'uganda': 'uga',
  'zimbabwe': 'zim', 'south africa': 'rsa', 'canada': 'can', 'australia': 'aus',
  'new zealand': 'nzl', 'cuba': 'cub', 'puerto rico': 'pur',
  'dominican republic': 'dom', 'jamaica': 'jam', 'haiti': 'hai',
  'bahamas': 'bah', 'panama': 'pan', 'costa rica': 'crc', 'nicaragua': 'nca',
  'venezuela': 'ven', 'colombia': 'col', 'ecuador': 'ecu', 'peru': 'per',
  'chile': 'chi', 'argentina': 'arg', 'uruguay': 'uru', 'paraguay': 'par',
  'bolivia': 'bol', 'brazil': 'bra', 'guyana': 'guy',
  'china': 'chn', 'south korea': 'kor', 'korea': 'kor', 'north korea': 'prk',
  'taiwan': 'tpe', 'hong kong': 'hkg', 'thailand': 'tha', 'vietnam': 'vie',
  'indonesia': 'idn', 'malaysia': 'mas', 'singapore': 'sgp', 'india': 'ind',
  'pakistan': 'pak', 'bangladesh': 'ban', 'sri lanka': 'sri', 'nepal': 'nep',
  'mongolia': 'mgl', 'myanmar': 'mya', 'cambodia': 'cam', 'laos': 'lao',
  'papua new guinea': 'png', 'fiji': 'fij', 'samoa': 'sam', 'tonga': 'tga'
};

// longest first so "super bantamweight" never matches as "bantamweight"
const WEIGHT_CLASSES = [
  [/super\s*heavy/i,                                   '超重量级'],
  [/cruiser|junior\s*heavy/i,                          '次重量级'],
  [/light\s*heavy/i,                                   '轻重量级'],
  [/super\s*middle/i,                                  '超中量级'],
  [/junior\s*middle|super\s*welter/i,                  '超次中量级'],
  [/junior\s*welter|super\s*light/i,                   '超轻量级'],
  [/junior\s*light|super\s*feather/i,                  '超羽量级'],
  [/junior\s*feather|super\s*bantam/i,                 '超雏量级'],
  [/junior\s*bantam|super\s*fly/i,                     '超蝇量级'],
  [/junior\s*fly|light\s*fly/i,                        '轻蝇量级'],
  [/mini\s*-?\s*fly|minimum\s*weight|straw\s*weight/i, '草量级'],
  [/heavy\s*weight/i,                                  '重量级'],
  [/middle\s*weight/i,                                 '中量级'],
  [/welter\s*weight/i,                                 '次中量级'],
  [/light\s*weight/i,                                  '轻量级'],
  [/feather\s*weight/i,                                '羽量级'],
  [/bantam\s*weight/i,                                 '雏量级'],
  [/fly\s*weight/i,                                    '蝇量级']
];

const METHODS = [
  [/unanimous\s*decision|\bUD\b/i,            '一致判定'],
  [/split\s*decision|\bSD\b/i,                '分歧判定'],
  [/majority\s*decision|\bMD\b/i,             '多数判定'],
  [/technical\s*decision|\bTD\b/i,            '技术判定'],
  [/majority\s*draw/i,                        '多数平局'],
  [/split\s*draw/i,                           '分歧平局'],
  [/technical\s*draw/i,                       '技术平局'],
  [/\bdraw\b/i,                               '平局'],
  [/no\s*contest|\bNC\b/,                     '无效比赛'],
  [/disqualification|\bDQ\b/i,                '取消资格'],
  [/retirement|\bRTD\b|corner\s*stoppage/i,   '中途弃权'],
  [/\bTKO\b|technical\s*knockout/i,           'TKO'],
  [/\bKO\b|knockout/i,                        'KO'],
  [/decision/i,                               '点数判定']
];

/* Wikitext is not a data format, so everything below is deliberately
   defensive: anything that does not parse is dropped rather than guessed at. */
function wikiPlain(value) {
  if (!value) return '';
  let s = String(value).split('{{efn')[0].split('{{Efn')[0];
  s = s.replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '');
  s = s.replace(/\{\{[^{}]*\}\}/g, ' ');
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
  s = s.replace(/'''''|'''|''/g, '');
  return s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Pull {{Infobox boxing match}} out and split it on its top-level pipes. */
function wikiInfobox(wikitext) {
  const start = wikitext.search(/\{\{\s*Infobox\s+boxing\s*match/i);
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--; i++;
      if (!depth) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  const body = wikitext.slice(start, end);
  const parts = [];
  let buf = '', braces = 0, brackets = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{') { braces++; buf += two; i++; continue; }
    if (two === '}}') { braces--; buf += two; i++; continue; }
    if (two === '[[') { brackets++; buf += two; i++; continue; }
    if (two === ']]') { brackets--; buf += two; i++; continue; }
    if (body[i] === '|' && braces <= 1 && brackets <= 0) { parts.push(buf); buf = ''; continue; }
    buf += body[i];
  }
  parts.push(buf);
  const fields = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    fields[part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ' ')] =
      part.slice(eq + 1).replace(/\}\}\s*$/, '');
  }
  return fields;
}

function wikiDate(raw) {
  const text = wikiPlain(raw);
  let m = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  m = text.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
  }
  return null;
}

/* Accents matter here: the result line writes "Hrgovic" where the infobox
   writes "Hrgović". */
function fold(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function countryFlag(hometown) {
  const plain = wikiPlain(hometown);
  if (!plain) return '';
  const tail = plain.split(',').map(s => s.trim()).filter(Boolean).pop();
  if (!tail) return '';
  const code = COUNTRY_CODE[tail.toLowerCase().replace(/\.$/, '')] ||
               COUNTRY_CODE[tail.toLowerCase()];
  return code ? `https://a.espncdn.com/i/teamlogos/countries/500/${code}.png` : '';
}

/* Records are written freehand — "23–0 (14 KO)", "0–0 (Boxing) 76–9–1
   (Kickboxing)" — so take the leading boxing record and drop the commentary
   rather than cutting the string at a fixed length. */
function boxRecord(raw) {
  const plain = wikiPlain(raw);
  const m = plain.match(/^\d+[–—-]\d+(?:[–—-]\d+)*(?:\s*\(\d+\))?(?:\s*\(\d+\s*KOs?\))?/i);
  if (m) return m[0].trim();
  return plain.length > 28 ? '' : plain;
}

/* Which fighter's name shows up first in the result line is the winner —
   "DeMoor defeated Tate", "Crawford wins via…", "Chisora won by…". */
function boxWinner(result, nameA, nameB) {
  const text = fold(result);
  if (!text) return null;
  if (/\bdraw\b|no contest/.test(text) && !/\bwins?\b|\bwon\b|defeat/.test(text)) return null;
  const surname = n => fold(n).split(/\s+/).filter(w => w.length > 2).pop() || fold(n);
  const at = n => {
    const i = text.indexOf(surname(n));
    return i < 0 ? Infinity : i;
  };
  const ia = at(nameA), ib = at(nameB);
  if (ia === Infinity && ib === Infinity) return null;
  if (ia === ib) return null;
  return ia < ib ? 'a' : 'b';
}

function boxMethod(result) {
  const text = wikiPlain(result);
  if (!text) return '';
  for (const [re, cn] of METHODS) if (re.test(text)) return cn;
  return '';
}

function boxRound(result) {
  const text = wikiPlain(result);
  let m = text.match(/(\d{1,2})(?:st|nd|rd|th)[\s-]*round/i) ||
          text.match(/round\s*(\d{1,2})/i) ||
          text.match(/\bR(\d{1,2})\b/);
  // "12-round unanimous decision" is the distance, not a stoppage round
  if (m && /decision|draw/i.test(text) && !/stopp|ko\b|tko/i.test(text)) return null;
  return m ? Number(m[1]) : null;
}

function boxRounds(result, titles) {
  const m = `${wikiPlain(result)} ${wikiPlain(titles)}`.match(/(\d{1,2})[\s-]*round/i);
  return m ? Number(m[1]) : null;
}

function boxWeight(fields, wikitext) {
  const titles = wikiPlain(fields.titles);
  const lead = wikiPlain(wikitext.slice(0, 3000).split("'''").slice(1).join("'''")).slice(0, 600);
  const belts = [];
  for (const b of ['WBA', 'WBC', 'IBF', 'WBO', 'IBO', 'WBF']) {
    if (new RegExp(`\\b${b}\\b`).test(titles)) belts.push(b);
  }
  if (/The Ring/i.test(titles)) belts.push('The Ring');
  let cn = '';
  for (const [re, name] of WEIGHT_CLASSES) {
    if (re.test(titles)) { cn = name; break; }
  }
  if (!cn) for (const [re, name] of WEIGHT_CLASSES) {
    if (re.test(lead)) { cn = name; break; }
  }
  return [belts.join('·'), cn].filter(Boolean).join(' ') ||
    (/non-?title/i.test(titles) ? '非冠军战' : '');
}

async function wikiCategory(title) {
  const url = `${WIKI_API}?action=query&format=json&formatversion=2&list=categorymembers` +
    `&cmnamespace=0&cmlimit=500&cmtitle=${encodeURIComponent(title)}`;
  const data = await getJSON(url);
  return ((data && data.query && data.query.categorymembers) || []).map(p => p.title);
}

async function wikiSource(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 20) {
    const url = `${WIKI_API}?action=query&format=json&formatversion=2&prop=revisions` +
      `&rvprop=content&rvslots=main&titles=${encodeURIComponent(titles.slice(i, i + 20).join('|'))}`;
    const data = await getJSON(url);
    for (const page of (data && data.query && data.query.pages) || []) {
      const content = page.revisions && page.revisions[0] &&
        page.revisions[0].slots && page.revisions[0].slots.main &&
        page.revisions[0].slots.main.content;
      if (content) out[page.title] = content;
    }
  }
  return out;
}

function boxBout(title, wikitext) {
  if (/^\s*#REDIRECT/i.test(wikitext)) return null;
  const fields = wikiInfobox(wikitext);
  if (!fields) return null;
  const date = wikiDate(fields['fight date']);
  if (!date) return null;
  // a cancelled or postponed bout is not a fixture and not a result
  if (/cancel|postpon|called off/i.test(
    `${wikiPlain(fields['fight date'])} ${wikiPlain(fields.result)}`)) return null;

  const nameA = wikiPlain(fields.fighter1);
  const nameB = wikiPlain(fields.fighter2);
  if (!nameA || !nameB) return null;

  const result = fields.result || '';
  const decided = !!wikiPlain(result);
  return {
    event: title,
    start: `${date}T00:00:00Z`,
    timeKnown: false,
    venue: wikiPlain(fields.location),
    weight: boxWeight(fields, wikitext),
    rounds: boxRounds(result, fields.titles),
    a: { name: nameA, record: boxRecord(fields.record1), flag: countryFlag(fields.hometown1) },
    b: { name: nameB, record: boxRecord(fields.record2), flag: countryFlag(fields.hometown2) },
    winner: decided ? boxWinner(result, nameA, nameB) : null,
    method: decided ? (boxMethod(result) || '完场') : '',
    round: decided ? boxRound(result) : null,
    time: null
  };
}

/* Wikipedia only writes a fight up once it has happened and mattered, so the
   archive has no future bouts at all. The Odds API lists what the books are
   pricing, which is exactly the upcoming card — 500 calls a month on the free
   plan, so this runs a few times a day rather than every tick. */
const ODDS_KEY = process.env.ODDS_API_KEY || '';

async function upcomingBoxing(notes) {
  if (!ODDS_KEY) { notes.push('no ODDS_API_KEY'); return []; }
  const previous = await load('boxing.json');
  const last = previous && previous.oddsAt ? Date.parse(previous.oddsAt) : 0;
  if (!MANUAL && last && Date.now() - last < 5 * 3600e3) {
    notes.push('odds: cached');
    return (previous.upcoming || []).filter(b => new Date(b.start).getTime() > Date.now() - 6 * 3600e3);
  }
  const url = `https://api.the-odds-api.com/v4/sports/boxing_boxing/odds/` +
    `?apiKey=${ODDS_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;
  const rows = await getJSON(url);
  if (!Array.isArray(rows)) { notes.push('odds: unexpected answer'); return []; }

  // the shortest price across books is the cleanest read on who is favoured
  const bestPrice = (row, who) => {
    let best = null;
    for (const bk of row.bookmakers || []) {
      for (const mk of bk.markets || []) {
        for (const oc of mk.outcomes || []) {
          if (oc.name === who && (best === null || oc.price < best)) best = oc.price;
        }
      }
    }
    return best;
  };
  notes.push(`odds: ${rows.length} bouts`);
  return rows.map(row => ({
    event: `${row.home_team} vs ${row.away_team}`,
    start: row.commence_time,
    timeKnown: true,
    venue: '',
    weight: '',
    rounds: null,
    a: { name: row.home_team, record: '', flag: '', odds: bestPrice(row, row.home_team) },
    b: { name: row.away_team, record: '', flag: '', odds: bestPrice(row, row.away_team) },
    winner: null, method: '', round: null, time: null,
    source: 'odds'
  })).sort((x, y) => new Date(x.start) - new Date(y.start));
}

async function collectBoxing() {
  // Wikipedia is a courtesy source: an hourly touch on the scheduled cadence.
  const previous = await load('boxing.json');
  if (!MANUAL && previous &&
      Date.now() - new Date(previous.updatedAt).getTime() < 55 * 60e3) {
    return {
      skipped: 'throttled',
      upcoming: (previous.upcoming || []).length,
      recent: (previous.recent || []).length
    };
  }

  // Wikipedia only writes up the fights that were notable enough to have an
  // article, so a single year is a couple of dozen bouts and barely covers a
  // division. Reaching back four years is what makes the weight classes and
  // the boxer list look like a sport rather than a handful of names.
  const year = new Date().getUTCFullYear();
  const titles = [];
  const notes = [];
  for (const y of [year - 4, year - 3, year - 2, year - 1, year, year + 1]) {
    try {
      const found = await wikiCategory(`Category:${y} boxing matches`);
      notes.push(`${y}: ${found.length}`);
      for (const t of found) if (!titles.includes(t)) titles.push(t);
    } catch (err) {
      notes.push(`${y}: ${String(err.message || err).slice(0, 60)}`);
    }
  }
  if (!titles.length) throw new Error('no articles in the boxing categories');

  const sources = await wikiSource(titles);
  const bouts = [];
  for (const [title, wikitext] of Object.entries(sources)) {
    const bout = boxBout(title, wikitext);
    if (bout) bouts.push(bout);
  }

  // a fight is "past" once the day it was on has ended, in the latest timezone
  const cutoff = Date.now() - 36 * 3600e3;
  const fromWiki = bouts
    .filter(b => new Date(b.start).getTime() >= cutoff && !b.winner && !b.method)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const recent = bouts
    .filter(b => fromWiki.indexOf(b) === -1)
    .sort((a, b) => new Date(b.start) - new Date(a.start))
    .slice(0, 120);

  // the books know about fights Wikipedia has not written up yet; where both
  // have it, keep Wikipedia's, which carries the venue and the titles
  const priced = await upcomingBoxing(notes);
  const known = new Set(fromWiki.map(b => fightKey(b.a.name, b.b.name)));
  const upcoming = fromWiki
    .concat(priced.filter(b => !known.has(fightKey(b.a.name, b.b.name))))
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 60);

  await save('boxing.json', {
    updatedAt: new Date().toISOString(),
    oddsAt: priced.length ? new Date().toISOString() : (await load('boxing.json') || {}).oddsAt,
    source: 'Wikipedia + The Odds API', upcoming, recent
  });
  return {
    source: 'Wikipedia', articles: titles.length, parsed: bouts.length,
    upcoming: upcoming.length, priced: priced.length, recent: recent.length, tried: notes
  };
}

/* Portraits for the boxer picker, so it can look like the UFC one rather than
   a list of names. A boxer's article title is their name, and pageimages hands
   back the infobox photo. Cached for a month: these faces do not change. */
async function collectBoxers() {
  const card = await load('boxing.json');
  if (!card) return { skipped: 'no boxing.json yet' };

  const names = [];
  [].concat(card.upcoming || [], card.recent || []).forEach(b => {
    for (const side of [b.a, b.b]) {
      const n = side && side.name;
      if (n && !names.includes(n)) names.push(n);
    }
  });
  if (!names.length) return { boxers: 0 };

  const cache = (await load('boxers.json')) || { updatedAt: 0, faces: {} };
  const stale = Date.now() - new Date(cache.updatedAt || 0).getTime() > 30 * 24 * 3600e3;
  const missing = names.filter(n => stale || !(n in cache.faces));

  for (let i = 0; i < missing.length; i += 40) {
    const batch = missing.slice(i, i + 40);
    const url = `${WIKI_API}?action=query&format=json&formatversion=2&prop=pageimages` +
      `&piprop=thumbnail&pithumbsize=320&titles=${encodeURIComponent(batch.join('|'))}`;
    try {
      const data = await getJSON(url);
      const pages = (data && data.query && data.query.pages) || [];
      // an article can answer under a redirected title, so match on both
      const byTitle = {};
      for (const p of pages) byTitle[p.title] = (p.thumbnail || {}).source || '';
      for (const n of batch) cache.faces[n] = byTitle[n] || '';
    } catch {
      for (const n of batch) if (!(n in cache.faces)) cache.faces[n] = '';
    }
  }
  cache.updatedAt = new Date().toISOString();
  await save('boxers.json', cache);
  const withFace = names.filter(n => cache.faces[n]).length;
  return { boxers: names.length, withFace, lookedUp: missing.length };
}

/* Keep the repo from growing without bound. */
async function prune(dir, keep = 400) {
  try {
    const path = join(DATA, dir);
    const names = await readdir(path);
    if (names.length <= keep) return 0;
    const withTime = await Promise.all(names.map(async n => ({
      n, t: (await stat(join(path, n))).mtimeMs
    })));
    withTime.sort((a, b) => a.t - b.t);
    const doomed = withTime.slice(0, withTime.length - keep);
    for (const f of doomed) await unlink(join(path, f.n));
    return doomed.length;
  } catch { return 0; }
}

const tasks = [
  ['lol', collectLol],
  ['cba', collectCba],
  ['cs2', collectCs2],
  ['valorant', collectValorant],
  ['ufc', collectUfcRankings],
  ['ufcFights', collectUfcFights],
  ['boxing', collectBoxing],
  ['boxers', collectBoxers]
];

for (const [name, run] of tasks) {
  try {
    status.sources[name] = { ok: true, ...(await run()) };
  } catch (err) {
    status.sources[name] = { ok: false, error: String(err.message || err).slice(0, 300) };
  }
}
status.pruned = await prune('lol');
await save('status.json', status);
console.log(JSON.stringify(status, null, 2));
