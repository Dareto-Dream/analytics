// DeltaVDevs analytics. Load with:
//   <script defer src="https://analytics.deltavdevs.com/t.js"></script>
// Add data-cookies="off" to never set a cookie (referrer and page counts only).
//
// Without consent this sends the page, the referrer and UTM tags, and no ids.
// With consent (the site's banner sets dv_consent to include "analytics") it
// also keeps a first-party visitor id (dv_vid, 13 months) and a per-tab
// session id. Global Privacy Control always counts as no.
(() => {
  const me = document.currentScript;
  if (!me) return;
  const api = new URL(me.src).origin;
  const cookiesAllowed = me.dataset.cookies !== 'off';
  const MONTHS_13 = 60 * 60 * 24 * 395;

  const cookie = name => (document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`)) || [])[1];
  const consented = () => {
    if (!cookiesAllowed || navigator.globalPrivacyControl === true) return false;
    try { return decodeURIComponent(cookie('dv_consent') || '').split(',').includes('analytics'); } catch { return false; }
  };
  const id = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  const secure = location.protocol === 'https:' ? '; Secure' : '';

  function ids() {
    if (!consented()) {
      // Consent withdrawn (or never given): make sure nothing is left behind.
      if (cookie('dv_vid')) document.cookie = `dv_vid=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
      try { sessionStorage.removeItem('dv_sid'); } catch {}
      return {};
    }
    let v = cookie('dv_vid');
    if (!/^[0-9a-f-]{36}$/.test(v || '')) v = id();
    document.cookie = `dv_vid=${v}; Max-Age=${MONTHS_13}; Path=/; SameSite=Lax${secure}`;
    let s;
    try { s = sessionStorage.getItem('dv_sid') || id(); sessionStorage.setItem('dv_sid', s); } catch {}
    return s ? { v, s } : { v };
  }

  function send(payload) {
    const body = JSON.stringify(payload);
    try { if (navigator.sendBeacon && navigator.sendBeacon(`${api}/e`, body)) return; } catch {}
    fetch(`${api}/e`, { method: 'POST', body, keepalive: true, mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  }

  let last = null;
  function pageview() {
    if (location.href === last) return;
    const referrer = last || document.referrer;
    last = location.href;
    send({ t: 'pv', u: location.href, r: referrer, ti: document.title.slice(0, 200), ...ids() });
  }

  // Single-page apps (Next.js, Inertia) change pages with pushState.
  const push = history.pushState;
  history.pushState = function (...args) { const out = push.apply(this, args); setTimeout(pageview, 0); return out; };
  addEventListener('popstate', () => setTimeout(pageview, 0));

  // Links that leave this site.
  document.addEventListener('click', event => {
    const a = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!a) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || url.host === location.host) return;
    send({ t: 'out', u: location.href, to: url.href, ...ids() });
  }, { capture: true });

  // The consent banner fires this after a choice, so a withdrawal clears ids right away.
  addEventListener('dv-consent-change', () => ids());

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pageview); else pageview();
})();
