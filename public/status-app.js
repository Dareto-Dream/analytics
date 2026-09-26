// status.deltavdevs.com. Builds DOM with textContent only.
const $ = sel => document.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const pct = v => (v == null ? 'no data yet' : `${(v * 100).toFixed(v > 0.999 && v < 1 ? 2 : 1)}% uptime`);
const when = v => new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const minutes = n => (n < 60 ? `${n} min` : `${Math.floor(n / 60)} h ${n % 60} min`);

function bars(days) {
  const byDay = new Map(days.map(d => [d.day, d]));
  const box = el('div', 'bars');
  for (let i = 89; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    const s = el('span');
    if (d && d.checks) {
      const r = d.up / d.checks;
      s.className = r >= 0.999 ? 'good' : r >= 0.95 ? 'warn' : 'bad';
      s.title = `${day}: ${(r * 100).toFixed(2)}% up`;
    } else s.title = `${day}: no data`;
    box.append(s);
  }
  return box;
}

function render(data) {
  const down = data.sites.filter(s => s.up === false);
  const checked = data.sites.filter(s => s.up !== null).length;
  const summary = $('#summary');
  summary.className = `summary ${down.length ? 'down' : 'up'}`;
  summary.textContent = !checked ? 'Waiting for the first checks.' : down.length ? `${down.length} of ${data.sites.length} sites are down: ${down.map(s => s.name).join(', ')}.` : `All ${data.sites.length} sites are up.`;
  $('#checked').textContent = `Updated ${when(data.generated_at)}. Refreshes every minute.`;

  const groups = new Map();
  for (const s of data.sites) { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); }
  $('#groups').replaceChildren(...[...groups].map(([name, sites]) => {
    const g = el('section', 'group');
    g.append(el('h2', null, name));
    for (const s of sites) {
      const row = el('div', 'site');
      const head = el('div', 'head');
      const title = el('div');
      title.append(el('span', `dot ${s.up === true ? 'up' : s.up === false ? 'down' : ''}`), el('span', 'name', s.name), el('span', 'host', s.host));
      const state = s.up === true ? `Up · ${s.latency_ms} ms` : s.up === false ? `Down · ${s.error || `HTTP ${s.code}`}` : 'Not checked yet';
      head.append(title, el('span', `state ${s.up === true ? 'up' : s.up === false ? 'down' : 'none'}`, state));
      const foot = el('div', 'foot');
      foot.append(el('span', null, '90 days ago'), el('span', null, pct(s.uptime_90d)), el('span', null, 'today'));
      row.append(head, bars(s.days), foot);
      g.append(row);
    }
    return g;
  }));

  $('#outages').replaceChildren(...(data.outages.length ? data.outages.map(o => {
    const row = el('div', `outage${o.ongoing ? ' ongoing' : ''}`);
    row.append(el('span', 'what', `${o.name}: ${o.ongoing ? 'down now' : `down for ${minutes(o.minutes)}`} (${o.reason})`), el('span', 'when', `${when(o.started)}${o.ongoing ? '' : ` – ${when(o.last_failed)}`}`));
    return row;
  }) : [el('p', 'muted', 'No outages in the last 14 days.')]));
}

async function load() {
  try { render(await (await fetch('/status.json', { cache: 'no-store' })).json()); }
  catch { $('#summary').textContent = 'Could not load the status data. Retrying in a minute.'; }
}
load();
setInterval(load, 60_000);
