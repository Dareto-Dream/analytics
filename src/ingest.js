import { z } from 'zod';
import { config } from './config.js';
import { equal } from './auth.js';
import { transaction } from './db.js';
import { ipHash } from './privacy.js';

// Other DeltaVDevs services report here with ANALYTICS_INGEST_KEY: go (short link changes and clicks) and store
// (downloads). They send an IP only so it can be hashed with the day's salt and thrown away; nothing here keeps it.

const ts = z.string().datetime({ offset: true });
const text = (max, min = 0) => z.string().min(min).max(max);
const maybe = max => z.string().max(max).nullish();

const goBody = z.object({
  links: z.array(z.object({
    t: z.literal('link'), slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/), destination: text(2100), note: maybe(300), created_by: text(100), created_at: ts,
    disabled: z.boolean().default(false), deleted: z.boolean().optional(),
  })).max(500).default([]),
  clicks: z.array(z.object({
    t: z.literal('click'), slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/), at: ts, ref: maybe(253), device: maybe(20), bot: z.boolean().default(false), ip: maybe(64),
  })).max(500).default([]),
}).strict();

const storeBody = z.object({
  downloads: z.array(z.object({
    t: z.literal('download'), at: ts, bundle: text(40, 1), title: maybe(200), access: z.enum(['public', 'guarded']), file: maybe(400), bytes: z.number().int().min(0).nullish(),
    ref: maybe(253), device: maybe(20), bot: z.boolean().default(false), ip: maybe(64),
  })).max(500).default([]),
}).strict();

function authorised(request, reply) {
  const header = String(request.headers.authorization || '');
  if (!config.ingestKey) { reply.code(503).send({ error: 'Ingest is not set up.' }); return false; }
  if (!header.startsWith('Bearer ') || !equal(header.slice(7), config.ingestKey)) { reply.code(401).send({ error: 'Unauthorized' }); return false; }
  return true;
}

const clock = at => {
  // A report that claims to be from the future, or from long ago, is clamped to now.
  const t = Date.parse(at), now = Date.now();
  return new Date(Number.isNaN(t) || t > now + 60_000 || t < now - 7 * 86_400_000 ? now : t);
};

export async function ingestRoutes(app) {
  app.post('/ingest/go', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    if (!authorised(request, reply)) return reply;
    const body = goBody.parse(request.body);
    const clicks = [];
    for (const c of body.clicks) {
      const at = clock(c.at);
      clicks.push([c.slug, at, c.ref || null, c.device || null, c.bot, await ipHash(c.ip, `go:${c.slug}`, at)]);
    }
    await transaction(async db => {
      for (const l of body.links) {
        if (l.deleted) { await db.query('DELETE FROM go_links WHERE slug = $1', [l.slug]); continue; }
        await db.query(`INSERT INTO go_links (slug, destination, note, created_by, created_at, disabled_at, updated_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END, now())
          ON CONFLICT (slug) DO UPDATE SET destination = EXCLUDED.destination, note = EXCLUDED.note, created_by = EXCLUDED.created_by,
            disabled_at = CASE WHEN $6 THEN COALESCE(go_links.disabled_at, now()) END, updated_at = now()`,
        [l.slug, l.destination, l.note || null, l.created_by, l.created_at, l.disabled]);
      }
      for (const c of clicks) await db.query('INSERT INTO go_clicks (slug, at, referrer_host, device, bot, ip_hash) VALUES ($1, $2, $3, $4, $5, $6)', c);
    });
    return { ok: true, links: body.links.length, clicks: clicks.length };
  });

  app.post('/ingest/store', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    if (!authorised(request, reply)) return reply;
    const body = storeBody.parse(request.body);
    const rows = [];
    for (const d of body.downloads) {
      const at = clock(d.at);
      rows.push([at, d.bundle, d.title || null, d.access, d.file || null, d.bytes ?? null, d.ref || null, d.device || null, d.bot, await ipHash(d.ip, `store:${d.bundle}`, at)]);
    }
    await transaction(async db => {
      for (const r of rows) await db.query('INSERT INTO store_downloads (at, bundle, title, access, file, bytes, referrer_host, device, bot, ip_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', r);
    });
    return { ok: true, downloads: rows.length };
  });
}
