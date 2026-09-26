import { config, siteByHost } from './config.js';
import { query, one } from './db.js';
import { ipHash, isBot, device, browser, cleanPath } from './privacy.js';

// ---------- Railway request logs ----------
// Every run asks Railway for all sites at once (GraphQL aliases), so a run costs
// two API calls: one for recent deployments, one for their logs since our cursor.
const RAILWAY = 'https://backboard.railway.com/graphql/v2';
const FIRST_RUN_HOURS = 6;
const PAGE = 1000;

export async function railwayGql(queryText, variables = {}) {
  const response = await fetch(RAILWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.railwayToken}` },
    body: JSON.stringify({ query: queryText, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(`Railway: ${body.errors?.[0]?.message || `HTTP ${response.status}`}`);
  return body.data;
}

export async function ingestRailway({ gql = railwayGql } = {}) {
  const targets = config.sites.filter(s => s.railway?.serviceId);
  if (!config.railwayToken || !targets.length) return { skipped: true };
  const cursors = new Map((await query('SELECT service_id, last_at FROM ingest_cursors')).rows.map(r => [r.service_id, r.last_at]));
  const since = site => cursors.get(site.railway.serviceId) || new Date(Date.now() - FIRST_RUN_HOURS * 3600_000);

  const deployQuery = targets.map((s, i) => `d${i}: deployments(first: 3, input: { projectId: "${s.railway.projectId}", environmentId: "${s.railway.environmentId}", serviceId: "${s.railway.serviceId}" }) { edges { node { id status updatedAt } } }`).join('\n');
  const deployments = await gql(`query { ${deployQuery} }`);

  // Deployments that could have served traffic since the cursor.
  const wanted = [];
  targets.forEach((site, i) => {
    for (const { node } of deployments[`d${i}`]?.edges || []) {
      if (node.status === 'REMOVED' && new Date(node.updatedAt) < since(site)) continue;
      if (['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'FAILED', 'SKIPPED'].includes(node.status)) continue;
      wanted.push({ site, deploymentId: node.id, after: since(site) });
    }
  });
  const totals = {};
  let pending = wanted;
  for (let round = 0; round < 5 && pending.length; round++) {
    const logQuery = pending.map((w, i) => `l${i}: httpLogs(deploymentId: "${w.deploymentId}", afterDate: "${new Date(w.after).toISOString()}", afterLimit: ${PAGE}) { requestId timestamp host method path httpStatus totalDuration txBytes edgeRegion srcIp clientUa }`).join('\n');
    const logs = await gql(`query { ${logQuery} }`);
    const next = [];
    for (const [i, w] of pending.entries()) {
      const lines = logs[`l${i}`] || [];
      totals[w.site.id] = (totals[w.site.id] || 0) + await store(w.site, lines);
      const newest = lines.reduce((max, l) => (l.timestamp > max ? l.timestamp : max), '');
      if (newest) w.newest = newest;
      if (lines.length >= PAGE && newest) next.push({ ...w, after: newest });
    }
    pending = next;
  }
  // Move each service's cursor to the newest request we saw (a little overlap is fine: request ids dedupe).
  for (const site of targets) {
    const newest = wanted.filter(w => w.site === site && w.newest).map(w => w.newest).sort().at(-1);
    await query(`INSERT INTO ingest_cursors (service_id, site, last_at, last_run_at, last_error) VALUES ($1, $2, $3, now(), NULL)
      ON CONFLICT (service_id) DO UPDATE SET last_at = COALESCE(EXCLUDED.last_at, ingest_cursors.last_at), last_run_at = now(), last_error = NULL`,
      [site.railway.serviceId, site.id, newest || null]);
  }
  return { totals };
}

async function store(site, lines) {
  let inserted = 0;
  for (const l of lines) {
    if (!l.requestId || !l.timestamp) continue;
    const ua = l.clientUa || '';
    const owner = siteByHost(l.host) || site;
    const result = await query(`INSERT INTO requests (request_id, site, at, host, method, path, status, duration_ms, bytes_out, region, bot, device, browser, ip_hash, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (request_id) DO NOTHING`,
      [l.requestId, owner.id, l.timestamp, String(l.host || '').slice(0, 253), String(l.method || '').slice(0, 10), cleanPath(l.path), l.httpStatus ?? 0,
        l.totalDuration ?? null, l.txBytes ?? null, l.edgeRegion || null, isBot(ua), device(ua), browser(ua), await ipHash(l.srcIp, owner.id, l.timestamp), ua.slice(0, 400) || null]);
    inserted += result.rowCount;
  }
  return inserted;
}

// ---------- uptime ----------
export async function checkUptime({ fetcher = fetch } = {}) {
  await Promise.all(config.sites.filter(s => s.url).map(async site => {
    const started = Date.now();
    let ok = false, status = null, error = null;
    try {
      const response = await fetcher(site.url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'DeltaVDevs-Uptime/1.0 (+https://analytics.deltavdevs.com)' }, signal: AbortSignal.timeout(10_000) });
      status = response.status;
      ok = status < 400;
      response.body?.cancel?.().catch(() => {});
    } catch (err) {
      error = String(err.name === 'TimeoutError' ? 'timed out after 10s' : err.cause?.code || err.message).slice(0, 200);
    }
    await query('INSERT INTO uptime_checks (site, ok, status, latency_ms, error) VALUES ($1, $2, $3, $4, $5)', [site.id, ok, status, Date.now() - started, error]);
  }));
}

// ---------- retention ----------
// After 13 months nothing can identify a person: ids, IP hashes and user agents
// go, counts stay. Day salts older than yesterday are deleted, which is what
// makes old ip_hash values unlinkable from the moment the day is over.
export async function applyRetention() {
  const cutoff = `now() - interval '${config.retentionMonths} months'`;
  const done = {};
  const run = async (name, sql) => { done[name] = (await query(sql)).rowCount; };
  await run('pageviews', `UPDATE pageviews SET visitor_id = NULL, session_id = NULL, ip_hash = NULL WHERE at < ${cutoff} AND (visitor_id IS NOT NULL OR session_id IS NOT NULL OR ip_hash IS NOT NULL)`);
  await run('requests', `UPDATE requests SET ip_hash = NULL, user_agent = NULL WHERE at < ${cutoff} AND (ip_hash IS NOT NULL OR user_agent IS NOT NULL)`);
  await run('outbound', `UPDATE outbound SET visitor_id = NULL, ip_hash = NULL WHERE at < ${cutoff} AND (visitor_id IS NOT NULL OR ip_hash IS NOT NULL)`);
  await run('link_clicks', `UPDATE link_clicks SET ip_hash = NULL WHERE at < ${cutoff} AND ip_hash IS NOT NULL`);
  await run('consents', `UPDATE consents SET consent_id = NULL WHERE at < ${cutoff} AND consent_id IS NOT NULL`);
  await run('salts', 'DELETE FROM salts WHERE day < current_date - 1');
  await run('sessions', 'DELETE FROM sessions WHERE expires_at < now()');
  return done;
}

// ---------- scheduler ----------
function every(ms, name, job, log) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await job(); } catch (err) {
      log.warn({ err: err.message, job: name }, `${name} failed`);
      if (name === 'railway') await query('UPDATE ingest_cursors SET last_error = $1, last_run_at = now()', [err.message.slice(0, 300)]).catch(() => {});
    } finally { running = false; }
  };
  setTimeout(tick, 5_000).unref();
  return setInterval(tick, ms);
}

export function startJobs(log) {
  const timers = [
    every(60_000, 'uptime', () => checkUptime(), log),
    every(5 * 60_000, 'railway', () => ingestRailway(), log),
    every(60 * 60_000, 'retention', () => applyRetention(), log),
  ];
  return () => timers.forEach(clearInterval);
}

export async function lastIngest() {
  return one('SELECT max(last_run_at) AS last_run_at, max(last_error) AS last_error FROM ingest_cursors');
}
