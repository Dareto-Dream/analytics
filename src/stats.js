import { z } from 'zod';
import { config, siteById } from './config.js';
import { query, one } from './db.js';
import { requireLevel, csrfFor } from './auth.js';
import { lastIngest } from './jobs.js';

// Ranges and the bucket each one is charted in.
const RANGES = { '24h': ['24 hours', 'hour'], '7d': ['7 days', 'day'], '30d': ['30 days', 'day'], '90d': ['90 days', 'day'] };
const rangeOf = request => {
  const range = z.enum(Object.keys(RANGES)).default('7d').parse(request.query?.range || undefined);
  const [span, bucket] = RANGES[range];
  return { range, span, bucket };
};
const siteOr404 = id => siteById(id) || Promise.reject(Object.assign(new Error('Unknown site'), { statusCode: 404 }));
const rows = async (sql, params) => (await query(sql, params)).rows;
const int = v => Number(v || 0);

// Unique visitors: consented visitors by their id, everyone else by the day's IP hash.
// Across several days the second part over-counts (hashes rotate daily); the UI says so.
const VISITOR = "COALESCE(visitor_id::text, ip_hash)";

async function siteSummary(site, span) {
  const [pv, req, up, last] = await Promise.all([
    one(`SELECT count(*) AS views, count(DISTINCT ${VISITOR}) AS visitors FROM pageviews WHERE site = $1 AND at > now() - $2::interval`, [site.id, span]),
    one(`SELECT count(*) FILTER (WHERE NOT bot) AS requests, count(*) FILTER (WHERE bot) AS bots, count(*) FILTER (WHERE status >= 500) AS errors,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE NOT bot) AS p95
         FROM requests WHERE site = $1 AND at > now() - $2::interval`, [site.id, span]),
    one('SELECT count(*) AS checks, count(*) FILTER (WHERE ok) AS up, avg(latency_ms) FILTER (WHERE ok) AS latency FROM uptime_checks WHERE site = $1 AND at > now() - $2::interval', [site.id, span]),
    one('SELECT ok, status, latency_ms, error, at FROM uptime_checks WHERE site = $1 ORDER BY at DESC LIMIT 1', [site.id]),
  ]);
  return {
    id: site.id, name: site.name, host: site.hosts[0],
    views: int(pv.views), visitors: int(pv.visitors),
    requests: int(req.requests), bots: int(req.bots), errors: int(req.errors), p95_ms: req.p95 == null ? null : Math.round(req.p95),
    uptime: int(up.checks) ? Number(up.up) / Number(up.checks) : null, latency_ms: up.latency == null ? null : Math.round(up.latency),
    status: last ? { ok: last.ok, code: last.status, error: last.error, at: last.at } : null,
  };
}

async function series(table, where, site, span, bucket) {
  return rows(`SELECT b.bucket AS at, COALESCE(t.n, 0)::int AS n FROM
      generate_series(date_trunc('${bucket}', now() - $2::interval), date_trunc('${bucket}', now()), '1 ${bucket}') AS b(bucket)
      LEFT JOIN (SELECT date_trunc('${bucket}', at) AS bucket, count(*) AS n FROM ${table} WHERE site = $1 AND at > now() - $2::interval ${where} GROUP BY 1) t USING (bucket)
      ORDER BY 1`, [site.id, span]);
}

const top = (sql, params) => rows(`${sql} LIMIT 20`, params);

