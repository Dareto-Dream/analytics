// Analytics dashboard. No framework, no build step. All DOM is built with h(),
// which only sets text, so paths, titles and referrers from the wild can't inject markup.

const $ = sel => document.querySelector(sel);
let me = null;

function h(tag, attrs = {}, ...children) {
  const svg = ['svg', 'path', 'rect', 'line', 'text', 'g', 'title', 'polyline'].includes(tag);
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'value') el.value = v;
    // The CSP forbids style attributes; style properties set from script are fine.
    else if (k === 'style') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const mount = (...nodes) => $('#view').replaceChildren(...nodes);
const toast = (message, error = false) => { const el = h('div', { class: `toast${error ? ' error' : ''}` }, message); $('#toasts').append(el); setTimeout(() => el.remove(), error ? 8000 : 3500); };
const fail = e => toast(e.message || String(e), true);
const n = v => (v == null ? '—' : Number(v).toLocaleString());
const pct = v => (v == null ? '—' : `${(v * 100).toFixed(v >= 0.999 && v < 1 ? 2 : 1)}%`);
const ms = v => (v == null ? '—' : `${Number(v).toLocaleString()} ms`);
const when = v => (v ? new Date(v).toLocaleString() : '—');
const canEdit = () => ['admin', 'owner'].includes(me?.level);

async function api(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') init.headers['X-Analytics-CSRF'] = me?.csrf || '';
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const response = await fetch(path, init);
  if (response.status === 401) { showLogin(); throw new Error('Signed out'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// ---------- range + routing ----------
let range = (() => { try { return localStorage.getItem('range') || '7d'; } catch { return '7d'; } })();
const setRange = r => { range = r; try { localStorage.setItem('range', r); } catch {} render(); };
const ranges = () => h('div', { class: 'ranges' }, ['24h', '7d', '30d', '90d'].map(r => h('button', { type: 'button', class: r === range ? 'on' : '', onclick: () => setRange(r) }, r)));
const head = (eyebrow, title, ...actions) => h('div', { class: 'view-head' }, h('div', {}, h('p', { class: 'eyebrow' }, eyebrow), h('h1', { class: 'headline' }, title)), h('div', { class: 'row' }, actions));

// ---------- charts ----------
function barChart(points, { line = null, errors = null, bucket = 'day' } = {}) {
  const W = 800, H = 180, pad = { l: 36, r: 8, t: 8, b: 20 };
  const max = Math.max(1, ...points.map(p => p.n), ...(line || []).map(p => p.n));
  const w = (W - pad.l - pad.r) / Math.max(points.length, 1);
  const y = v => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const label = at => { const d = new Date(at); return bucket === 'hour' ? `${d.getHours()}:00` : `${d.getMonth() + 1}/${d.getDate()}`; };
  const every = Math.ceil(points.length / 8);
  return h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' },
    [0, 0.5, 1].map(f => h('g', {}, h('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(max * f), y2: y(max * f) }), h('text', { class: 'axis', x: 2, y: y(max * f) + 3 }, Math.round(max * f)))),
    points.map((p, i) => h('rect', { class: 'bar', x: pad.l + i * w + 1, y: y(p.n), width: Math.max(w - 2, 1), height: H - pad.b - y(p.n) }, h('title', {}, `${label(p.at)}: ${p.n}`))),
    errors ? errors.map((p, i) => (p.n ? h('rect', { class: 'err', x: pad.l + i * w + 1, y: H - pad.b - 3, width: Math.max(w - 2, 1), height: 3 }, h('title', {}, `${p.n} server errors`)) : null)) : null,
    line ? h('polyline', { class: 'line', points: line.map((p, i) => `${pad.l + i * w + w / 2},${y(p.n)}`).join(' ') }) : null,
    points.map((p, i) => (i % every ? null : h('text', { class: 'axis', x: pad.l + i * w + w / 2, y: H - 5, 'text-anchor': 'middle' }, label(p.at)))));
}
function spark(values) {
  const max = Math.max(1, ...values), W = 200, H = 36;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(values.length - 1, 1)) * W},${H - 2 - (v / max) * (H - 4)}`).join(' ');
  return h('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, h('path', { d }));
}

// ---------- tables ----------
function panel(title, rows, columns, { note = null, empty = 'Nothing yet.' } = {}) {
  const numeric = columns.filter(c => c.n).map(c => c.key);
  const max = Math.max(1, ...rows.map(r => Number(r[numeric[0]] || 0)));
  return h('section', { class: 'card panel' }, h('h3', {}, title), note ? h('p', { class: 'caption' }, note) : null,
    rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, columns.map(c => h('th', {}, c.label)))),
      h('tbody', {}, rows.map(r => h('tr', {}, columns.map((c, i) => (c.n
        ? h('td', { class: 'n' }, n(r[c.key]))
        : h('td', { class: i === 0 ? 'bar-cell' : '', title: String(r[c.key] ?? '') },
          i === 0 && numeric.length ? h('span', { class: 'fill', style: { width: `${(Number(r[numeric[0]] || 0) / max) * 100}%` } }) : null,
          h('span', { class: 'label' }, c.fmt ? c.fmt(r[c.key]) : String(r[c.key] ?? '—')))))))))) : h('p', { class: 'empty' }, empty));
}
const tile = (k, v, cls = '') => h('div', { class: 'tile' }, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
const statusDot = s => h('span', { class: `dot ${s?.ok === true ? 'ok' : s?.ok === false ? 'bad' : 'warn'}`, title: s ? (s.ok ? `Up (${s.code})` : s.error || `HTTP ${s.code}`) : 'No checks yet' });

// ---------- views ----------
async function overview() {
  const data = await api('GET', `/api/overview?range=${range}`);
  mount(head('all sites', 'Overview', ranges()),
    ingestNote(),
    h('div', { class: 'sites' }, data.sites.map(s => h('a', { class: 'card site-card', href: `#/site/${s.id}` },
      h('div', { class: 'top' }, h('strong', {}, statusDot(s.status), ' ', s.name), h('span', { class: 'host' }, s.host)),
      spark(s.spark),
      h('div', { class: 'tiles' },
        tile('views', n(s.views)), tile('visitors', n(s.visitors)), tile('uptime', pct(s.uptime), s.uptime != null && s.uptime < 0.99 ? 'bad' : ''),
        tile('requests', n(s.requests)), tile('5xx', n(s.errors), s.errors ? 'bad' : ''), tile('p95', ms(s.p95_ms)))))));
}

