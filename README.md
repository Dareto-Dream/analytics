# Analytics

Analytics for every DeltaVDevs site, at https://analytics.deltavdevs.com. Staff only: sign in with Ward, and your Ward account needs a staff level (`viewer`, `admin` or `owner`).

## What it shows

- **Overview:** every site's page views, visitors, uptime, requests, server errors and response time.
- **Per site:** traffic over time, pages, sources (referrers), UTM campaigns, outbound link clicks, devices, browsers, status codes, redirects, 404s, slowest paths and consent rate.
- **Uptime:** every site is checked every minute; outages are listed with the reason.
- **Short links:** `analytics.deltavdevs.com/r/<name>` counts a click and sends the visitor on. Viewers can look, admins and owners can create and turn links off, and only owners can delete them.

## Where the data comes from

- **Railway request logs**, read every 5 minutes for each site's service (two API calls a run, all sites batched). Needs `RAILWAY_API_TOKEN`, an account token so it can read FIRST Command's project too.
- **Uptime checks**, run from this service every minute.
- **`t.js`**, a small script on each site:

  ```html
  <script defer src="https://analytics.deltavdevs.com/t.js"></script>
  <!-- Referrers and page counts only, never a cookie (Synthcity): -->
  <script defer src="https://analytics.deltavdevs.com/t.js" data-cookies="off"></script>
  ```

  It reports the page, the referrer, UTM tags and clicks on links that leave the site. Only after the visitor accepts analytics cookies (the site's consent banner sets `dv_consent` to include `analytics`) does it keep a first-party visitor id (`dv_vid`, 13 months) and a per-tab session id. Global Privacy Control always counts as no. The banner records each choice at `POST /consent` as proof of consent.

## Privacy

- Raw IPs are never stored. Unique visitors without consent are counted with a hash of the IP and a salt that changes every day; old salts are deleted, so days can't be linked and the hash can't be reversed.
- Query strings are never stored, except the three UTM tags.
- After 13 months, a job strips everything that could identify a person (visitor and session ids, IP hashes, user agents, consent ids). Counts, paths, sources and timings are kept.

## Access

Sign-in is Ward (`openid profile email admin offline_access`). Sessions live in this service's database with the Ward refresh token sealed (AES-256-GCM). Every 5 minutes the session swaps it for a new one and re-reads the staff level, so a demotion or suspension ends access; if Ward is down, the session keeps its last known level.

## Setup

Create a first-party Ward app with scopes `openid profile email admin offline_access` and redirect URI `https://analytics.deltavdevs.com/auth/ward/callback`. Then set the variables in `.env.example`. Migrations run on start.

```sh
npm install
npm run dev   # uses .env
TEST_PG_URL=postgres://user:pass@localhost:5432/postgres npm test   # creates analytics_test
```

Sites, hosts, uptime URLs and Railway services are listed in `src/config.js`; `ANALYTICS_SITES` (same JSON shape) replaces the list.

The public status page is a separate service: https://status.deltavdevs.com (repo `Dareto-Dream/status`).
