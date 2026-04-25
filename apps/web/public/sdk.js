/* eslint-disable */
/**
 * Logistics behavior tracker — drop-in JS SDK for merchant storefronts.
 *
 * Usage:
 *   <script async src="https://logistics.example.com/sdk.js"
 *           data-tracking-key="pub_xxxxxxxxxxxx"
 *           data-collector="https://api.logistics.example.com/track/collect"></script>
 *
 * Public API (window.LogisticsTracker):
 *   identify({ phone, email })   // call on checkout submit
 *   track(eventName, props?)     // custom event
 *   reset()                      // clear session (logout)
 *
 * Privacy:
 *   - No third-party cookies; uses localStorage + sessionStorage only.
 *   - No raw IP from the client (server fills it in).
 *   - PII (phone/email) is sent only when the merchant calls identify() or
 *     submits checkout — and only over the configured https collector.
 *
 * Reliability:
 *   - In-memory queue + 2s flush interval + sendBeacon on pagehide.
 *   - Per-event clientEventId for idempotent retries.
 *   - Retry with exponential backoff (1s → 2s → 4s, max 3 attempts).
 *   - Hard cap of 200 buffered events to bound memory on long sessions.
 */
(function (window, document) {
  if (window.LogisticsTracker && window.LogisticsTracker.__loaded) return;

  var script =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName("script");
      return s[s.length - 1];
    })();
  if (!script) return;

  var TRACKING_KEY = script.getAttribute("data-tracking-key");
  var COLLECTOR =
    script.getAttribute("data-collector") ||
    (function () {
      try {
        var u = new URL(script.src);
        return u.origin + "/track/collect";
      } catch (_e) {
        return null;
      }
    })();
  if (!TRACKING_KEY || !COLLECTOR) {
    if (window.console) console.warn("[logistics] tracking key or collector missing");
    return;
  }

  var ANON_KEY = "_lg_anon";
  var SESSION_KEY = "_lg_sess";
  var SESSION_TS = "_lg_sess_ts";
  var REPEAT_KEY = "_lg_repeat";
  var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle = new session
  var MAX_BUFFER = 200;
  var FLUSH_INTERVAL_MS = 2000;

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      try {
        return window.crypto.randomUUID();
      } catch (_e) {}
    }
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function safeLocal(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
      return value;
    } catch (_e) {
      return null;
    }
  }
  function safeSession(key, value) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key);
      window.sessionStorage.setItem(key, value);
      return value;
    } catch (_e) {
      return null;
    }
  }

  function now() {
    return Date.now();
  }

  function getAnonId() {
    var v = safeLocal(ANON_KEY);
    if (v) return v;
    var fresh = uuid();
    safeLocal(ANON_KEY, fresh);
    return fresh;
  }

  function getSessionId() {
    var sid = safeSession(SESSION_KEY);
    var lastTs = parseInt(safeSession(SESSION_TS) || "0", 10);
    var idle = now() - lastTs;
    if (!sid || idle > SESSION_TIMEOUT_MS) {
      sid = uuid();
      safeSession(SESSION_KEY, sid);
    }
    safeSession(SESSION_TS, String(now()));
    return sid;
  }

  function isRepeat() {
    var prev = safeLocal(REPEAT_KEY);
    safeLocal(REPEAT_KEY, "1");
    return prev === "1";
  }

  function detectDevice() {
    var ua = navigator.userAgent || "";
    var type = /Mobi|Android|iPhone|iPad|iPod/i.test(ua)
      ? /iPad|Tablet/i.test(ua)
        ? "tablet"
        : "mobile"
      : "desktop";
    var os = /Windows/.test(ua)
      ? "Windows"
      : /Mac OS/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad|iPod/.test(ua)
            ? "iOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Other";
    var browser = /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Other";
    return {
      type: type,
      os: os,
      browser: browser,
      viewport: window.innerWidth + "x" + window.innerHeight,
      language: navigator.language || null,
    };
  }

  function getCampaign() {
    try {
      var u = new URL(window.location.href);
      return {
        source: u.searchParams.get("utm_source") || undefined,
        medium: u.searchParams.get("utm_medium") || undefined,
        name: u.searchParams.get("utm_campaign") || undefined,
        term: u.searchParams.get("utm_term") || undefined,
        content: u.searchParams.get("utm_content") || undefined,
      };
    } catch (_e) {
      return {};
    }
  }

  var anonId = getAnonId();
  var sessionId = getSessionId();
  var device = detectDevice();
  var campaign = getCampaign();
  var repeat = isRepeat();
  var identity = { phone: null, email: null };
  var buffer = [];
  var flushTimer = null;
  var sentScrollMilestones = {};
  var sessionStartTs = now();
  var emitted_session_start = false;

  function baseEvent(type, properties) {
    return {
      type: type,
      clientEventId: uuid(),
      sessionId: sessionId,
      anonId: anonId,
      url: window.location.href,
      path: window.location.pathname,
      referrer: document.referrer || null,
      campaign: campaign,
      device: device,
      properties: properties || {},
      phone: identity.phone || undefined,
      email: identity.email || undefined,
      occurredAt: new Date().toISOString(),
      repeatVisitor: repeat,
    };
  }

  function enqueue(event) {
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push(event);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  function flush(useBeacon) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buffer.length === 0) return Promise.resolve();
    var batch = buffer.slice();
    buffer = [];
    var body = JSON.stringify({ trackingKey: TRACKING_KEY, events: batch });

    if (useBeacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: "application/json" });
        var ok = navigator.sendBeacon(COLLECTOR, blob);
        if (ok) return Promise.resolve();
      } catch (_e) {}
    }

    return sendWithRetry(body, batch, 0);
  }

  function sendWithRetry(body, batch, attempt) {
    return fetch(COLLECTOR, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: body,
    })
      .then(function (res) {
        if (!res.ok && attempt < 3) {
          return wait(Math.pow(2, attempt) * 1000).then(function () {
            return sendWithRetry(body, batch, attempt + 1);
          });
        }
      })
      .catch(function () {
        if (attempt < 3) {
          return wait(Math.pow(2, attempt) * 1000).then(function () {
            return sendWithRetry(body, batch, attempt + 1);
          });
        }
        // Final failure — restore to buffer so the next flush retries once.
        for (var i = 0; i < batch.length && buffer.length < MAX_BUFFER; i++) {
          buffer.push(batch[i]);
        }
      });
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function track(type, properties) {
    enqueue(baseEvent(type, properties));
  }

  function ensureSessionStart() {
    if (emitted_session_start) return;
    emitted_session_start = true;
    track("session_start", { repeat: repeat });
  }

  function pageView() {
    ensureSessionStart();
    track("page_view", { title: document.title });
  }

  function identify(traits) {
    if (!traits) return;
    if (traits.phone) identity.phone = String(traits.phone);
    if (traits.email) identity.email = String(traits.email).toLowerCase();
    track("identify", { phone: identity.phone, email: identity.email });
    flush(false);
  }

  function reset() {
    identity.phone = null;
    identity.email = null;
    sessionId = uuid();
    safeSession(SESSION_KEY, sessionId);
    safeSession(SESSION_TS, String(now()));
    sessionStartTs = now();
    emitted_session_start = false;
  }

  function attachAutomatic() {
    document.addEventListener(
      "click",
      function (e) {
        var target = e.target;
        if (!target) return;
        var node = target;
        while (node && node !== document.body && node.nodeType === 1) {
          var n = node;
          if (n.tagName === "A" || n.tagName === "BUTTON" || n.dataset.lgEvent) {
            track("click", {
              tag: n.tagName,
              id: n.id || undefined,
              cls: n.className && typeof n.className === "string" ? n.className.slice(0, 80) : undefined,
              text: (n.innerText || "").slice(0, 80),
              href: n.href || undefined,
              data: n.dataset.lgEvent || undefined,
            });
            break;
          }
          node = n.parentNode;
        }
      },
      true,
    );

    var SCROLL_MILESTONES = [25, 50, 75, 100];
    function onScroll() {
      var doc = document.documentElement;
      var height = doc.scrollHeight - doc.clientHeight;
      if (height <= 0) return;
      var depth = Math.round(((window.scrollY || doc.scrollTop) / height) * 100);
      for (var i = 0; i < SCROLL_MILESTONES.length; i++) {
        var m = SCROLL_MILESTONES[i];
        if (depth >= m && !sentScrollMilestones[m]) {
          sentScrollMilestones[m] = true;
          track("scroll", { depth: m });
        }
      }
    }
    var scrollPending = false;
    window.addEventListener("scroll", function () {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(function () {
        onScroll();
        scrollPending = false;
      });
    });

    function pagehide() {
      track("session_end", { durationMs: now() - sessionStartTs });
      flush(true);
    }
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("beforeunload", pagehide);

    document.addEventListener(
      "submit",
      function (e) {
        var form = e.target;
        if (!form || form.tagName !== "FORM") return;
        if (form.dataset.lgCheckout === "submit") {
          var phoneEl = form.querySelector('[name="phone"]');
          var emailEl = form.querySelector('[name="email"]');
          var phone = phoneEl && phoneEl.value;
          var email = emailEl && emailEl.value;
          if (phone || email) identify({ phone: phone, email: email });
          track("checkout_submit", {});
          flush(false);
        } else if (form.dataset.lgCheckout === "start") {
          track("checkout_start", {});
        }
      },
      true,
    );
  }

  attachAutomatic();
  ensureSessionStart();
  pageView();

  // Expose API.
  window.LogisticsTracker = {
    __loaded: true,
    track: track,
    identify: identify,
    pageView: pageView,
    reset: reset,
    flush: function () {
      return flush(false);
    },
    /** Hook for the merchant's product detail page. */
    productView: function (product) {
      track("product_view", product || {});
    },
    addToCart: function (product) {
      track("add_to_cart", product || {});
    },
    removeFromCart: function (product) {
      track("remove_from_cart", product || {});
    },
    checkoutStart: function (cart) {
      track("checkout_start", cart || {});
    },
    sessionId: sessionId,
    anonId: anonId,
  };
})(window, document);
