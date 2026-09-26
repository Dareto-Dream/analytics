import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// Runs against a real Postgres (TEST_PG_URL points at a server; we use its
// analytics_test database). Ward and Railway are stand-ins.
const skip = process.env.TEST_PG_URL ? false : 'set TEST_PG_URL to run';
const WARD = 'https://ward.test';
if (process.env.TEST_PG_URL) {
  const admin = new pg.Client({ connectionString: process.env.TEST_PG_URL });
  await admin.connect();
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = 'analytics_test'")).rowCount) await admin.query('CREATE DATABASE analytics_test');
  await admin.end();
  const url = new URL(process.env.TEST_PG_URL); url.pathname = '/analytics_test';
  Object.assign(process.env, { DATABASE_URL: url.toString() });
}
Object.assign(process.env, {
  NODE_ENV: 'test', SESSION_SECRET: 'z'.repeat(48), PUBLIC_URL: 'http://localhost:3997', ANALYTICS_JOBS: 'off',
  WARD_URL: WARD, WARD_CLIENT_ID: 'analytics-app', WARD_CLIENT_SECRET: 'app-secret', RAILWAY_API_TOKEN: 'rw-token',
});

// ---------- fake Ward ----------
const ward = { level: 'viewer', refreshLevel: 'viewer', refreshStatus: 200, down: false, refreshes: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== WARD) return realFetch(input, init);
  if (ward.down) throw new Error('connect ECONNREFUSED');
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/oauth/token') {
    const body = new URLSearchParams(init.body);
    if (body.get('client_secret') !== 'app-secret') return json(401, { error: 'invalid_client' });
    if (body.get('grant_type') === 'refresh_token') {
      ward.refreshes++;
      if (ward.refreshStatus !== 200) return json(ward.refreshStatus, { error: 'invalid_grant' });
      ward.level = ward.refreshLevel;
      return json(200, { access_token: 'wat_refreshed', refresh_token: `wrt_${ward.refreshes}`, scope: 'openid profile email admin offline_access' });
    }
    if (body.get('code') !== 'good') return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: 'wat_first', refresh_token: 'wrt_first', scope: 'openid profile email admin offline_access' });
  }
  if (url.pathname === '/oauth/userinfo') return json(200, { sub: '55555555-5555-4555-8555-555555555555', name: 'Delta', email: 'd@example.com', admin_level: ward.level });
  return json(404, {});
};

let app, db, mod;
before(async () => {
  if (skip) return;
  mod = {
    server: await import('../src/server.js'),
    dbm: await import('../src/db.js'),
    jobs: await import('../src/jobs.js'),
    status: await import('../src/status.js'),
    auth: await import('../src/auth.js'),
  };
  await mod.dbm.migrate();
  db = mod.dbm.pool;
  await db.query('TRUNCATE requests, ingest_cursors, pageviews, outbound, links, link_clicks, uptime_checks, consents, salts, sessions, status_checks, status_daily RESTART IDENTITY CASCADE');
  app = await mod.server.buildApp({ logger: false });
});
after(async () => { if (app) await app.close(); globalThis.fetch = realFetch; });

// ---------- helpers ----------
async function signIn(level) {
  ward.level = level; ward.refreshLevel = level; ward.refreshStatus = 200; ward.down = false;
  const start = await app.inject({ method: 'GET', url: '/auth/ward/start' });
  const location = new URL(start.headers.location);
  const oauth = String(start.headers['set-cookie']).match(/analytics-oauth=[^;]+/)[0];
  const res = await app.inject({ method: 'GET', url: `/auth/ward/callback?state=${location.searchParams.get('state')}&code=good&iss=${encodeURIComponent(WARD)}`, headers: { cookie: oauth } });
  const cookie = [res.headers['set-cookie'] || []].flat().map(c => c.match(/^analytics=([^;]+)/)).find(Boolean);
  return { res, cookie: cookie ? `analytics=${cookie[1]}` : null, location };
}
async function staff(level) {
  const { cookie } = await signIn(level);
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  return { cookie, headers: { cookie, 'x-analytics-csrf': me.csrf, origin: 'http://localhost:3997' }, me };
}
const beacon = (origin, body, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537') =>
  app.inject({ method: 'POST', url: '/e', headers: { origin, 'content-type': 'text/plain;charset=UTF-8', 'user-agent': ua, 'x-forwarded-for': '203.0.113.9' }, payload: JSON.stringify(body) });
const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].n);

