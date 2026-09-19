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

const PANDA = process.env.PANDASCORE_TOKEN || '';
const APISPORTS = process.env.APISPORTS_KEY || '';

function pandaMatch(m) {
  const sides = (m.opponents || []).map(o => o.opponent || {});
  const scores = (m.results || []);
  const scoreFor = id => {
    const hit = scores.find(r => r.team_id === id);
    return hit ? hit.score : null;
  };
  return {
    id: m.id,
    start: m.scheduled_at || m.begin_at || null,
    status: m.status || '',
    bo: m.number_of_games || null,
    league: [m.league?.name, m.serie?.full_name].filter(Boolean).join(' · '),
    teams: sides.map(t => ({
      name: t.name || '',
      acronym: t.acronym || '',
      image: t.image_url || '',
      score: scoreFor(t.id)
    }))
  };
}

async function collectPanda(game, file) {
  if (!PANDA) throw new Error('missing PANDASCORE_TOKEN secret');
  const headers = { authorization: `Bearer ${PANDA}` };
  const base = `https://api.pandascore.co/${game}/matches`;
  const [upcoming, past] = await Promise.all([
    getJSON(`${base}/upcoming?per_page=30&sort=scheduled_at`, headers),
    getJSON(`${base}/past?per_page=30&sort=-scheduled_at`, headers)
  ]);
  const value = {
    upcoming: (upcoming || []).map(pandaMatch),
    recent: (past || []).map(pandaMatch)
  };
  await save(file, { updatedAt: new Date().toISOString(), source: 'pandascore', ...value });
  return { source: 'pandascore', upcoming: value.upcoming.length, recent: value.recent.length };
}

const collectCs2 = () => collectPanda('csgo', 'cs2.json');
const collectValorant = () => collectPanda('valorant', 'valorant.json');

/* API-Sports gives 100 requests a day on the free plan, so the CBA is polled
   once an hour rather than on every five-minute tick. */
async function collectCba() {
  if (!APISPORTS) throw new Error('missing APISPORTS_KEY secret');
  const now = new Date();
  const previous = await load('cba.json');
  // The hourly throttle exists to protect a 100-a-day quota, but it must not
  // pin a bad answer in place: a stored season from a bygone year is re-fetched
  // straight away, while a current season that simply has no fixtures yet waits.
  const era = [now.getFullYear(), now.getFullYear() - 1].map(String);
  const seasonLooksCurrent = era.some(y => String(previous?.season || '').includes(y));
  const recentlyPolled = previous?.updatedAt &&
    (now - new Date(previous.updatedAt)) < 55 * 60 * 1000;
  if (recentlyPolled && seasonLooksCurrent) {
    return { source: previous.source, season: previous.season, skipped: 'polled within the hour' };
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

  let games = await getJSON(`${base}games?league=${leagueId}&season=${encodeURIComponent(season)}`, headers);
  if (!(games?.response || []).length && /^\d{4}-\d{4}$/.test(season)) {
    // a season that has not started yet returns nothing — show the previous one
    const [a, b] = season.split('-').map(Number);
    const older = `${a - 1}-${b - 1}`;
    const retry = await getJSON(`${base}games?league=${leagueId}&season=${older}`, headers);
    if ((retry?.response || []).length) { games = retry; season = older; }
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
    upcoming: value.upcoming.length, recent: value.recent.length
  };
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
  ['valorant', collectValorant]
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
