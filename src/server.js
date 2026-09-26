import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config, assertConfig } from './config.js';
import { migrate, pool } from './db.js';
import { authRoutes, guard, currentSession } from './auth.js';
import { collectRoutes } from './collect.js';
import { statsRoutes } from './stats.js';
import { startJobs } from './jobs.js';
import { statusRoutes } from './status.js';

const THEME = 'https://css.deltavdevs.com';

export async function buildApp(options = {}) {
  assertConfig();
  const app = Fastify({ logger: options.logger ?? { level: 'info' }, trustProxy: true, bodyLimit: 64 * 1024 });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", THEME, 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", THEME, 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    // t.js and /r links are loaded cross-site on purpose.
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  // status.deltavdevs.com: public status page only; its hook answers before any analytics route.
  await statusRoutes(app);
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ error: status >= 500 ? 'Something broke.' : error.message });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/robots.txt', async (_r, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  await app.register(authRoutes);
  await app.register(collectRoutes);
  await app.register(async api => {
    api.addHook('onRequest', guard);
    await api.register(statsRoutes);
  });
  app.get('/auth/state', async request => ({ signedIn: Boolean(await currentSession(request)) }));
  await app.register(staticFiles, { root: fileURLToPath(new URL('../public', import.meta.url)), index: ['index.html'] });
  app.addHook('onClose', async () => { await pool.end().catch(() => {}); });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await buildApp();
  await migrate();
  const stop = config.jobs ? startJobs(app.log) : () => {};
  await app.listen({ port: config.port, host: '0.0.0.0' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { stop(); await app.close(); process.exit(0); });
}
