// DeltaVDevs cookie consent. Load it on every page, before t.js:
//   <script defer src="https://analytics.deltavdevs.com/consent.js" data-policy="/privacy"></script>
// Any element with data-dv-consent (e.g. a "Cookie settings" footer link) reopens it.
//
// There is one optional thing to agree to: the analytics cookie. Essential
// cookies (signing in, remembering preferences) don't need consent and are
// always on. The choice is kept in a first-party cookie, dv_consent, for 12
// months and re-asked when the policy version changes. Global Privacy Control
// is treated as "only essential" without asking. Every choice is also sent to
// analytics.deltavdevs.com/consent as a record that it was made.
(() => {
  const me = document.currentScript;
  if (!me || window.DeltaVConsent) return;
  const api = new URL(me.src).origin;
  const VERSION = '2026-09-26';
  const policy = me.dataset.policy || '/privacy';
  const gpc = navigator.globalPrivacyControl === true;
  const YEAR = 60 * 60 * 24 * 365;
  const secure = location.protocol === 'https:' ? '; Secure' : '';

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  // dv_consent = "analytics|essential,v:<version>,id:<uuid>" (t.js only looks for "analytics").
  function read() {
    const raw = (document.cookie.match(/(?:^|; )dv_consent=([^;]*)/) || [])[1];
    if (!raw) return null;
    let parts;
    try { parts = decodeURIComponent(raw).split(','); } catch { return null; }
    const get = key => (parts.find(p => p.startsWith(`${key}:`)) || '').slice(key.length + 1);
    return { analytics: parts.includes('analytics'), version: get('v'), id: get('id') };
  }
  function save(analytics) {
    const allowed = analytics && !gpc;
    const id = read()?.id || newId();
    const value = encodeURIComponent([allowed ? 'analytics' : 'essential', `v:${VERSION}`, `id:${id}`].join(','));
    document.cookie = `dv_consent=${value}; Max-Age=${YEAR}; Path=/; SameSite=Lax${secure}`;
    const body = JSON.stringify({ id, analytics: allowed, gpc, v: VERSION });
    try { if (!navigator.sendBeacon?.(`${api}/consent`, body)) throw new Error(); } catch {
      fetch(`${api}/consent`, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    }
    // t.js listens for this and adds or removes its visitor id straight away.
    dispatchEvent(new CustomEvent('dv-consent-change', { detail: { analytics: allowed } }));
  }

  // ---------- the banner ----------
  let host = null;
  const css = `
    :host { all: initial; }
    .box { position: fixed; z-index: 2147483647; left: 16px; right: 16px; bottom: 16px; max-width: 560px; margin: 0 auto;
      background: #111317; color: #e8e8ec; border: 1px solid #2a2d35; border-radius: 14px; padding: 18px 20px;
      box-shadow: 0 18px 48px rgba(0,0,0,.45); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    h2 { margin: 0 0 6px; font-size: 15px; font-weight: 700; color: #fff; }
    p { margin: 0 0 10px; color: #c4c6ce; }
    p.small { font-size: 12.5px; color: #9a9da8; }
    a { color: #7dd3c0; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    button { flex: 1 1 180px; font: 600 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 12px 14px; border-radius: 10px;
      border: 1px solid #3a3e48; background: #1d2027; color: #fff; cursor: pointer; }
    button:hover { background: #262a33; }
    button:focus-visible { outline: 2px solid #7dd3c0; outline-offset: 2px; }
    .current { font-size: 12.5px; color: #9a9da8; margin-top: 10px; }`;

  function close() { host?.remove(); host = null; }
  function open() {
    close();
    host = document.createElement('div');
    host.setAttribute('data-dv-consent-banner', '');
    const root = host.attachShadow({ mode: 'open' });
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
    catch { const style = document.createElement('style'); style.textContent = css; root.append(style); }
    const box = document.createElement('div');
    box.className = 'box'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'dv-consent-title'); box.setAttribute('aria-live', 'polite');
    const el = (tag, attrs, text) => { const n = document.createElement(tag); Object.assign(n, attrs); if (text) n.textContent = text; return n; };
    const current = read();
    const choose = analytics => () => { save(analytics); close(); };
    const link = el('a', { href: policy }, 'privacy policy');
    const intro = el('p', {});
    intro.append('We use one optional cookie to count returning visitors and see which pages get used. It stays off unless you allow it. Cookies that keep you signed in or remember your settings are always on. Details are in our ', link, '.');
    box.append(el('h2', { id: 'dv-consent-title' }, 'Cookies'), intro);
    if (gpc) box.append(el('p', { className: 'small' }, 'Your browser sends Global Privacy Control, so the analytics cookie stays off.'));
    const row = el('div', { className: 'row' });
    const allow = el('button', { type: 'button', disabled: gpc }, 'Allow analytics');
    const essential = el('button', { type: 'button' }, 'Only essential');
    allow.addEventListener('click', choose(true));
    essential.addEventListener('click', choose(false));
    row.append(allow, essential);
    box.append(row);
    if (current) box.append(el('p', { className: 'current' }, `Current choice: ${current.analytics && !gpc ? 'analytics allowed' : 'only essential'}.`));
    root.append(box);
    document.body.append(host);
    (current?.analytics ? allow : essential).focus({ preventScroll: true });
  }

  window.DeltaVConsent = { open, get: () => { const c = read(); return c ? { analytics: c.analytics && !gpc, version: c.version } : null; } };
  document.addEventListener('click', event => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-dv-consent]') : null;
    if (trigger) { event.preventDefault(); open(); }
  });

  function start() {
    const current = read();
    if (current && current.version === VERSION) return;
    // GPC means no, and there's nothing left to ask.
    if (gpc) { save(false); return; }
    open();
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
})();
