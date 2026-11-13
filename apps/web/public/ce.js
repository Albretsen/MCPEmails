/*
 * MCPEmails client events (2026-11-13). Loaded async from app/layout.js.
 *
 * Reports what real browsers do on the pages where people buy, to
 * /api/analytics/client-event (public.client_events): script errors, failed
 * script loads, buy and contact clicks, buy clicks that never left the page,
 * and one "page" event saying whether the React app hydrated.
 *
 * Deliberately standalone (no React, no imports) so it still reports when the
 * app bundle itself fails. Invisible by design: no DOM changes, no console
 * output, passive listeners, navigator.sendBeacon only, every path guarded.
 * Anonymous: no ids, no cookies read, no query strings; the server masks again.
 */
(function () {
  try {
    if (window.__mcpeCe) return;
    window.__mcpeCe = 1;
    var nav = window.navigator;
    if (!nav || typeof nav.sendBeacon !== 'function') return;
    if (nav.webdriver) return;

    var URL_ = '/api/analytics/client-event';
    var MAX = 20;
    var sent = 0;
    var seen = {};
    var BUY_PAGE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:dashboard|pricing|signup|login|onboarding|upgrade|for\/business|u\/)/i;

    function path() {
      return String(location.pathname || '/').slice(0, 200);
    }
    function base(kind) {
      return {
        k: kind,
        p: path(),
        w: window.innerWidth || 0,
        g: String((document.documentElement && document.documentElement.lang) || '').slice(0, 5)
      };
    }
    function send(ev) {
      try {
        if (sent >= MAX) return;
        var key = ev.k + '|' + (ev.m || '') + '|' + (ev.s || '') + '|' + (ev.t || '');
        if (ev.k !== 'buy' && ev.k !== 'contact' && seen[key]) return;
        seen[key] = 1;
        sent++;
        var blob = new Blob([JSON.stringify({ e: [ev] })], { type: 'text/plain' });
        nav.sendBeacon(URL_, blob);
      } catch (_) {}
    }
    function onBuyPage() {
      return BUY_PAGE.test(path());
    }

    // ── Errors ──────────────────────────────────────────────────────────
    window.addEventListener('error', function (e) {
      try {
        if (!onBuyPage()) return;
        var t = e && e.target;
        if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
          var ev = base('resource');
          ev.s = t.src || t.href || '';
          send(ev);
          return;
        }
        var er = base('error');
        er.m = String((e && e.message) || '').slice(0, 400);
        er.s = String((e && e.filename) || '').slice(0, 300);
        er.l = (e && e.lineno) || 0;
        send(er);
      } catch (_) {}
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
      try {
        if (!onBuyPage()) return;
        var r = e && e.reason;
        var ev = base('rejection');
        ev.m = String((r && (r.message || r)) || '').slice(0, 400);
        send(ev);
      } catch (_) {}
    });

    // ── Clicks ──────────────────────────────────────────────────────────
    function planFromHref(href) {
      var m = /(?:[?&]|%3F|%26)plan(?:=|%3D)(personal|solo|pro)/i.exec(href);
      if (!m) return null;
      var p = m[1].toLowerCase();
      return p === 'solo' ? 'pro' : p === 'pro' ? 'business' : 'personal';
    }
    function planFromText(text) {
      if (/\bBusiness\b/.test(text)) return 'business';
      if (/\bPro\b/.test(text)) return 'pro';
      if (/\bPersonal\b/.test(text)) return 'personal';
      return null;
    }
    function classify(el) {
      var href = el.getAttribute('href') || '';
      if (/\/api\/stripe\/checkout/.test(href)) {
        if (/product=personal_pass/.test(href)) return ['buy', 'pass'];
        return ['buy', planFromHref(href) || 'checkout_link'];
      }
      if (/redirect=%2Fapi%2Fstripe%2Fcheckout/i.test(href)) return ['buy', planFromHref(href) || 'signup_checkout'];
      if (/^\/u\//.test(href)) return ['buy', 'chat_link'];
      if (/^mailto:/i.test(href)) return ['contact', 'mailto'];
      if (/\/(?:dashboard\/)?help\b|\/support\b/.test(href)) return ['contact', 'help'];
      if (el.tagName === 'BUTTON' && /^\/dashboard/.test(path())) {
        var text = String(el.textContent || '').replace(/\s+/g, ' ').slice(0, 80);
        var plan = planFromText(text);
        if (plan && !/compare|see plans|cancel|downgrade|manage/i.test(text)) return ['buy', plan];
      }
      return null;
    }

    var left = false;
    window.addEventListener('pagehide', function () { left = true; });

    document.addEventListener('click', function (e) {
      try {
        var t = e.target;
        var el = t && t.closest ? t.closest('a,button') : null;
        if (!el) return;
        var c = classify(el);
        if (!c) return;
        var ev = base(c[0]);
        ev.t = c[1];
        send(ev);
        if (c[0] !== 'buy') return;
        var from = location.href;
        var at = Date.now();
        setTimeout(function () {
          try {
            if (left || location.href !== from || document.visibilityState !== 'visible') return;
            var st = base('buy_stalled');
            st.t = c[1];
            st.ms = Date.now() - at;
            send(st);
          } catch (_) {}
        }, 8000);
      } catch (_) {}
    }, { capture: true, passive: true });

    // ── Did the app hydrate? One "page" event per load of a buy page ────
    function hydrated() {
      try {
        var nodes = [document, document.documentElement, document.body];
        for (var i = 0; i < nodes.length; i++) {
          if (!nodes[i]) continue;
          var keys = Object.keys(nodes[i]);
          for (var j = 0; j < keys.length; j++) {
            if (keys[j].indexOf('__react') === 0) return true;
          }
        }
      } catch (_) {}
      return false;
    }
    function pageCheck() {
      try {
        if (!onBuyPage()) return;
        var ev = base('page');
        ev.h = hydrated();
        send(ev);
      } catch (_) {}
    }
    function later() { setTimeout(pageCheck, 5000); }
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later);
  } catch (_) {}
})();