function ingestNote() {
  if (!me.railway) return h('p', { class: 'notice' }, 'Request logs are off: RAILWAY_API_TOKEN is not set.');
  if (me.ingest?.last_error) return h('p', { class: 'notice error' }, `Reading Railway logs failed: ${me.ingest.last_error}`);
  return h('p', { class: 'caption' }, me.ingest?.last_run_at ? `Request logs last read ${when(me.ingest.last_run_at)}. Page views arrive live.` : 'Request logs are read every 5 minutes. Page views arrive live.');
}

async function siteView(id) {
  const d = await api('GET', `/api/sites/${id}?range=${range}`);
  const s = d.summary;
  const consentNote = d.site.cookies
    ? (d.consent.choices ? `${n(d.consent.accepted)} of ${n(d.consent.choices)} consent choices accepted analytics cookies (${n(d.consent.gpc)} with Global Privacy Control).` : 'No consent choices recorded in this range.')
    : 'This site never sets analytics cookies; it reports referrers and page counts only.';
  mount(head(d.site.hosts.join(' · '), h('span', {}, statusDot(s.status), ' ', d.site.name), ranges()),
    h('div', { class: 'tiles' },
      tile('page views', n(s.views)), tile('visitors', n(s.visitors)), tile('uptime', pct(s.uptime), s.uptime != null && s.uptime < 0.99 ? 'bad' : 'good'),
      tile('requests', n(s.requests)), tile('bot requests', n(s.bots)), tile('server errors', n(s.errors), s.errors ? 'bad' : ''),
      tile('p95 response', ms(s.p95_ms)), tile('check latency', ms(s.latency_ms))),
    h('p', { class: 'caption' }, 'Visitors count consented visitors once and everyone else once per day, so longer ranges over-count a little. ', consentNote),
    h('section', { class: 'card' },
      h('div', { class: 'legend' }, h('span', {}, h('i', { style: { background: 'rgba(20,184,166,.55)' } }), 'page views'), h('span', {}, h('i', { style: { background: '#a78bfa' } }), 'requests (no bots)'), h('span', {}, h('i', { style: { background: 'var(--red)' } }), 'server errors')),
      barChart(d.views, { line: d.requests, errors: d.errors, bucket: d.bucket })),
    h('div', { class: 'panels' },
      panel('Pages', d.pages, [{ key: 'path', label: 'path' }, { key: 'views', label: 'views', n: 1 }, { key: 'visitors', label: 'visitors', n: 1 }]),
      panel('Sources', d.referrers, [{ key: 'source', label: 'referrer' }, { key: 'views', label: 'views', n: 1 }], { note: 'Where visitors came from. Links inside this site are left out.' }),
      panel('Campaigns (UTM)', d.utm, [{ key: 'source', label: 'source' }, { key: 'medium', label: 'medium' }, { key: 'campaign', label: 'campaign' }, { key: 'views', label: 'views', n: 1 }]),
      panel('Outbound links', d.outbound, [{ key: 'host', label: 'went to' }, { key: 'clicks', label: 'clicks', n: 1 }]),
      panel('Devices', d.devices, [{ key: 'device', label: 'device' }, { key: 'views', label: 'views', n: 1 }]),
      panel('Browsers', d.browsers, [{ key: 'browser', label: 'browser' }, { key: 'views', label: 'views', n: 1 }]),
      panel('Status codes', d.statuses, [{ key: 'status', label: 'status' }, { key: 'requests', label: 'requests', n: 1 }], { note: 'From Railway request logs, bots left out.' }),
      panel('Redirects', d.redirects, [{ key: 'path', label: 'path' }, { key: 'status', label: 'code' }, { key: 'requests', label: 'requests', n: 1 }]),
      panel('Not found (404)', d.missing, [{ key: 'path', label: 'path' }, { key: 'requests', label: 'requests', n: 1 }, { key: 'bots', label: 'bots', n: 1 }]),
      panel('Slowest paths', d.slow, [{ key: 'path', label: 'path' }, { key: 'p95_ms', label: 'p95 ms', n: 1 }, { key: 'requests', label: 'requests', n: 1 }], { note: 'Paths with at least 5 requests.' })));
}