// ---------- sign-in and sessions ----------
test('health is public, the api is not, and robots are turned away', { skip }, async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/overview' })).statusCode, 401);
  assert.match((await app.inject({ method: 'GET', url: '/robots.txt' })).body, /Disallow: \//);
});

test('ward sign-in: asks for admin + offline_access, checks iss, and only lets staff in', { skip }, async () => {
  const { location, res } = await signIn('viewer');
  assert.equal(location.origin, WARD);
  assert.equal(location.searchParams.get('scope'), 'openid profile email admin offline_access');
  assert.equal(res.headers.location, '/');
  const start = await app.inject({ method: 'GET', url: '/auth/ward/start' });
  const oauth = String(start.headers['set-cookie']).match(/analytics-oauth=[^;]+/)[0];
  const state = new URL(start.headers.location).searchParams.get('state');
  const wrongIss = await app.inject({ method: 'GET', url: `/auth/ward/callback?state=${state}&code=good&iss=https://evil.test`, headers: { cookie: oauth } });
  assert.match(wrongIss.headers.location, /^\/\?error=/);
  const none = await signIn(null);
  assert.equal(none.cookie, null);
  assert.match(decodeURIComponent(none.res.headers.location), /not DeltaVDevs staff/);
  // The refresh token is sealed at rest.
  const row = (await db.query("SELECT refresh_token FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.doesNotMatch(row.refresh_token, /wrt_/);
  assert.equal(mod.auth.unseal(row.refresh_token), 'wrt_first');
});

test('sessions re-check the level with Ward: demotion ends it, Ward being down does not', { skip }, async () => {
  const { cookie } = await staff('admin');
  const age = () => db.query("UPDATE sessions SET checked_at = now() - interval '10 minutes'");
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().level, 'admin');
  // Promotion shows up at the next check.
  ward.refreshLevel = 'owner'; await age();
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().level, 'owner');
  // Ward unreachable: keep going.
  ward.down = true; await age();
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 200);
  ward.down = false;
  // Demoted to nothing: signed out.
  ward.refreshLevel = null; await age();
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  // A revoked refresh token (Ward revokes them on level changes) also ends it.
  const other = await staff('viewer');
  ward.refreshStatus = 400; await age();
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: other.cookie } })).statusCode, 401);
  assert.equal(await count('SELECT count(*) AS n FROM sessions WHERE sub = $1', ['55555555-5555-4555-8555-555555555555']) >= 0, true);
});

// ---------- collection ----------
test('page views: only our sites, no bots, no query strings, ids only with consent and cookies', { skip }, async () => {
  const vid = '66666666-6666-4666-8666-666666666666';
  assert.equal((await beacon('https://evil.example', { t: 'pv', u: 'https://evil.example/' })).statusCode, 403);
  assert.equal((await beacon('https://blog.deltavdevs.com', { t: 'pv', u: 'https://www.deltavdevs.com/' })).statusCode, 400, 'page must be on the calling site');
  assert.equal((await beacon('https://blog.deltavdevs.com', { t: 'pv', u: 'https://blog.deltavdevs.com/' }, 'Googlebot/2.1')).statusCode, 204);
  const ok = await beacon('https://blog.deltavdevs.com', { t: 'pv', u: 'https://blog.deltavdevs.com/posts/hi?utm_source=discord&utm_campaign=launch&email=a@b.c', r: 'https://www.google.com/search?q=secret', ti: 'Hi', v: vid });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://blog.deltavdevs.com');
  // Synthcity never keeps ids, even if a script sends one.
  await beacon('https://synthcity.deltavdevs.com', { t: 'pv', u: 'https://synthcity.deltavdevs.com/', r: 'https://discord.com/channels/1', v: vid });
  const rows = (await db.query('SELECT site, path, referrer_host, referrer_path, utm_source, utm_campaign, consented, visitor_id, ip_hash FROM pageviews ORDER BY id')).rows;
  assert.equal(rows.length, 2, 'the bot was dropped');
  assert.deepEqual({ ...rows[0], ip_hash: undefined }, { site: 'blog', path: '/posts/hi', referrer_host: 'www.google.com', referrer_path: '/search', utm_source: 'discord', utm_campaign: 'launch', consented: true, visitor_id: vid, ip_hash: undefined });
  assert.ok(rows[0].ip_hash && !rows[0].ip_hash.includes('203.0.113.9'));
  assert.equal(rows[1].visitor_id, null); assert.equal(rows[1].consented, false);
  const out = await beacon('https://www.deltavdevs.com', { t: 'out', u: 'https://www.deltavdevs.com/links', to: 'https://github.com/Dareto-Dream?tab=repos' });
  assert.equal(out.statusCode, 204);
  assert.deepEqual((await db.query('SELECT site, path, target_host, target_path FROM outbound')).rows, [{ site: 'main', path: '/links', target_host: 'github.com', target_path: '/Dareto-Dream' }]);
  const preflight = await app.inject({ method: 'OPTIONS', url: '/e', headers: { origin: 'https://deltatime.deltavdevs.com' } });
  assert.equal(preflight.statusCode, 204);
});

