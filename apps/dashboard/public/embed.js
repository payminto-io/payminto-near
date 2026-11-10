/*
 * Payminto drop-in checkout. No build step, no dependencies.
 *
 *   <script src="https://pay.example.com/embed.js" defer></script>
 *   <button data-payminto-link="coffee-5usd">Pay</button>
 *
 * A click on any element with data-payminto-link (a payment link's slug) or data-payminto-payment (a payment id your
 * server created) opens the hosted checkout in a centered popup. On a phone, or when the browser blocks the popup, it
 * opens in the same tab. The element then receives a "payminto:payment" event on every state change and a
 * "payminto:paid" event once paid, with event.detail = { id, status }. These events are a convenience for your page:
 * fulfil orders from the signed webhook, which is the source of truth.
 */
(function () {
  "use strict";
  if (window.__paymintoEmbed) return;

  var me = document.currentScript || document.querySelector('script[src$="/embed.js"]');
  var base = null;
  try {
    base = me && (me.getAttribute("data-payminto-base") || new URL(me.src, window.location.href).origin);
  } catch {
    base = null;
  }
  if (!base) return;

  var SAFE = /^[A-Za-z0-9_-]{1,80}$/;
  var SELECTOR = "[data-payminto-link],[data-payminto-payment]";
  var api = {
    /** Same-tab navigation; a separate function so a page can observe it. */
    go: function (url) {
      window.location.assign(url);
    },
  };
  window.__paymintoEmbed = api;

  /** Popups and the element that opened each, so a message reaches the right button. */
  var opened = [];

  function checkoutUrl(el) {
    var slug = el.getAttribute("data-payminto-link");
    var id = el.getAttribute("data-payminto-payment");
    if (slug && SAFE.test(slug)) return base + "/l/" + encodeURIComponent(slug);
    if (id && SAFE.test(id)) return base + "/pay/" + encodeURIComponent(id);
    return null;
  }

  function small() {
    return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px), (pointer: coarse)").matches;
  }

  function openCheckout(el) {
    var url = checkoutUrl(el);
    if (!url) return false;
    if (small()) {
      api.go(url);
      return true;
    }
    var w = 480;
    var h = Math.min(820, (window.screen && window.screen.availHeight) || 820);
    var left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || w) - w) / 2);
    var top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || h) - h) / 2);
    var features = "popup=yes,width=" + w + ",height=" + h + ",left=" + Math.round(left) + ",top=" + Math.round(top);
    var popup = window.open(url + "#payminto-origin=" + encodeURIComponent(window.location.origin), "payminto-checkout", features);
    if (!popup) {
      api.go(url);
      return true;
    }
    try {
      popup.focus();
    } catch {
      /* some browsers refuse focus() on a new popup */
    }
    opened = opened.filter(function (o) {
      return o.popup !== popup && !o.popup.closed;
    });
    opened.push({ popup: popup, el: el });
    return true;
  }

  document.addEventListener("click", function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    var el = ev.target && ev.target.closest ? ev.target.closest(SELECTOR) : null;
    if (!el) return;
    // Let a new-tab click on a link do what the person asked for.
    if (el.tagName === "A" && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) return;
    if (openCheckout(el)) ev.preventDefault();
  });

  window.addEventListener("message", function (ev) {
    if (ev.origin !== base) return;
    var d = ev.data;
    if (!d || d.type !== "payminto:payment" || typeof d.id !== "string" || typeof d.status !== "string") return;
    var hit = null;
    for (var i = 0; i < opened.length; i++) if (opened[i].popup === ev.source) hit = opened[i];
    if (!hit) return;
    var detail = { id: d.id, status: d.status };
    hit.el.dispatchEvent(new CustomEvent("payminto:payment", { bubbles: true, detail: detail }));
    if (d.status === "paid" || d.status === "overpaid") hit.el.dispatchEvent(new CustomEvent("payminto:paid", { bubbles: true, detail: detail }));
  });
})();
