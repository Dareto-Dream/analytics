-- go.deltavdevs.com and store.deltavdevs.com report here. They keep their own data; analytics keeps what it
-- needs to chart: a mirror of go's links, every click, and every download.
CREATE TABLE go_links (
  slug text PRIMARY KEY,
  destination text NOT NULL,
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE go_clicks (
  id bigserial PRIMARY KEY,
  slug text NOT NULL,
  at timestamptz NOT NULL,
  referrer_host text,
  device text,
  bot boolean NOT NULL DEFAULT false,
  ip_hash text                    -- identifying
);
CREATE INDEX go_clicks_slug_at ON go_clicks (slug, at);
CREATE INDEX go_clicks_at ON go_clicks (at);

CREATE TABLE store_downloads (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  bundle text NOT NULL,
  title text,
  access text,
  file text,
  bytes bigint,
  referrer_host text,
  device text,
  bot boolean NOT NULL DEFAULT false,
  ip_hash text                    -- identifying
);
CREATE INDEX store_downloads_at ON store_downloads (at);
CREATE INDEX store_downloads_bundle_at ON store_downloads (bundle, at);