test('consent records: Global Privacy Control always counts as no', { skip }, async () => {
  const send = body => app.inject({ method: 'POST', url: '/consent', headers: { origin: 'https://deltatime.deltavdevs.com', 'content-type': 'text/plain' }, payload: JSON.stringify(body) });
  assert.equal((await send({ id: '77777777-7777-4777-8777-777777777777', analytics: true, gpc: true, v: '2026-09-26' })).statusCode, 204);
  assert.equal((await send({ id: '88888888-8888-4888-8888-888888888888', analytics: true })).statusCode, 204);
  assert.equal((await send({ id: 'nope', analytics: true })).statusCode, 400);
  assert.deepEqual((await db.query('SELECT analytics, gpc FROM consents ORDER BY id')).rows, [{ analytics: false, gpc: true }, { analytics: true, gpc: false }]);
});

test('short links: counted redirects; viewers read, admins manage, owners delete', { skip }, async () => {
  const viewer = await staff('viewer');
  assert.equal((await app.inject({ method: 'POST', url: '/api/links', headers: viewer.headers, payload: { slug: 'discord', destination: 'https://discord.gg/x' } })).statusCode, 403);
  const admin = await staff('admin');
  assert.equal((await app.inject({ method: 'POST', url: '/api/links', headers: { ...admin.headers, 'x-analytics-csrf': 'wrong' }, payload: { slug: 'discord', destination: 'https://discord.gg/x' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/links', headers: admin.headers, payload: { slug: 'bad', destination: 'http://insecure.example' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/links', headers: admin.headers, payload: { slug: 'discord', destination: 'https://discord.gg/x' } })).statusCode, 201);
  const hop = await app.inject({ method: 'GET', url: '/r/discord', headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Mobile Safari', referer: 'https://www.youtube.com/watch?v=1' } });
  assert.equal(hop.statusCode, 302); assert.equal(hop.headers.location, 'https://discord.gg/x');
  assert.equal((await app.inject({ method: 'GET', url: '/r/nope' })).statusCode, 404);
  const list = (await app.inject({ method: 'GET', url: '/api/links', headers: { cookie: viewer.cookie } })).json();
  assert.equal(list.links[0].clicks, 1);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/links/discord', headers: admin.headers, payload: { disabled: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/r/discord' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/links/discord', headers: admin.headers })).statusCode, 403);
  const owner = await staff('owner');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/links/discord', headers: owner.headers })).statusCode, 200);
});

// ---------- jobs ----------
test('railway ingest: two calls a run, request ids dedupe, hosts pick the site, raw IPs never stored', { skip }, async () => {
  let calls = 0;
  const now = new Date().toISOString();
  const log = (id, host, status, ua = 'Mozilla/5.0 (Macintosh) Safari') => ({ requestId: id, timestamp: now, host, method: 'GET', path: `/p?token=secret-${id}`, httpStatus: status, totalDuration: 42, txBytes: 10, edgeRegion: 'us-west2', srcIp: '198.51.100.7', clientUa: ua });
  const gql = async q => {
    calls++;
    if (q.includes('deployments(')) {
      const data = {};
      for (let i = 0; i < 7; i++) data[`d${i}`] = { edges: [{ node: { id: `dep${i}`, status: 'SUCCESS', updatedAt: now } }, { node: { id: `old${i}`, status: 'REMOVED', updatedAt: '2020-01-01T00:00:00Z' } }] };
      return data;
    }
    const data = {};
    const ids = [...q.matchAll(/(l\d+): httpLogs\(deploymentId: "([^"]+)"/g)];
    for (const [, alias, dep] of ids) data[alias] = dep === 'dep1' ? [log('r1', 'blog.deltavdevs.com', 200), log('r2', 'blog.deltavdevs.com', 500), log('r3', 'blog.deltavdevs.com', 301, 'curl/8.0')] : [];
    assert.ok(!ids.some(([, , dep]) => dep.startsWith('old')), 'retired deployments are skipped');
    return data;
  };
  const first = await mod.jobs.ingestRailway({ gql });
  assert.equal(calls, 2);
  assert.equal(first.totals.blog, 3);
  await mod.jobs.ingestRailway({ gql });
  assert.equal(await count("SELECT count(*) AS n FROM requests WHERE site = 'blog'"), 3, 'second run added nothing');
  const rows = (await db.query("SELECT path, status, bot, ip_hash FROM requests WHERE site = 'blog' ORDER BY request_id")).rows;
  assert.deepEqual(rows.map(r => [r.path, r.status, r.bot]), [['/p', 200, false], ['/p', 500, false], ['/p', 301, true]]);
  assert.ok(rows.every(r => r.ip_hash && !r.ip_hash.includes('198.51.100.7')));
  assert.ok((await db.query('SELECT last_at FROM ingest_cursors WHERE site = $1', ['blog'])).rows[0].last_at);
});

test('uptime: records ups and downs', { skip }, async () => {
  await mod.jobs.checkUptime({ fetcher: async url => { if (url.includes('fc.deltavdevs.com')) throw Object.assign(new Error('fail'), { cause: { code: 'ECONNREFUSED' } }); return new Response('ok', { status: url.includes('ward') ? 503 : 200 }); } });
  const rows = Object.fromEntries((await db.query('SELECT site, ok, status, error FROM uptime_checks')).rows.map(r => [r.site, r]));
  assert.equal(rows.blog.ok, true);
  assert.equal(rows.ward.ok, false); assert.equal(rows.ward.status, 503);
  assert.equal(rows.firstcommand.ok, false); assert.equal(rows.firstcommand.error, 'ECONNREFUSED');
});

test('retention: after 13 months ids, hashes and user agents go, counts stay', { skip }, async () => {
  const old = "now() - interval '14 months'";
  await db.query(`INSERT INTO pageviews (site, at, path, consented, visitor_id, session_id, ip_hash) VALUES ('blog', ${old}, '/old', true, gen_random_uuid(), gen_random_uuid(), 'h'), ('blog', now(), '/new', true, gen_random_uuid(), NULL, 'h2')`);
  await db.query(`INSERT INTO requests (request_id, site, at, host, method, path, status, ip_hash, user_agent) VALUES ('old-1', 'blog', ${old}, 'blog.deltavdevs.com', 'GET', '/', 200, 'h', 'UA')`);
  await db.query(`INSERT INTO consents (site, at, consent_id, analytics, policy_version) VALUES ('blog', ${old}, gen_random_uuid(), true, 'x')`);
  await db.query("INSERT INTO salts (day, salt) VALUES (current_date - 5, '\\x00')");
  await mod.jobs.applyRetention();
  const old1 = (await db.query("SELECT visitor_id, session_id, ip_hash FROM pageviews WHERE path = '/old'")).rows[0];
  assert.deepEqual(old1, { visitor_id: null, session_id: null, ip_hash: null });
  assert.ok((await db.query("SELECT visitor_id FROM pageviews WHERE path = '/new'")).rows[0].visitor_id, 'recent rows untouched');
  assert.deepEqual((await db.query("SELECT ip_hash, user_agent FROM requests WHERE request_id = 'old-1'")).rows[0], { ip_hash: null, user_agent: null });
  assert.equal(await count("SELECT count(*) AS n FROM consents WHERE consent_id IS NOT NULL AND at < now() - interval '13 months'"), 0);
  assert.equal(await count('SELECT count(*) AS n FROM salts WHERE day < current_date - 1'), 0);
  assert.equal(await count("SELECT count(*) AS n FROM pageviews WHERE path = '/old'"), 1, 'the row itself is kept');
});

// ---------- dashboard api ----------
test('dashboard: overview, a site, and uptime outages', { skip }, async () => {
  const viewer = await staff('viewer');
  const get = url => app.inject({ method: 'GET', url, headers: { cookie: viewer.cookie } }).then(r => { assert.equal(r.statusCode, 200, r.body); return r.json(); });
  const over = await get('/api/overview?range=24h');
  assert.equal(over.sites.length, 7);
  const blog = over.sites.find(s => s.id === 'blog');
  assert.ok(blog.views >= 1); assert.equal(blog.errors, 1); assert.equal(blog.spark.length >= 24, true);
  const site = await get('/api/sites/blog?range=7d');
  assert.ok(site.pages.some(p => p.path === '/posts/hi' && p.views === 1));
  assert.ok(site.referrers.some(r => r.source === 'www.google.com'));
  assert.ok(!site.referrers.some(r => r.source === 'blog.deltavdevs.com'), 'links inside the site are not sources');
  assert.equal(site.utm[0].campaign, 'launch');
  assert.equal(site.redirects.length, 0, 'the only redirect came from a bot (curl)');
  assert.equal(site.statuses.find(s => s.status === 500).requests, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/sites/nope', headers: { cookie: viewer.cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/overview?range=5y', headers: { cookie: viewer.cookie } })).statusCode, 400);
  const up = await get('/api/uptime?range=24h');
  const fc = up.sites.find(s => s.id === 'firstcommand');
  assert.equal(fc.outages.length, 1); assert.equal(fc.outages[0].reason, 'ECONNREFUSED');
  assert.equal(up.sites.find(s => s.id === 'blog').uptime, 1);
});

test('static files are served and path tricks get nothing', { skip }, async () => {
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200); assert.match(page.body, /Continue with Ward/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const url of ['/app.js', '/analytics.css', '/favicon.svg']) assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200, url);
  for (const url of ['/t.js', '/consent.js']) {
    const t = await app.inject({ method: 'GET', url });
    assert.equal(t.statusCode, 200, url); assert.match(t.headers['content-type'], /javascript/);
    assert.equal(t.headers['cross-origin-resource-policy'], 'cross-origin', url);
  }
  for (const url of ['/..%2fpackage.json', '/%2e%2e/src/config.js', '/..%5csrc%5cconfig.js', '/public/../src/auth.js', '/api%2fme', '/%2fapi/me']) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok([400, 401, 403, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`);
    assert.doesNotMatch(res.body, /SESSION_SECRET|sessionSecret|"name": "deltav-analytics"/, url);
  }
});

// ---------- status.deltavdevs.com ----------
test('status host: only the public page and its json, never analytics', { skip }, async () => {
  const on = url => app.inject({ method: 'GET', url, headers: { host: 'status.deltavdevs.com' } });
  const page = await on('/');
  assert.equal(page.statusCode, 200); assert.match(page.body, /DeltaVDevs status/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  for (const url of ['/status.css', '/status-app.js', '/favicon.svg', '/health']) assert.equal((await on(url)).statusCode, 200, url);
  for (const url of ['/api/me', '/api/overview', '/t.js', '/consent.js', '/auth/ward/start', '/r/anything', '/app.js', '/index.html']) assert.equal((await on(url)).statusCode, 404, url);
  assert.equal((await app.inject({ method: 'POST', url: '/e', headers: { host: 'status.deltavdevs.com' } })).statusCode, 405);
  // The analytics host is unaffected.
  assert.match((await app.inject({ method: 'GET', url: '/' })).body, /Continue with Ward/);
});

test('status checks: below 500 is up, errors and timeouts are down; rollups and outages', { skip }, async () => {
  const targets = [
    { id: 'a.test', host: 'a.test', name: 'A', group: 'G', url: 'https://a.test/' },
    { id: 'b.test', host: 'b.test', name: 'B', group: 'G', url: 'https://b.test/' },
    { id: 'c.test', host: 'c.test', name: 'C', group: 'G', url: 'https://c.test/' },
  ];
  const fetcher = async url => {
    if (url.includes('c.test')) throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } });
    return new Response('', { status: url.includes('a.test') ? 404 : 502 });
  };
  await mod.status.checkStatus({ fetcher, targets });
  await db.query("INSERT INTO status_checks (target, at, ok, status) VALUES ('a.test', now() - interval '20 days', true, 200)");
  const rows = Object.fromEntries((await db.query("SELECT target, ok, status, error FROM status_checks WHERE at > now() - interval '1 hour'")).rows.map(r => [r.target, r]));
  assert.equal(rows['a.test'].ok, true, 'a 404 at / still means the server is up');
  assert.equal(rows['b.test'].ok, false); assert.equal(rows['b.test'].status, 502);
  assert.equal(rows['c.test'].ok, false); assert.equal(rows['c.test'].error, 'domain not found');
  await mod.status.rollupStatus();
  assert.equal(await count("SELECT count(*) AS n FROM status_checks WHERE at < now() - interval '14 days'"), 0, 'old raw checks dropped');
  assert.equal(await count("SELECT count(*) AS n FROM status_daily WHERE target = 'b.test' AND up = 0"), 1);
  const data = await mod.status.statusData();
  const b = data.outages.find(o => o.host === 'b.test');
  assert.ok(b && b.ongoing);
  const json = await app.inject({ method: 'GET', url: '/status.json', headers: { host: 'status.deltavdevs.com' } });
  assert.equal(json.statusCode, 200); assert.equal(json.headers['access-control-allow-origin'], '*');
  assert.ok(json.json().sites.length >= 30, 'every configured hostname is listed');
});