async function uptimeView() {
  const data = await api('GET', `/api/uptime?range=${range}`);
  mount(head('checked every minute', 'Uptime', ranges()),
    h('div', { class: 'panels' }, data.sites.map(s => h('section', { class: 'card panel' },
      h('h3', {}, statusDot(s.status), ' ', s.name),
      h('div', { class: 'tiles' }, tile('uptime', pct(s.uptime), s.uptime != null && s.uptime < 0.99 ? 'bad' : 'good'), tile('avg latency', ms(s.latency_ms)), tile('last check', s.status ? (s.status.ok ? `up (${s.status.code})` : 'down') : '—', s.status && !s.status.ok ? 'bad' : '')),
      s.status && !s.status.ok ? h('p', { class: 'notice error' }, s.status.error || `HTTP ${s.status.code}`) : null,
      h('h3', {}, 'Outages'),
      s.outages.length ? s.outages.map(o => h('div', { class: 'outage' }, h('span', {}, `${when(o.started)} → ${when(o.last_failed)}`), h('span', {}, `${o.checks} min · ${o.reason}`))) : h('p', { class: 'empty' }, 'None in this range.')))));
}

async function linksView() {
  const data = await api('GET', '/api/links');
  const slug = h('input', { placeholder: 'discord', maxlength: 48 });
  const dest = h('input', { placeholder: 'https://discord.gg/…', type: 'url' });
  const note = h('input', { placeholder: 'note (optional)', maxlength: 200 });
  const create = async e => {
    e.preventDefault();
    try { await api('POST', '/api/links', { slug: slug.value.trim(), destination: dest.value.trim(), ...(note.value.trim() ? { note: note.value.trim() } : {}) }); toast('Link created'); render(); } catch (err) { fail(err); }
  };
  const act = async (method, s, body, done) => { try { await api(method, `/api/links/${encodeURIComponent(s)}`, body); toast(done); render(); } catch (err) { fail(err); } };
  mount(head('tracked redirects', 'Short links'),
    h('p', { class: 'caption' }, `Links look like ${data.base}name. Each click is counted, then the visitor is sent on.`),
    canEdit() ? h('form', { class: 'card link-form', onsubmit: create },
      h('label', {}, 'Name', slug), h('label', {}, 'Goes to', dest), h('label', {}, 'Note', note), h('button', { class: 'cta', type: 'submit' }, 'Create')) : h('p', { class: 'caption' }, 'Viewers can see links but not change them.'),
    data.links.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['link', 'goes to', 'clicks (7 days)', 'clicks (all)', 'note', ''].map(c => h('th', {}, c)))),
      h('tbody', {}, data.links.map(l => h('tr', {},
        h('td', {}, `/r/${l.slug}`, l.disabled_at ? h('span', { class: 'pill muted' }, ' off') : null), h('td', { title: l.destination }, l.destination),
        h('td', { class: 'n' }, n(l.clicks_7d)), h('td', { class: 'n' }, n(l.clicks)), h('td', {}, l.note || ''),
        h('td', {}, canEdit() ? h('button', { class: 'outline small', onclick: () => act('PATCH', l.slug, { disabled: !l.disabled_at }, l.disabled_at ? 'Turned on' : 'Turned off') }, l.disabled_at ? 'Turn on' : 'Turn off') : null,
          me.level === 'owner' ? h('button', { class: 'ghost small', onclick: () => { if (confirm(`Delete /r/${l.slug} and its click history?`)) act('DELETE', l.slug, undefined, 'Deleted'); } }, 'Delete') : null))))))
      : h('p', { class: 'empty' }, 'No short links yet.'));
}

