/*
 * Butterbird Home Bakery (DEMO) - WhatsApp ordering bot, core logic.
 *
 * Pure state machine: no DOM, no network, no clock reads, no randomness.
 * The caller passes the current time in opts.now (milliseconds since epoch).
 *
 *   var s = BakeryBot.createSession();
 *   var r = BakeryBot.handleMessage(s, "hi", { now: Date.now() });
 *   r.state    -> new session state (JSON-serialisable; the input is never mutated)
 *   r.replies  -> array of WhatsApp-style text messages to send back
 *   r.hints    -> suggested quick replies for the current step (UI only)
 *   r.events   -> [{ type: "order_confirmed", order }, { type: "handoff", ... }]
 *
 * Loads in Node (module.exports), the browser (window.BakeryBot) and the
 * n8n Code node (see build-n8n.js, which wraps this file unchanged).
 * The bakery, its address and the UPI ID are fictional.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.BakeryBot = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---------------------------------------------------------------- config
  var BAKERY = {
    name: "Butterbird Home Bakery",
    label: "Butterbird Home Bakery (demo)",
    pickupAddress: "HSR Layout Sector 2, Bengaluru (fictional demo address)",
    // Not a real UPI ID: the handle "notreal" belongs to no bank.
    upiVpa: "butterbird.demo@notreal",
    upiName: "Butterbird Home Bakery DEMO",
    orderPrefix: "BB"
  };

  var MENU = [
    { id: "choc", name: "Chocolate Truffle", keys: ["chocolate", "choco", "truffle", "choc"], prices: [550, 1000, 1900] },
    { id: "rv", name: "Red Velvet", keys: ["red velvet", "velvet", "redvelvet", "rv"], prices: [600, 1100, 2100] },
    { id: "pine", name: "Pineapple Fresh Cream", keys: ["pineapple", "pine"], prices: [450, 850, 1600] },
    { id: "rasm", name: "Rasmalai Fusion", keys: ["rasmalai", "ras malai", "rasmalai fusion"], prices: [650, 1200, 2300] },
    { id: "bf", name: "Eggless Black Forest", keys: ["black forest", "blackforest", "eggless", "forest"], prices: [500, 950, 1800] }
  ];
  var SIZES = [
    { kg: 0.5, label: "½ kg" },
    { kg: 1, label: "1 kg" },
    { kg: 2, label: "2 kg" }
  ];
  var SLOTS = [
    { id: 1, start: 11, label: "11 am – 1 pm" },
    { id: 2, start: 14, label: "2 – 4 pm" },
    { id: 3, start: 17, label: "5 – 7 pm" },
    { id: 4, start: 19, label: "7 – 9 pm" }
  ];
  var ZONES = [
    { id: "hsr", name: "HSR Layout", fee: 40, keys: ["hsr", "hsr layout"] },
    { id: "kora", name: "Koramangala", fee: 70, keys: ["koramangala", "kormangala", "koramangla", "kora"] },
    { id: "btm", name: "BTM Layout", fee: 90, keys: ["btm", "btm layout"] }
  ];
  var RULES = {
    sameDayCutoffHour: 11,   // same-day orders close at 11:00 IST
    leadTimeMinutes: 300,    // a same-day slot must start at least 5 h from now
    maxDaysAhead: 30,
    maxQty: 10,
    maxCakeMessage: 30,
    advanceShare: 0.5,       // 50% advance, rounded up to the next ₹10
    maxUnknown: 3
  };
  var IST_OFFSET_MIN = 330;
  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  var DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  var DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, single: 1 };

  // ---------------------------------------------------------------- helpers
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function norm(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[^a-z0-9½/.:\-\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function inr(n) {
    var s = String(Math.round(n));
    if (s.length <= 3) return "₹" + s;
    var last3 = s.slice(-3), rest = s.slice(0, -3);
    return "₹" + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }

  function istNow(nowMs) {
    var d = new Date(nowMs + IST_OFFSET_MIN * 60000);
    return {
      y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
    };
  }
  function dayNumber(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
  function fromDayNumber(n) {
    var d = new Date(n * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  function isoOf(p) { return p.y + "-" + pad(p.m) + "-" + pad(p.d); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  function prettyDate(iso) {
    var p = iso.split("-").map(Number);
    var dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return DOW_LONG[dow] + " " + p[2] + " " + MONTHS[p[1] - 1].charAt(0).toUpperCase() + MONTHS[p[1] - 1].slice(1) + " " + p[0];
  }

  function parseNumber(t) {
    var m = t.match(/^(\d{1,3})$/);
    if (m) return parseInt(m[1], 10);
    if (Object.prototype.hasOwnProperty.call(NUM_WORDS, t)) return NUM_WORDS[t];
    return null;
  }

  // ---------------------------------------------------------------- parsers
  function parseItem(t) {
    var n = parseNumber(t);
    if (n !== null) return n >= 1 && n <= MENU.length ? MENU[n - 1] : null;
    var best = null, bestLen = 0;
    MENU.forEach(function (item) {
      item.keys.forEach(function (k) {
        if ((" " + t + " ").indexOf(" " + k + " ") !== -1 && k.length > bestLen) { best = item; bestLen = k.length; }
      });
    });
    return best;
  }

  // unitOnly: only accept answers that name a weight (used when sniffing a size
  // out of a menu reply such as "red velvet 1kg").
  function parseSize(t, unitOnly) {
    if (!unitOnly) {
      var n = parseNumber(t);
      if (n !== null) return n >= 1 && n <= SIZES.length ? SIZES[n - 1] : null;
    }
    if (/(^|\s)(half|½|1\/2|0?\.5)(\s|$)|half ?kg|½ ?kg|1\/2 ?kg|0?\.5 ?kgs?|500 ?(g|gm|gms|grams?)\b/.test(t)) return SIZES[0];
    if (/(^|\s)(1|one) ?(kg|kgs|kilo|kilos)\b|1000 ?(g|gm|grams?)\b/.test(t)) return SIZES[1];
    if (/(^|\s)(2|two) ?(kg|kgs|kilo|kilos)\b|2000 ?(g|gm|grams?)\b/.test(t)) return SIZES[2];
    return null;
  }

  function parseQty(t) {
    var s = t.replace(/\b(cakes?|nos?|pieces?|pcs|qty|quantity)\b/g, "").trim();
    var n = parseNumber(s);
    return n;
  }

  // Returns { iso } or { error } or null (not a date at all).
  function parseDate(t, nowMs) {
    var now = istNow(nowMs);
    var today = dayNumber(now.y, now.m, now.d);
    var target = null;

    if (/^(today|tonight|aaj)$/.test(t)) target = today;
    else if (/^(tomorrow|tmrw|tmr|tomorow|tommorow|kal)$/.test(t)) target = today + 1;
    else if (/^day after (tomorrow|tmrw)$/.test(t)) target = today + 2;
    else if (/^(yesterday)$/.test(t)) target = today - 1;

    if (target === null) {
      var wd = t.match(/^(this |next )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$/);
      if (wd) {
        var want = DOW.indexOf(wd[2].slice(0, 3));
        var cur = new Date(today * 86400000).getUTCDay();
        var diff = (want - cur + 7) % 7;
        if (wd[1] === "next " && diff === 0) diff = 7;
        target = today + diff;
      }
    }

    var y = null, m = null, d = null, explicitYear = false, mm;
    if (target === null) {
      if ((mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; explicitYear = true; }
      else if ((mm = t.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/))) {
        d = +mm[1]; m = +mm[2];
        if (mm[3]) { y = +mm[3]; if (y < 100) y += 2000; explicitYear = true; }
      } else if ((mm = t.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]{3,9})(?: (\d{4}))?$/))) {
        d = +mm[1]; m = MONTHS.indexOf(mm[2].slice(0, 3)) + 1;
        if (mm[3]) { y = +mm[3]; explicitYear = true; }
      } else if ((mm = t.match(/^([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/))) {
        m = MONTHS.indexOf(mm[1].slice(0, 3)) + 1; d = +mm[2];
        if (mm[3]) { y = +mm[3]; explicitYear = true; }
      }
      if (m === null) return null;
      if (m < 1) return null;
      if (!explicitYear) y = now.y;
      if (!validDate(y, m, d)) return { error: "That isn't a real date. Try something like *25/10* or *tomorrow*." };
      target = dayNumber(y, m, d);
      // "5/1" typed in October means next January, not ten months ago.
      if (!explicitYear && target < today - 60) {
        y += 1;
        if (!validDate(y, m, d)) return { error: "That isn't a real date. Try something like *25/10* or *tomorrow*." };
        target = dayNumber(y, m, d);
      }
    }

    if (target < today) return { error: "That date has already passed. Please send a date from today onwards." };
    if (target === today && now.minutes >= RULES.sameDayCutoffHour * 60) {
      return { error: "Same-day orders close at " + RULES.sameDayCutoffHour + " am, so the earliest we can do is *tomorrow*. Please send another date." };
    }
    if (target > today + RULES.maxDaysAhead) return { error: "We take orders up to " + RULES.maxDaysAhead + " days ahead. Please pick an earlier date." };
    return { iso: isoOf(fromDayNumber(target)), sameDay: target === today };
  }

  function slotAvailable(slot, dateIso, nowMs) {
    var now = istNow(nowMs);
    if (dateIso !== isoOf(now)) return true;
    return slot.start * 60 >= now.minutes + RULES.leadTimeMinutes;
  }
  function availableSlots(dateIso, nowMs) {
    return SLOTS.filter(function (s) { return slotAvailable(s, dateIso, nowMs); });
  }

  function parseSlot(t) {
    var n = parseNumber(t);
    if (n !== null && n >= 1 && n <= SLOTS.length) return SLOTS[n - 1];
    if (/morning|noon|lunch/.test(t)) return SLOTS[0];
    if (/afternoon/.test(t)) return SLOTS[1];
    if (/evening/.test(t)) return SLOTS[2];
    if (/night|dinner/.test(t)) return SLOTS[3];
    var m = t.match(/(\d{1,2})(?::\d{2})?\s*(am|pm)?/);
    if (!m) return null;
    var h = +m[1];
    if (m[2] === "pm" && h < 12) h += 12;
    else if (!m[2] && h >= 1 && h <= 9) h += 12; // "5" or "7" means evening
    for (var i = 0; i < SLOTS.length; i++) if (h >= SLOTS[i].start && h < SLOTS[i].start + 2) return SLOTS[i];
    return null;
  }

  function parseZone(t) {
    for (var i = 0; i < ZONES.length; i++) {
      for (var j = 0; j < ZONES[i].keys.length; j++) {
        if ((" " + t + " ").indexOf(" " + ZONES[i].keys[j] + " ") !== -1) return ZONES[i];
      }
    }
    return null;
  }

  function parseYesNo(t) {
    if (/^(y|yes|yeah|yep|ok|okay|confirm|confirmed|correct|haan|ha|sure|done|place order)$/.test(t)) return true;
    if (/^(n|no|nope|nah|wrong|change|edit)$/.test(t)) return false;
    return null;
  }

  function detectCommand(t) {
    if (/^(cancel|cancel order|cancel my order|stop|quit|exit)$/.test(t)) return "cancel";
    if (/^(back|go back|previous|undo|prev)$/.test(t)) return "back";
    if (/^(menu|show menu|see menu|start over|restart|new order|order|order cake|order a cake)$/.test(t)) return "menu";
    if (/^(talk to (a )?(human|person|someone|owner)|human|agent|real person|call me|speak to (a )?(human|person|someone|owner)|owner|help me human)$/.test(t)) return "human";
    if (/^(help|commands|\?)$/.test(t)) return "help";
    if (/^(hi+|hello+|hey+|hii+|namaste|namaskara|good (morning|afternoon|evening)|hola)$/.test(t)) return "greet";
    return null;
  }

  // ---------------------------------------------------------------- order maths
  function priceOf(cart) {
    var item = findItem(cart.itemId);
    var sizeIdx = sizeIndex(cart.sizeKg);
    var unit = item.prices[sizeIdx];
    var subtotal = unit * cart.qty;
    var fee = cart.fulfilment === "delivery" ? findZone(cart.zoneId).fee : 0;
    var total = subtotal + fee;
    var advance = Math.ceil((total * RULES.advanceShare) / 10) * 10;
    return { unit: unit, subtotal: subtotal, fee: fee, total: total, advance: advance, balance: total - advance };
  }
  function findItem(id) { for (var i = 0; i < MENU.length; i++) if (MENU[i].id === id) return MENU[i]; return null; }
  function findZone(id) { for (var i = 0; i < ZONES.length; i++) if (ZONES[i].id === id) return ZONES[i]; return null; }
  function findSlot(id) { for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].id === id) return SLOTS[i]; return null; }
  function sizeIndex(kg) { for (var i = 0; i < SIZES.length; i++) if (SIZES[i].kg === kg) return i; return -1; }
  function sizeLabel(kg) { var i = sizeIndex(kg); return i < 0 ? "" : SIZES[i].label; }

  function makeOrderId(nowMs) {
    var p = istNow(nowMs);
    var tail = (Math.floor(nowMs / 1000) % 46656).toString(36).toUpperCase();
    while (tail.length < 3) tail = "0" + tail;
    return BAKERY.orderPrefix + "-" + pad(p.m) + pad(p.d) + "-" + tail;
  }

  function upiLink(amount, orderId) {
    return "upi://pay?pa=" + encodeURIComponent(BAKERY.upiVpa) +
      "&pn=" + encodeURIComponent(BAKERY.upiName) +
      "&am=" + amount.toFixed(2) +
      "&cu=INR" +
      "&tn=" + encodeURIComponent("Advance " + orderId + " (demo)");
  }

  // ---------------------------------------------------------------- prompts
  function menuText() {
    var lines = ["*Our cakes* (prices for ½ kg / 1 kg / 2 kg)"];
    MENU.forEach(function (item, i) {
      lines.push((i + 1) + ". " + item.name + ": " + item.prices.map(inr).join(" / "));
    });
    lines.push("", "Reply with a number or a cake name, e.g. *2* or *red velvet 1kg*.");
    return lines.join("\n");
  }

  function prompt(state, nowMs) {
    var c = state.cart;
    switch (state.step) {
      case "MENU": return menuText();
      case "SIZE": {
        var item = findItem(c.itemId);
        return "Which size of *" + item.name + "*?\n" + SIZES.map(function (s, i) {
          return (i + 1) + ". " + s.label + ": " + inr(item.prices[i]);
        }).join("\n") + "\n\nReply 1, 2 or 3.";
      }
      case "QTY": return "How many cakes? Reply a number from 1 to " + RULES.maxQty + ".";
      case "DATE": return "For which date? Reply *tomorrow*, a day like *Saturday*, or a date like *25/10*.\nSame-day orders close at " + RULES.sameDayCutoffHour + " am.";
      case "SLOT": {
        var slots = availableSlots(c.date, nowMs);
        return "Pick a time slot for " + prettyDate(c.date) + ":\n" + slots.map(function (s) {
          return s.id + ". " + s.label;
        }).join("\n");
      }
      case "MESSAGE": return "What should we write on the cake? Up to " + RULES.maxCakeMessage + " characters, e.g. *Happy Birthday Asha*.\nReply *none* for no message.";
      case "FULFIL": return "Pickup or delivery?\n1. Pickup from " + BAKERY.pickupAddress + " (free)\n2. Delivery to " +
        ZONES.map(function (z) { return z.name + " (" + inr(z.fee) + ")"; }).join(", ");
      case "AREA": return "Which area?\n" + ZONES.map(function (z, i) { return (i + 1) + ". " + z.name + ": " + inr(z.fee); }).join("\n") +
        "\n\nWe only deliver to these three areas. Reply *pickup* to collect instead.";
      case "ADDRESS": return "Please send the delivery address: flat or house number, street and a landmark.";
      case "SUMMARY": return summaryText(state);
      case "PAYMENT": return paymentText(state);
      case "DONE": return "Your order *" + state.orderId + "* is confirmed. Reply *menu* to place another order.";
      case "HUMAN": return "The owner has been told and will reply here. Reply *menu* if you'd like to order with me in the meantime.";
      default: return "Reply *menu* to see our cakes.";
    }
  }

  function summaryText(state) {
    var c = state.cart, p = priceOf(c), item = findItem(c.itemId), slot = findSlot(c.slotId);
    var lines = [
      "*Order summary*",
      "• " + item.name + ", " + sizeLabel(c.sizeKg) + " × " + c.qty + " = " + inr(p.subtotal),
      "• Message on cake: " + (c.message ? "\"" + c.message + "\"" : "none"),
      c.fulfilment === "delivery"
        ? "• Delivery to " + findZone(c.zoneId).name + ": " + c.address + " (fee " + inr(p.fee) + ")"
        : "• Pickup from " + BAKERY.pickupAddress,
      "• " + prettyDate(c.date) + ", " + slot.label,
      "",
      "*Total: " + inr(p.total) + "*",
      "Advance to confirm (50%): " + inr(p.advance) + ". Balance " + inr(p.balance) + " on " + (c.fulfilment === "delivery" ? "delivery" : "pickup") + ".",
      "",
      "Reply *yes* to confirm, *back* to change something, or *cancel*."
    ];
    return lines.join("\n");
  }

  function paymentText(state) {
    var p = priceOf(state.cart);
    return [
      "*Advance payment: " + inr(p.advance) + "*",
      "Order ID: " + state.orderId,
      "Pay by UPI with this link:",
      upiLink(p.advance, state.orderId),
      "",
      "DEMO ONLY: " + BAKERY.upiVpa + " is not a real UPI ID. Do not try to pay.",
      "Reply *paid* once done, or *back* to review the order."
    ].join("\n");
  }

  function hintsFor(state, nowMs) {
    switch (state.step) {
      case "IDLE": return ["Hi", "Menu"];
      case "MENU": return ["1", "2", "Red velvet 1kg", "Talk to human"];
      case "SIZE": return ["1", "2", "3", "Back"];
      case "QTY": return ["1", "2", "Back"];
      case "DATE": return ["Tomorrow", "Saturday", "Today", "Back"];
      case "SLOT": return availableSlots(state.cart.date, nowMs).map(function (s) { return String(s.id); }).concat(["Back"]);
      case "MESSAGE": return ["Happy Birthday", "None", "Back"];
      case "FULFIL": return ["Pickup", "Delivery", "Back"];
      case "AREA": return ["HSR", "Koramangala", "BTM", "Pickup"];
      case "ADDRESS": return ["12, 4th Cross, near the park", "Back"];
      case "SUMMARY": return ["Yes", "Back", "Cancel"];
      case "PAYMENT": return ["Paid", "Back", "Cancel"];
      case "DONE": return ["Menu"];
      case "HUMAN": return ["Menu"];
      default: return [];
    }
  }

  // ---------------------------------------------------------------- engine
  function createSession() {
    return { step: "IDLE", cart: {}, history: [], orderId: null, unknown: 0, handoff: false, lastOrderId: null };
  }

  function go(state, next) {
    if (state.step !== next) state.history.push(state.step);
    state.step = next;
    state.unknown = 0;
  }

  function resetOrder(state) {
    state.cart = {};
    state.history = [];
    state.orderId = null;
    state.unknown = 0;
  }

  function handleMessage(prevState, text, opts) {
    var nowMs = opts && typeof opts.now === "number" ? opts.now : null;
    if (nowMs === null) throw new Error("handleMessage needs opts.now (milliseconds)");
    var state = clone(prevState && prevState.step ? prevState : createSession());
    var replies = [], events = [];
    var t = norm(text);
    var raw = String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    var cmd = detectCommand(t);

    function out() {
      return { state: state, replies: replies, hints: hintsFor(state, nowMs), events: events };
    }
    function say(s) { replies.push(s); }
    function reprompt(problem) {
      state.unknown += 1;
      if (problem) say(problem);
      say(prompt(state, nowMs));
      if (state.unknown >= RULES.maxUnknown) {
        say("Stuck? Reply *talk to human* and the owner will message you, or *cancel* to start over.");
      }
      return out();
    }

    // ---- global commands
    if (cmd === "cancel") {
      var had = Object.keys(state.cart).length > 0 && state.step !== "DONE";
      resetOrder(state);
      state.step = "IDLE";
      say(had ? "Order cancelled. Nothing has been charged." : "There's no order in progress.");
      say("Reply *menu* whenever you'd like to order.");
      return out();
    }
    if (cmd === "human") {
      state.handoff = true;
      if (state.step !== "HUMAN") state.history.push(state.step);
      state.step = "HUMAN";
      events.push({ type: "handoff", at: nowMs, step: state.history[state.history.length - 1] || "IDLE" });
      say("Okay, I've asked the owner to take over this chat. They usually reply between 9 am and 8 pm.");
      say("Reply *menu* if you'd like to order with me in the meantime.");
      return out();
    }
    if (cmd === "help") {
      say("You can reply *menu* to see cakes, *back* to change your last answer, *cancel* to stop, or *talk to human* to reach the owner.");
      if (state.step !== "IDLE") say(prompt(state, nowMs));
      return out();
    }
    if (cmd === "menu") {
      var midOrder = state.step !== "IDLE" && state.step !== "DONE" && state.step !== "HUMAN" && state.step !== "MENU";
      resetOrder(state);
      state.step = "MENU";
      state.handoff = false;
      if (midOrder) say("Starting a fresh order.");
      say(menuText());
      return out();
    }
    if (cmd === "back") {
      if (state.step === "IDLE" || state.step === "DONE") {
        say("There's nothing to go back to. Reply *menu* to start an order.");
        return out();
      }
      if (!state.history.length || state.history[state.history.length - 1] === "IDLE") {
        state.history = [];
        state.step = "MENU";
        say("This is the first step.");
        say(menuText());
        return out();
      }
      state.step = state.history.pop();
      state.unknown = 0;
      say(prompt(state, nowMs));
      return out();
    }
    if (cmd === "greet") {
      if (state.step === "IDLE" || state.step === "DONE" || state.step === "HUMAN") {
        resetOrder(state);
        state.handoff = false;
        state.step = "MENU";
        say("Hello! Welcome to *" + BAKERY.label + "*. I take cake orders here, any time of day.");
        say(menuText());
        return out();
      }
      say("Hello again! We're partway through your order.");
      say(prompt(state, nowMs));
      return out();
    }

    // ---- step handlers
    switch (state.step) {
      case "IDLE":
      case "DONE":
      case "HUMAN": {
        var direct = parseItem(t);
        if (direct && parseNumber(t) === null) {
          resetOrder(state);
          state.handoff = false;
          state.step = "MENU";
          return handleItem(direct);
        }
        if (state.step === "DONE") { say(prompt(state, nowMs)); return out(); }
        if (state.step === "HUMAN") { say(prompt(state, nowMs)); return out(); }
        resetOrder(state);
        state.step = "MENU";
        say("Hello! Welcome to *" + BAKERY.label + "*. I take cake orders here, any time of day.");
        say(menuText());
        return out();
      }

      case "MENU": {
        var item = parseItem(t);
        if (!item) return reprompt("Sorry, I couldn't find that cake.");
        return handleItem(item);
      }

      case "SIZE": {
        var size = parseSize(t, false);
        if (!size) return reprompt("Please pick one of the sizes below.");
        state.cart.sizeKg = size.kg;
        go(state, "QTY");
        say(prompt(state, nowMs));
        return out();
      }

      case "QTY": {
        var q = parseQty(t);
        if (q === null || q < 1) return reprompt("Please reply with a number, like *1* or *2*.");
        if (q > RULES.maxQty) return reprompt("For more than " + RULES.maxQty + " cakes, reply *talk to human* and the owner will quote you.");
        state.cart.qty = q;
        go(state, "DATE");
        say(prompt(state, nowMs));
        return out();
      }

      case "DATE": {
        var d = parseDate(t, nowMs);
        if (!d) return reprompt("I didn't catch the date.");
        if (d.error) return reprompt(d.error);
        if (!availableSlots(d.iso, nowMs).length) return reprompt("No slots are left for that day. Please pick another date.");
        state.cart.date = d.iso;
        delete state.cart.slotId;
        go(state, "SLOT");
        say("Got it: " + prettyDate(d.iso) + ".");
        say(prompt(state, nowMs));
        return out();
      }

      case "SLOT": {
        var s = parseSlot(t);
        if (!s) return reprompt("Please pick a slot number.");
        if (!slotAvailable(s, state.cart.date, nowMs)) {
          return reprompt("The " + s.label + " slot is too soon for today: we need about " + (RULES.leadTimeMinutes / 60) + " hours to bake.");
        }
        state.cart.slotId = s.id;
        go(state, "MESSAGE");
        say(prompt(state, nowMs));
        return out();
      }

      case "MESSAGE": {
        if (!raw) return reprompt();
        if (/^(none|no|no message|nothing|skip|na|n\/a|nil)$/.test(t)) state.cart.message = "";
        else if (raw.length > RULES.maxCakeMessage) {
          return reprompt("That's " + raw.length + " characters; the cake fits " + RULES.maxCakeMessage + ". Please shorten it.");
        } else state.cart.message = raw;
        go(state, "FULFIL");
        say(prompt(state, nowMs));
        return out();
      }

      case "FULFIL": {
        if (/^(1|pickup|pick up|pick-up|collect|self pickup|takeaway|take away)$/.test(t)) {
          state.cart.fulfilment = "pickup";
          delete state.cart.zoneId; delete state.cart.address;
          return toSummary();
        }
        var zoneNow = parseZone(t);
        if (zoneNow) { state.cart.fulfilment = "delivery"; state.cart.zoneId = zoneNow.id; go(state, "ADDRESS"); say(prompt(state, nowMs)); return out(); }
        if (/^(2|delivery|deliver|home delivery|door delivery)$/.test(t)) {
          state.cart.fulfilment = "delivery";
          go(state, "AREA");
          say(prompt(state, nowMs));
          return out();
        }
        return reprompt("Please reply *pickup* or *delivery*.");
      }

      case "AREA": {
        if (/^(pickup|pick up|collect)$/.test(t)) {
          state.cart.fulfilment = "pickup";
          delete state.cart.zoneId; delete state.cart.address;
          return toSummary();
        }
        var n = parseNumber(t);
        var zone = n !== null && n >= 1 && n <= ZONES.length ? ZONES[n - 1] : parseZone(t);
        if (!zone) return reprompt("Sorry, we don't deliver there yet.");
        state.cart.fulfilment = "delivery";
        state.cart.zoneId = zone.id;
        go(state, "ADDRESS");
        say(prompt(state, nowMs));
        return out();
      }

      case "ADDRESS": {
        if (raw.length < 8) return reprompt("That looks too short for an address.");
        state.cart.address = raw.slice(0, 160);
        return toSummary();
      }

      case "SUMMARY": {
        var yn = parseYesNo(t);
        if (yn === true) {
          state.orderId = makeOrderId(nowMs);
          go(state, "PAYMENT");
          say(prompt(state, nowMs));
          return out();
        }
        if (yn === false) {
          say("No problem. Reply *back* to change the last answer, or *menu* to start again.");
          return out();
        }
        return reprompt("Please reply *yes* to confirm.");
      }

      case "PAYMENT": {
        if (/^(paid|done|payment done|i paid|i have paid|sent|transferred|completed)$/.test(t)) {
          var c = state.cart, p = priceOf(c), item2 = findItem(c.itemId), slot = findSlot(c.slotId);
          var order = {
            id: state.orderId,
            placedAt: nowMs,
            cake: item2.name,
            size: sizeLabel(c.sizeKg),
            qty: c.qty,
            date: c.date,
            slot: slot.label,
            message: c.message || "",
            fulfilment: c.fulfilment,
            area: c.fulfilment === "delivery" ? findZone(c.zoneId).name : null,
            address: c.fulfilment === "delivery" ? c.address : null,
            subtotal: p.subtotal,
            deliveryFee: p.fee,
            total: p.total,
            advance: p.advance,
            balance: p.balance,
            status: "advance claimed, owner to verify UPI credit"
          };
          events.push({ type: "order_confirmed", order: order });
          state.lastOrderId = state.orderId;
          var id = state.orderId;
          resetOrder(state);
          state.orderId = id;
          state.step = "DONE";
          say("Thank you! Order *" + id + "* is confirmed for " + prettyDate(order.date) + ", " + order.slot + ".");
          say("The owner checks the UPI credit before baking and will message you if anything is missing. Reply *menu* to place another order.");
          return out();
        }
        return reprompt("Reply *paid* after paying the advance, or *back* to review.");
      }
    }
    return reprompt();

    function handleItem(item) {
      state.cart = { itemId: item.id };
      go(state, "SIZE");
      var sniff = parseSize(t, true);
      if (sniff) {
        state.cart.sizeKg = sniff.kg;
        go(state, "QTY");
        say("*" + item.name + "*, " + sniff.label + ": " + inr(item.prices[sizeIndex(sniff.kg)]) + " each.");
        say(prompt(state, nowMs));
        return out();
      }
      say("Good choice: *" + item.name + "*.");
      say(prompt(state, nowMs));
      return out();
    }

    function toSummary() {
      go(state, "SUMMARY");
      say(prompt(state, nowMs));
      return out();
    }
  }

  return {
    createSession: createSession,
    handleMessage: handleMessage,
    priceOf: priceOf,
    upiLink: upiLink,
    inr: inr,
    BAKERY: BAKERY,
    MENU: MENU,
    SIZES: SIZES,
    SLOTS: SLOTS,
    ZONES: ZONES,
    RULES: RULES
  };
});