export async function statsRoutes(app) {
  app.get('/api/me', async request => ({
    name: request.session.name, email: request.session.email, level: request.session.level, csrf: csrfFor(request.session.id),
    sites: config.sites.map(s => ({ id: s.id, name: s.name, host: s.hosts[0], cookies: Boolean(s.cookies) })),
    ingest: await lastIngest(), railway: Boolean(config.railwayToken),
  }));

  app.get('/api/overview', async request => {
    const { range, span, bucket } = rangeOf(request);
    const sites = await Promise.all(config.sites.map(async site => ({ ...await siteSummary(site, span), spark: (await series('pageviews', '', site, span, bucket)).map(p => p.n) })));
    return { range, sites };
  });

  app.get('/api/sites/:id', async request => {
    const site = await siteOr404(request.params.id);
    const { range, span, bucket } = rangeOf(request);
    const p = [site.id, span];
    const own = site.hosts;
    const [summary, views, requests, errors, pages, referrers, utm, outbound, devices, browsers, statuses, redirects, missing, slow, consent] = await Promise.all([
      siteSummary(site, span),
      series('pageviews', '', site, span, bucket),
      series('requests', 'AND NOT bot', site, span, bucket),
      series('requests', 'AND status >= 500', site, span, bucket),
      top(`SELECT path, count(*)::int AS views, count(DISTINCT ${VISITOR})::int AS visitors FROM pageviews WHERE site = $1 AND at > now() - $2::interval GROUP BY path ORDER BY views DESC`, p),
      top(`SELECT COALESCE(referrer_host, '(direct)') AS source, count(*)::int AS views FROM pageviews WHERE site = $1 AND at > now() - $2::interval
             AND (referrer_host IS NULL OR NOT (referrer_host = ANY($3))) GROUP BY 1 ORDER BY views DESC`, [...p, own]),
      top(`SELECT COALESCE(utm_source, '-') AS source, COALESCE(utm_medium, '-') AS medium, COALESCE(utm_campaign, '-') AS campaign, count(*)::int AS views
             FROM pageviews WHERE site = $1 AND at > now() - $2::interval AND (utm_source IS NOT NULL OR utm_campaign IS NOT NULL) GROUP BY 1, 2, 3 ORDER BY views DESC`, p),
      top('SELECT target_host AS host, count(*)::int AS clicks FROM outbound WHERE site = $1 AND at > now() - $2::interval GROUP BY 1 ORDER BY clicks DESC', p),
      top('SELECT COALESCE(device, \'other\') AS device, count(*)::int AS views FROM pageviews WHERE site = $1 AND at > now() - $2::interval GROUP BY 1 ORDER BY views DESC', p),
      top('SELECT COALESCE(browser, \'Other\') AS browser, count(*)::int AS views FROM pageviews WHERE site = $1 AND at > now() - $2::interval GROUP BY 1 ORDER BY views DESC', p),
      top('SELECT status, count(*)::int AS requests FROM requests WHERE site = $1 AND at > now() - $2::interval AND NOT bot GROUP BY 1 ORDER BY requests DESC', p),
      top('SELECT path, status, count(*)::int AS requests FROM requests WHERE site = $1 AND at > now() - $2::interval AND status BETWEEN 300 AND 399 AND NOT bot GROUP BY 1, 2 ORDER BY requests DESC', p),
      top('SELECT path, count(*)::int AS requests, count(*) FILTER (WHERE bot)::int AS bots FROM requests WHERE site = $1 AND at > now() - $2::interval AND status = 404 GROUP BY 1 ORDER BY requests DESC', p),
      top(`SELECT path, count(*)::int AS requests, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms FROM requests
             WHERE site = $1 AND at > now() - $2::interval AND NOT bot AND duration_ms IS NOT NULL GROUP BY 1 HAVING count(*) >= 5 ORDER BY p95_ms DESC`, p),
      one('SELECT count(*)::int AS choices, count(*) FILTER (WHERE analytics)::int AS accepted, count(*) FILTER (WHERE gpc)::int AS gpc FROM consents WHERE site = $1 AND at > now() - $2::interval', p),
    ]);
    return { range, bucket, site: { id: site.id, name: site.name, hosts: site.hosts, cookies: Boolean(site.cookies) }, summary, views, requests, errors,
      pages, referrers, utm, outbound, devices, browsers, statuses, redirects, missing, slow, consent };
  });

  app.get('/api/uptime', async request => {
    const { range, span } = rangeOf(request);
    const sites = await Promise.all(config.sites.map(async site => {
      const summary = await siteSummary(site, span);
      // Outages: runs of consecutive failed checks.
      const outages = await rows(`WITH c AS (
          SELECT at, ok, error, status, sum(CASE WHEN ok THEN 1 ELSE 0 END) OVER (ORDER BY at) AS grp FROM uptime_checks WHERE site = $1 AND at > now() - $2::interval)
        SELECT min(at) AS started, max(at) AS last_failed, count(*)::int AS checks, (array_agg(COALESCE(error, 'HTTP ' || status) ORDER BY at))[1] AS reason
        FROM c WHERE NOT ok GROUP BY grp ORDER BY started DESC LIMIT 20`, [site.id, span]);
      return { ...summary, outages };
    }));
    return { range, sites };
  });

  // ---------- short links ----------
  const destination = z.string().trim().url().max(2000).refine(u => new URL(u).protocol === 'https:', 'must be https');
  app.get('/api/links', async () => ({
    links: await rows(`SELECT l.*, (SELECT count(*) FROM link_clicks c WHERE c.slug = l.slug AND NOT c.bot)::int AS clicks,
      (SELECT count(*) FROM link_clicks c WHERE c.slug = l.slug AND NOT c.bot AND c.at > now() - interval '7 days')::int AS clicks_7d
      FROM links l ORDER BY l.created_at DESC`),
    base: `${config.publicUrl}/r/`,
  }));
  app.post('/api/links', async (request, reply) => {
    requireLevel(request, 'admin', 'owner');
    const body = z.object({ slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,48}$/), destination, note: z.string().trim().max(200).optional() }).strict().parse(request.body);
    try {
      await query('INSERT INTO links (slug, destination, note, created_by) VALUES ($1, $2, $3, $4)', [body.slug, body.destination, body.note || null, request.session.name]);
    } catch (err) {
      if (err.code === '23505') throw Object.assign(new Error('That short link already exists.'), { statusCode: 409 });
      throw err;
    }
    request.log.info({ audit: true, action: 'link.created', slug: body.slug, by: request.session.sub }, 'audit link.created');
    return reply.code(201).send({ ok: true });
  });
  app.patch('/api/links/:slug', async request => {
    requireLevel(request, 'admin', 'owner');
    const body = z.object({ disabled: z.boolean().optional(), destination: destination.optional(), note: z.string().trim().max(200).nullable().optional() }).strict().parse(request.body);
    const link = await one(`UPDATE links SET disabled_at = CASE WHEN $2::boolean IS NULL THEN disabled_at WHEN $2 THEN COALESCE(disabled_at, now()) ELSE NULL END,
      destination = COALESCE($3, destination), note = CASE WHEN $4::boolean THEN $5 ELSE note END WHERE slug = $1 RETURNING slug`,
      [request.params.slug, body.disabled ?? null, body.destination ?? null, 'note' in body, body.note ?? null]);
    if (!link) throw Object.assign(new Error('No such link.'), { statusCode: 404 });
    request.log.info({ audit: true, action: 'link.updated', slug: link.slug, by: request.session.sub, changes: Object.keys(body) }, 'audit link.updated');
    return { ok: true };
  });
  app.delete('/api/links/:slug', async request => {
    requireLevel(request, 'owner');
    const gone = await one('DELETE FROM links WHERE slug = $1 RETURNING slug', [request.params.slug]);
    if (!gone) throw Object.assign(new Error('No such link.'), { statusCode: 404 });
    request.log.info({ audit: true, action: 'link.deleted', slug: gone.slug, by: request.session.sub }, 'audit link.deleted');
    return { ok: true };
  });
}
