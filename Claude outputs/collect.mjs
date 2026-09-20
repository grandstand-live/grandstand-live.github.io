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

/* --- mirrors for the feeds a browser cannot reach --- */

async function firstThatWorks(candidates) {
  const errors = [];
  for (const [label, run] of candidates) {
    try {
      const value = await run();
      if (value) return { source: label, value };
    } catch (err) { errors.push(`${label}: ${err.message}`); }
  }
  throw new Error(errors.join(' | ') || 'no source answered');
}

async function collectCba() {
  const { source, value } = await firstThatWorks([
    ['sofascore', async () => {
      const search = await getJSON(
        'https://api.sofascore.com/api/v1/search/unique-tournaments?q=CBA'
      );
      const hit = (search?.results || [])
        .map(r => r.entity)
        .find(e => e && /CBA|Chinese Basketball/i.test(e.name || ''));
      if (!hit) return null;
      const season = await getJSON(
        `https://api.sofascore.com/api/v1/unique-tournament/${hit.id}/seasons`
      );
      const current = season?.seasons?.[0];
      if (!current) return null;
      const [next, last] = await Promise.all([
        getJSON(`https://api.sofascore.com/api/v1/unique-tournament/${hit.id}/season/${current.id}/events/next/0`)
          .catch(() => null),
        getJSON(`https://api.sofascore.com/api/v1/unique-tournament/${hit.id}/season/${current.id}/events/last/0`)
          .catch(() => null)
      ]);
      const shape = e => ({
        id: e.id,
        start: e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString() : null,
        status: e.status?.type || '',
        home: { name: e.homeTeam?.name, id: e.homeTeam?.id, score: e.homeScore?.current ?? null },
        away: { name: e.awayTeam?.name, id: e.awayTeam?.id, score: e.awayScore?.current ?? null }
      });
      return {
        tournamentId: hit.id,
        seasonId: current.id,
        upcoming: (next?.events || []).slice(0, 30).map(shape),
        recent: (last?.events || []).slice(-30).map(shape).reverse()
      };
    }]
  ]);
  await save('cba.json', { updatedAt: new Date().toISOString(), source, ...value });
  return { source, upcoming: value.upcoming?.length || 0, recent: value.recent?.length || 0 };
}

async function collectCs2() {
  const { source, value } = await firstThatWorks([
    ['hltv-api', async () => {
      const [matches, results] = await Promise.all([
        getJSON('https://hltv-api.vercel.app/api/matches.json').catch(() => null),
        getJSON('https://hltv-api.vercel.app/api/results.json').catch(() => null)
      ]);
      if (!matches && !results) return null;
      return { upcoming: (matches || []).slice(0, 30), recent: (results || []).slice(0, 30) };
    }]
  ]);
  await save('cs2.json', { updatedAt: new Date().toISOString(), source, ...value });
  return { source, upcoming: value.upcoming?.length || 0, recent: value.recent?.length || 0 };
}

async function collectValorant() {
  const { source, value } = await firstThatWorks([
    ['vlr-orlandomm', async () => {
      const [up, res] = await Promise.all([
        getJSON('https://vlr.orlandomm.net/api/v1/matches').catch(() => null),
        getJSON('https://vlr.orlandomm.net/api/v1/results').catch(() => null)
      ]);
      if (!up && !res) return null;
      return { upcoming: (up?.data || []).slice(0, 30), recent: (res?.data || []).slice(0, 30) };
    }],
    ['vlrggapi', async () => {
      const [up, res] = await Promise.all([
        getJSON('https://vlrggapi.vercel.app/match?q=upcoming').catch(() => null),
        getJSON('https://vlrggapi.vercel.app/match?q=results').catch(() => null)
      ]);
      if (!up && !res) return null;
      return {
        upcoming: (up?.data?.segments || []).slice(0, 30),
        recent: (res?.data?.segments || []).slice(0, 30)
      };
    }]
  ]);
  await save('valorant.json', { updatedAt: new Date().toISOString(), source, ...value });
  return { source, upcoming: value.upcoming?.length || 0, recent: value.recent?.length || 0 };
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
