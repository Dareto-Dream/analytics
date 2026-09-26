-- Analytics for every DeltaVDevs site.
--
-- Privacy rules the schema is built around:
--  * Raw IPs are never stored. ip_hash is SHA-256(daily salt, IP, site); the
--    salt row is deleted after two days, so days can't be linked.
--  * visitor_id only exists when the visitor accepted analytics cookies.
--  * After 13 months, retention.js nulls every column marked "identifying"
--    below. Counts, paths, sources and timings are kept.

-- Railway request logs, one row per request (deduplicated on Railway's id).
CREATE TABLE requests (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  site text NOT NULL,
  at timestamptz NOT NULL,
  host text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status int NOT NULL,
  duration_ms int,
  bytes_out int,
  region text,
  bot boolean NOT NULL DEFAULT false,
  device text,                    -- desktop / mobile / tablet / other
  browser text,
  ip_hash text,                   -- identifying
  user_agent text                 -- identifying
);
CREATE INDEX requests_site_at ON requests (site, at);
CREATE INDEX requests_at ON requests (at);

-- Where the Railway collector got to, per service.
CREATE TABLE ingest_cursors (
  service_id text PRIMARY KEY,
  site text NOT NULL,
  last_at timestamptz,
  last_run_at timestamptz,
  last_error text
);

-- Page views from t.js.
CREATE TABLE pageviews (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  path text NOT NULL,
  title text,
  referrer_host text,
  referrer_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  device text,
  browser text,
  consented boolean NOT NULL DEFAULT false,
  visitor_id uuid,                -- identifying (only with consent)
  session_id uuid,                -- identifying (only with consent)
  ip_hash text                    -- identifying
);
CREATE INDEX pageviews_site_at ON pageviews (site, at);
CREATE INDEX pageviews_at ON pageviews (at);

-- Outbound link clicks from t.js.
CREATE TABLE outbound (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  path text NOT NULL,
  target_host text NOT NULL,
  target_path text,
  visitor_id uuid,                -- identifying
  ip_hash text                    -- identifying
);
CREATE INDEX outbound_site_at ON outbound (site, at);

-- Tracked short links: analytics.deltavdevs.com/r/<slug> → destination.
CREATE TABLE links (
  slug text PRIMARY KEY CONSTRAINT slug_shape CHECK (slug ~ '^[a-z0-9-]{1,48}$'),
  destination text NOT NULL,
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE TABLE link_clicks (
  id bigserial PRIMARY KEY,
  slug text NOT NULL REFERENCES links(slug) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  referrer_host text,
  device text,
  bot boolean NOT NULL DEFAULT false,
  ip_hash text                    -- identifying
);
CREATE INDEX link_clicks_slug_at ON link_clicks (slug, at);

-- Uptime checks, one row per site per minute.
CREATE TABLE uptime_checks (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  status int,
  latency_ms int,
  error text
);
CREATE INDEX uptime_checks_site_at ON uptime_checks (site, at);

-- Cookie consent choices, as proof of consent (GDPR art. 7(1)).
CREATE TABLE consents (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  consent_id uuid,                -- identifying: the id stored in the visitor's cookie
  analytics boolean NOT NULL,
  gpc boolean NOT NULL DEFAULT false,
  policy_version text NOT NULL
);
CREATE INDEX consents_site_at ON consents (site, at);

-- Daily salts for ip_hash. Deleted after two days.
CREATE TABLE salts (
  day date PRIMARY KEY,
  salt bytea NOT NULL
);

-- Signed-in staff sessions (Ward). The refresh token is AES-GCM sealed.
CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  sub uuid NOT NULL,
  name text NOT NULL,
  email text,
  level text NOT NULL,
  refresh_token text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);
