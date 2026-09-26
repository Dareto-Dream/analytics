-- Public status page (status.deltavdevs.com): one check per hostname per minute.
-- Hostnames only, nothing about visitors. Raw checks are kept 14 days; daily
-- totals are kept for good.
CREATE TABLE status_checks (
  id bigserial PRIMARY KEY,
  target text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  status int,
  latency_ms int,
  error text
);
CREATE INDEX status_checks_target_at ON status_checks (target, at);
CREATE INDEX status_checks_at ON status_checks (at);

CREATE TABLE status_daily (
  target text NOT NULL,
  day date NOT NULL,
  checks int NOT NULL,
  up int NOT NULL,
  avg_latency_ms int,
  PRIMARY KEY (target, day)
);
