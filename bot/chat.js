// Chat UI for the bakery bot demo. All ordering logic lives in bot-core.js.
(function () {
  "use strict";
  var Bot = window.BakeryBot;
  var root = document.documentElement;
  var ORDERS_KEY = "bb-demo-orders";
  var HANDOFF_KEY = "bb-demo-handoffs";
  var THEME_KEY = "sg-theme"; // shared with the portfolio page

  var log = document.getElementById("log");
  var chips = document.getElementById("chips");
  var form = document.getElementById("composer");
  var input = document.getElementById("msg");
  var ordersEl = document.getElementById("orders");
  var handoffsEl = document.getElementById("handoffs");
  var countEl = document.getElementById("order-count");
  var statusEl = document.getElementById("status");

  var session = Bot.createSession();
  var busy = Promise.resolve();
  var orders = load(ORDERS_KEY);
  var handoffs = load(HANDOFF_KEY);

  // ---- storage (may be unavailable: private mode, blocked site data)
  function load(key) {
    try { var v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* in-memory only */ }
  }

  // ---- rendering helpers
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // WhatsApp-style formatting on already-escaped text: *bold* and links.
  function format(text) {
    var html = esc(text);
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,:;!?)])/g, "$1<b>$2</b>");
    html = html.replace(/(upi:\/\/pay\?[^\s<]+)/g, '<a href="$1">$1</a>');
    return html;
  }
  function clock(ms) {
    var d = new Date(ms);
    var h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "am" : "pm");
  }
  function addBubble(text, who) {
    var el = document.createElement("div");
    el.className = "msg " + who;
    el.innerHTML = format(text) + '<span class="meta">' + clock(Date.now()) +
      (who === "out" ? '<span class="tick" aria-label="read">✓✓</span>' : "") + "</span>";
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function setChips(list) {
    chips.innerHTML = "";
    (list || []).forEach(function (label) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", function () { send(label); });
      chips.appendChild(b);
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- conversation
  function send(text) {
    text = String(text || "").trim();
    if (!text) return busy;
    addBubble(text, "out");
    var result = Bot.handleMessage(session, text, { now: Date.now() });
    session = result.state;
    handleEvents(result.events);
    busy = busy.then(function () {
      setChips([]);
      statusEl.textContent = "typing…";
      var typing = document.createElement("div");
      typing.className = "typing";
      typing.setAttribute("aria-label", "Bakery is typing");
      typing.innerHTML = "<i></i><i></i><i></i>";
      log.appendChild(typing);
      log.scrollTop = log.scrollHeight;
      return wait(350).then(function () {
        typing.remove();
        var chain = Promise.resolve();
        result.replies.forEach(function (r, i) {
          chain = chain.then(function () { addBubble(r, "in"); return i < result.replies.length - 1 ? wait(120) : null; });
        });
        return chain.then(function () {
          statusEl.textContent = "online · replies instantly";
          setChips(result.hints);
        });
      });
    });
    return busy;
  }

  function handleEvents(events) {
    events.forEach(function (ev) {
      if (ev.type === "order_confirmed") { orders.unshift(ev.order); save(ORDERS_KEY, orders); }
      if (ev.type === "handoff") { handoffs.unshift({ at: ev.at, step: ev.step }); save(HANDOFF_KEY, handoffs); }
    });
    if (events.length) renderOwner();
  }

  // ---- owner view
  function renderOwner() {
    countEl.textContent = String(orders.length);
    if (handoffs.length) {
      handoffsEl.hidden = false;
      handoffsEl.innerHTML = "<b>" + handoffs.length + " chat" + (handoffs.length > 1 ? "s" : "") +
        " asked for a human.</b> Latest at " + esc(clock(handoffs[0].at)) + ". In a live setup the owner gets a WhatsApp alert and the bot pauses for that number.";
    } else {
      handoffsEl.hidden = true;
      handoffsEl.innerHTML = "";
    }
    if (!orders.length) {
      ordersEl.innerHTML = '<p class="empty">No orders yet. Place one in the chat and it appears here.</p>';
      return;
    }
    ordersEl.innerHTML = orders.map(function (o) {
      var where = o.fulfilment === "delivery"
        ? "Delivery, " + esc(o.area) + " (fee " + esc(Bot.inr(o.deliveryFee)) + ")<br>" + esc(o.address)
        : "Pickup";
      return '<article class="order">' +
        '<div class="order-top"><span class="order-id">' + esc(o.id) + '</span><span class="order-total">' + esc(Bot.inr(o.total)) + "</span></div>" +
        "<dl>" +
        "<dt>Cake</dt><dd>" + esc(o.cake) + ", " + esc(o.size) + " × " + esc(o.qty) + "</dd>" +
        "<dt>When</dt><dd>" + esc(o.date) + ", " + esc(o.slot) + "</dd>" +
        "<dt>Message</dt><dd>" + (o.message ? "“" + esc(o.message) + "”" : "none") + "</dd>" +
        "<dt>How</dt><dd>" + where + "</dd>" +
        "<dt>Advance</dt><dd>" + esc(Bot.inr(o.advance)) + " (balance " + esc(Bot.inr(o.balance)) + ")</dd>" +
        "</dl>" +
        '<span class="status">' + esc(o.status) + "</span>" +
        "</article>";
    }).join("");
  }

  // ---- wiring
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = input.value;
    input.value = "";
    send(v);
    input.focus();
  });

  document.getElementById("reset-chat").addEventListener("click", function () {
    session = Bot.createSession();
    [].slice.call(log.querySelectorAll(".msg, .typing")).forEach(function (n) { n.remove(); });
    setChips(["Hi", "Menu"]);
    input.focus();
  });

  document.getElementById("clear-orders").addEventListener("click", function () {
    orders = []; handoffs = [];
    save(ORDERS_KEY, orders); save(HANDOFF_KEY, handoffs);
    renderOwner();
  });

  var tabChat = document.getElementById("tab-chat");
  var tabOwner = document.getElementById("tab-owner");
  function showTab(owner) {
    document.body.classList.toggle("show-owner", owner);
    tabChat.setAttribute("aria-selected", String(!owner));
    tabOwner.setAttribute("aria-selected", String(owner));
  }
  tabChat.addEventListener("click", function () { showTab(false); });
  tabOwner.addEventListener("click", function () { showTab(true); });

  // Theme: follow the system unless the visitor picks one.
  try {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (e) {}
  var themeBtn = document.querySelector(".theme-toggle");
  themeBtn.addEventListener("click", function () {
    var cur = root.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });

  renderOwner();
  setChips(["Hi", "Menu"]);

  // Exposed for automated checks: window.bakeryDemo.send("hi") returns a promise.
  window.bakeryDemo = { send: send, get state() { return session; }, get orders() { return orders.slice(); } };
})();
