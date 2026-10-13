// Everything analytics depends on comes from the environment. The site list
// below is the default; ANALYTICS_SITES (same JSON shape) replaces it.
const env = process.env;
const production = env.NODE_ENV === 'production';
const publicUrl = (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');

const DELTA_V_DEVS = { projectId: '3915a587-d7f0-4121-a23a-a16cbfbcc696', environmentId: '53c3f454-d489-4081-8d61-de63693dcc03' };

// id: short name used everywhere. hosts: domains that count as this site (for
// t.js origins and request logs). url: what uptime checks fetch. railway: which
// service's request logs to read. cookies: whether t.js may set a visitor cookie
// after consent (SynthCity: referrer only, never cookies).
export const DEFAULT_SITES = [
  { id: 'main', name: 'DeltaVDevs', hosts: ['www.deltavdevs.com', 'deltavdevs.com'], url: 'https://www.deltavdevs.com/', cookies: true,
    railway: { ...DELTA_V_DEVS, serviceId: '65787c45-d58e-464e-af33-ff5eb37ccd55' } },
  { id: 'blog', name: 'Blog', hosts: ['blog.deltavdevs.com'], url: 'https://blog.deltavdevs.com/', cookies: true,
    railway: { ...DELTA_V_DEVS, serviceId: 'c8624749-8939-4458-b183-d26c7709dc5b' } },
  { id: 'deltatime', name: 'DeltaTime', hosts: ['deltatime.deltavdevs.com'], url: 'https://deltatime.deltavdevs.com/up', cookies: true,
    railway: { ...DELTA_V_DEVS, serviceId: '2dbc0514-6e8b-48f9-96a8-f4044d123aa5' } },
  { id: 'synthcity', name: 'Synthcity', hosts: ['synthcity.deltavdevs.com'], url: 'https://synthcity.deltavdevs.com/up', cookies: false,
    railway: { ...DELTA_V_DEVS, serviceId: '64ae1de4-25ce-437d-9817-1f25677d3edf' } },
  { id: 'ward', name: 'Ward', hosts: ['ward.deltavdevs.com'], url: 'https://ward.deltavdevs.com/health', cookies: false,
    railway: { ...DELTA_V_DEVS, serviceId: '6c8ec722-57bd-430f-b720-62ad2be4c0eb' } },
  { id: 'telescreen', name: 'Telescreen', hosts: ['telescreen.deltavdevs.com'], url: 'https://telescreen.deltavdevs.com/health', cookies: false,
    railway: { ...DELTA_V_DEVS, serviceId: '0ef1104d-1e48-4153-96ca-c4f5db96dccf' } },
  { id: 'search', name: 'Search', hosts: ['search.deltavdevs.com'], url: 'https://search.deltavdevs.com/v1/health', cookies: false,
    railway: { projectId: 'fd4d9c43-696a-4d42-8697-c00a2036fc4c', environmentId: 'f2cc4485-2494-4be2-8f69-d676276bb8b1', serviceId: '79863c05-a699-44a0-8ea0-9915bc0d0c2c' } },
  // Logger lives in its own Railway project; every workspace is a subdomain, so its hosts include a wildcard.
  { id: 'logger', name: 'Logger', hosts: ['logger.deltavdevs.com', '*.logger.deltavdevs.com'], url: 'https://logger.deltavdevs.com/health', cookies: true,
    railway: { projectId: 'c80a6dc8-3395-46df-9c0b-80a95c6f0103', environmentId: '23833e69-1d2e-4641-8858-aa9afe06bfd7', serviceId: '39ee099a-fa90-463d-a519-e660ef5fd5bf' } },
  { id: 'go', name: 'Go', hosts: ['go.deltavdevs.com'], url: 'https://go.deltavdevs.com/health', cookies: false,
    railway: { ...DELTA_V_DEVS, serviceId: 'bde4461d-69c3-472f-a1d2-c08276633975' } },
  { id: 'store', name: 'Store', hosts: ['store.deltavdevs.com'], url: 'https://store.deltavdevs.com/health', cookies: false,
    railway: { ...DELTA_V_DEVS, serviceId: '56c6f820-4ce6-495b-b1cf-b015e4016686' } },
  { id: 'firstcommand', name: 'FIRST Command', hosts: ['fc.deltavdevs.com'], url: 'https://fc.deltavdevs.com/', cookies: true,
    railway: { projectId: '65a48e7e-0789-4e6d-801c-880457099e6b', environmentId: '383df56e-7f72-459a-aadc-4e1d1fd566f2', serviceId: 'b1ebda3d-c2cf-40c1-8cc9-9f91c810aec2' } },
];

function sites() {
  if (!env.ANALYTICS_SITES) return DEFAULT_SITES;
  const parsed = JSON.parse(env.ANALYTICS_SITES);
  if (!Array.isArray(parsed)) throw new Error('ANALYTICS_SITES must be a JSON array');
  return parsed;
}

export const config = {
  production,
  port: Number(env.PORT || 3000),
  publicUrl,
  origin: new URL(publicUrl).origin,
  databaseUrl: env.DATABASE_URL || '',
  sessionSecret: env.SESSION_SECRET || '',
  sessionHours: Math.min(Math.max(Number(env.SESSION_HOURS || 12), 1), 72),
  ward: {
    url: (env.WARD_URL || '').replace(/\/+$/, ''),
    clientId: env.WARD_CLIENT_ID || '',
    clientSecret: env.WARD_CLIENT_SECRET || '',
  },
  railwayToken: env.RAILWAY_API_TOKEN || '',
  // go and store report clicks and downloads to /ingest/* with this key.
  ingestKey: env.ANALYTICS_INGEST_KEY || '',
  sites: sites(),
  // Background jobs; tests turn them off and call them directly.
  jobs: env.ANALYTICS_JOBS !== 'off',
  retentionMonths: 13,
  policyVersion: env.CONSENT_POLICY_VERSION || '2026-09-26',
};

export const siteById = id => config.sites.find(s => s.id === id);
// A host entry is exact, or "*.example.com" for any single label under example.com.
export function hostMatches(site, host) {
  const h = String(host || '').toLowerCase();
  return site.hosts.some(entry => entry.startsWith('*.')
    ? h.endsWith(entry.slice(1)) && !h.slice(0, -entry.length + 1).includes('.') && h.length > entry.length - 1
    : entry === h);
}
export const siteByHost = host => config.sites.find(s => hostMatches(s, host));
// For SQL: exact hosts, and LIKE patterns for the wildcards.
export const hostSql = site => ({ exact: site.hosts.filter(h => !h.startsWith('*.')), like: site.hosts.filter(h => h.startsWith('*.')).map(h => `%${h.slice(1)}`) });

// Fail closed: an admin tool that can't check who's staff, or signs sessions with a weak key, must not boot.
export function assertConfig() {
  const problems = [];
  if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (!config.databaseUrl) problems.push('DATABASE_URL is required');
  if (!config.ward.url || !config.ward.clientId || !config.ward.clientSecret) problems.push('WARD_URL, WARD_CLIENT_ID and WARD_CLIENT_SECRET are required');
  if (config.production && !config.publicUrl.startsWith('https://')) problems.push('PUBLIC_URL must be https in production');
  if (config.ingestKey && config.ingestKey.length < 32) problems.push('ANALYTICS_INGEST_KEY must be at least 32 characters');
  for (const s of config.sites) if (!/^[a-z0-9]{2,20}$/.test(s.id) || !Array.isArray(s.hosts) || !s.hosts.length) problems.push(`bad site entry: ${JSON.stringify(s).slice(0, 80)}`);
  if (problems.length) throw new Error(`analytics refuses to start:\n - ${problems.join('\n - ')}`);
}