// ---------- shell ----------
function nav() {
  const here = location.hash || '#/';
  const link = (href, label) => h('a', { href, class: here === href ? 'active' : '' }, h('span', {}, label));
  $('#nav').replaceChildren(link('#/', 'Overview'), h('div', { class: 'nav-group' }, 'Sites'), ...me.sites.map(s => link(`#/site/${s.id}`, s.name)),
    h('div', { class: 'nav-group' }, 'Tools'), link('#/uptime', 'Uptime'), link('#/links', 'Short links'));
}

async function render() {
  if (!me) return;
  nav();
  const hash = location.hash || '#/';
  const site = hash.match(/^#\/site\/([a-z0-9]+)$/);
  try {
    if (site) await siteView(site[1]);
    else if (hash === '#/uptime') await uptimeView();
    else if (hash === '#/links') await linksView();
    else await overview();
  } catch (err) { if (err.message !== 'Signed out') mount(h('p', { class: 'notice error' }, err.message)); }
}

function showLogin() {
  me = null;
  $('#shell').hidden = true; $('#login').hidden = false;
  const error = new URLSearchParams(location.search).get('error');
  if (error) { $('#login-error').textContent = error; $('#login-error').hidden = false; history.replaceState(null, '', '/'); }
}

async function boot() {
  const state = await fetch('/auth/state').then(r => r.json()).catch(() => ({ signedIn: false }));
  if (!state.signedIn) return showLogin();
  me = await api('GET', '/api/me');
  $('#login').hidden = true; $('#shell').hidden = false;
  $('#me').replaceChildren(h('span', { title: me.email || me.name }, `${me.name} · ${me.level}`));
  $('#logout').onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); location.href = '/'; };
  addEventListener('hashchange', render);
  render();
}
boot().catch(fail);
