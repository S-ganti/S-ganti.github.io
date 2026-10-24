// Tests for the bakery bot state machine. Run from portfolio/: node --test bot/bot-core.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Bot = require("./bot-core.js");

// Fixed clocks, written in IST (UTC+5:30).
const ist = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - 330 * 60000;
const MORNING = ist(2026, 10, 24, 9, 0);    // Sat 24 Oct 2026, 09:00 IST (before cutoff)
const AFTERNOON = ist(2026, 10, 24, 15, 0); // same day, 15:00 IST (after cutoff)

// Feed a list of messages; return every result.
function run(messages, now = MORNING, start = Bot.createSession()) {
  let state = start;
  const results = [];
  for (const m of messages) {
    const r = Bot.handleMessage(state, m, { now });
    results.push(r);
    state = r.state;
  }
  return { state, results, last: results[results.length - 1] };
}
const text = (r) => r.replies.join("\n");

const TO_ADDRESS = ["hi", "2", "2", "2", "tomorrow", "3", "Happy 30th Asha", "delivery", "koramangala"];

test("happy path: delivery order to confirmation with order ID", () => {
  const { state, results, last } = run([...TO_ADDRESS, "12, 4th Cross, 5th Block, near Sony signal", "yes", "paid"]);

  assert.match(text(results[0]), /Butterbird Home Bakery \(demo\)/);
  assert.match(text(results[0]), /Red Velvet: ₹600 \/ ₹1,100 \/ ₹2,100/);
  assert.equal(results[1].state.step, "SIZE");
  assert.equal(results[3].state.step, "DATE");
  assert.match(text(results[4]), /Sunday 25 Oct 2026/);

  const summary = text(results[9]);
  assert.equal(results[9].state.step, "SUMMARY");
  assert.match(summary, /Red Velvet, 1 kg × 2 = ₹2,200/);
  assert.match(summary, /"Happy 30th Asha"/);
  assert.match(summary, /Delivery to Koramangala: 12, 4th Cross.*\(fee ₹70\)/);
  assert.match(summary, /Total: ₹2,270/);
  assert.match(summary, /Advance to confirm \(50%\): ₹1,140/); // 1,135 rounded up to the next ₹10

  const pay = text(results[10]);
  assert.equal(results[10].state.step, "PAYMENT");
  assert.match(pay, /upi:\/\/pay\?pa=butterbird\.demo%40notreal&pn=[^&]+&am=1140\.00&cu=INR&tn=/);
  assert.match(pay, /DEMO ONLY/);

  assert.equal(state.step, "DONE");
  const ev = last.events.find((e) => e.type === "order_confirmed");
  assert.ok(ev, "order_confirmed event");
  assert.match(ev.order.id, /^BB-1024-[0-9A-Z]{3}$/);
  assert.equal(ev.order.id, results[10].state.orderId);
  assert.deepEqual(
    { cake: ev.order.cake, size: ev.order.size, qty: ev.order.qty, date: ev.order.date, slot: ev.order.slot,
      area: ev.order.area, total: ev.order.total, advance: ev.order.advance, balance: ev.order.balance },
    { cake: "Red Velvet", size: "1 kg", qty: 2, date: "2026-10-25", slot: "5 – 7 pm",
      area: "Koramangala", total: 2270, advance: 1140, balance: 1130 }
  );
  assert.match(text(last), new RegExp(ev.order.id));
});

test("free text: cake and size in one message, word quantities, dd/mm dates, slot by time", () => {
  const { results } = run(["hello", "chocolate truffle half kg", "two cakes", "27/10", "7pm", "none", "pickup"]);
  assert.equal(results[1].state.step, "QTY");
  assert.equal(results[1].state.cart.sizeKg, 0.5);
  assert.equal(results[2].state.cart.qty, 2);
  assert.equal(results[3].state.cart.date, "2026-10-27");
  assert.equal(results[4].state.cart.slotId, 4);
  const summary = text(results[6]);
  assert.match(summary, /Chocolate Truffle, ½ kg × 2 = ₹1,100/);
  assert.match(summary, /Message on cake: none/);
  assert.match(summary, /Pickup from/);
  assert.match(summary, /Total: ₹1,100/);
});

test("rejects past dates and stays on the date step", () => {
  const atDate = run(["hi", "1", "2", "1"]).state;
  for (const input of ["20/10/2026", "yesterday", "2026-10-23", "23 oct 2026"]) {
    const r = Bot.handleMessage(atDate, input, { now: MORNING });
    assert.equal(r.state.step, "DATE", input);
    assert.match(text(r), /already passed/, input);
    assert.equal(r.state.cart.date, undefined, input);
  }
  const bogus = Bot.handleMessage(atDate, "31/02", { now: MORNING });
  assert.match(text(bogus), /isn't a real date/);
  const far = Bot.handleMessage(atDate, "30/12", { now: MORNING });
  assert.match(text(far), /up to 30 days ahead/);
});

test("same-day orders: rejected after the 11 am cutoff, allowed before it with lead time", () => {
  const late = run(["hi", "1", "2", "1", "today"], AFTERNOON).last;
  assert.equal(late.state.step, "DATE");
  assert.match(text(late), /Same-day orders close at 11 am/);

  const early = run(["hi", "1", "2", "1", "today"], MORNING);
  assert.equal(early.state.step, "SLOT");
  assert.equal(early.state.cart.date, "2026-10-24");
  // 09:00 + 5 h lead time: the 11 am slot is too soon, 2 pm onwards is fine.
  assert.deepEqual(early.last.hints, ["2", "3", "4", "Back"]);
  const tooSoon = Bot.handleMessage(early.state, "1", { now: MORNING });
  assert.equal(tooSoon.state.step, "SLOT");
  assert.match(text(tooSoon), /too soon/);
  const ok = Bot.handleMessage(early.state, "2", { now: MORNING });
  assert.equal(ok.state.step, "MESSAGE");
});

test("cancel clears the order from any step", () => {
  const mid = run(["hi", "2", "2", "3", "tomorrow"]).state;
  assert.equal(mid.step, "SLOT");
  const r = Bot.handleMessage(mid, "Cancel", { now: MORNING });
  assert.equal(r.state.step, "IDLE");
  assert.deepEqual(r.state.cart, {});
  assert.match(text(r), /Order cancelled/);

  const atPayment = run([...TO_ADDRESS, "12, 4th Cross, 5th Block", "yes", "cancel"]).last;
  assert.equal(atPayment.state.step, "IDLE");
  assert.equal(atPayment.events.length, 0);

  const nothing = Bot.handleMessage(Bot.createSession(), "cancel", { now: MORNING });
  assert.match(text(nothing), /no order in progress/);
});

test("back returns to the previous step, one step at a time", () => {
  const atQty = run(["hi", "4", "3"]).state;
  assert.equal(atQty.step, "QTY");
  const b1 = Bot.handleMessage(atQty, "back", { now: MORNING });
  assert.equal(b1.state.step, "SIZE");
  assert.match(text(b1), /Which size of \*Rasmalai Fusion\*/);
  const b2 = Bot.handleMessage(b1.state, "back", { now: MORNING });
  assert.equal(b2.state.step, "MENU");
  const b3 = Bot.handleMessage(b2.state, "back", { now: MORNING });
  assert.equal(b3.state.step, "MENU");
  assert.match(text(b3), /first step/);

  // From the summary, back goes to the address; a new answer rebuilds the summary.
  const atSummary = run([...TO_ADDRESS, "12, 4th Cross, 5th Block"]).state;
  const toAddr = Bot.handleMessage(atSummary, "back", { now: MORNING });
  assert.equal(toAddr.state.step, "ADDRESS");
  const again = Bot.handleMessage(toAddr.state, "Flat 3B, 80 Feet Road, opp. bakery", { now: MORNING });
  assert.equal(again.state.step, "SUMMARY");
  assert.match(text(again), /Flat 3B, 80 Feet Road/);

  // From payment, back returns to the summary.
  const atPay = run([...TO_ADDRESS, "12, 4th Cross, 5th Block", "yes"]).state;
  assert.equal(Bot.handleMessage(atPay, "back", { now: MORNING }).state.step, "SUMMARY");
});

test("delivery fee zones: HSR ₹40, Koramangala ₹70, BTM ₹90, pickup free, other areas refused", () => {
  const atFulfil = run(["hi", "3", "2", "1", "tomorrow", "2", "none"]).state; // Pineapple 1 kg = ₹850
  assert.equal(atFulfil.step, "FULFIL");
  const atArea = Bot.handleMessage(atFulfil, "delivery", { now: MORNING }).state;
  assert.equal(atArea.step, "AREA");

  const cases = [["HSR Layout", 40], ["koramangala", 70], ["3", 90], ["btm", 90]];
  for (const [area, fee] of cases) {
    const addr = Bot.handleMessage(atArea, area, { now: MORNING });
    assert.equal(addr.state.step, "ADDRESS", area);
    const sum = Bot.handleMessage(addr.state, "House 7, 2nd Main, near temple", { now: MORNING });
    assert.match(text(sum), new RegExp("fee ₹" + fee + "\\)"), area);
    assert.match(text(sum), new RegExp("Total: ₹" + Bot.inr(850 + fee).slice(1)), area);
  }

  const far = Bot.handleMessage(atArea, "Whitefield", { now: MORNING });
  assert.equal(far.state.step, "AREA");
  assert.match(text(far), /don't deliver there/);

  const pickup = Bot.handleMessage(atArea, "pickup", { now: MORNING });
  assert.equal(pickup.state.step, "SUMMARY");
  assert.match(text(pickup), /Total: ₹850/);

  // Naming the area straight away skips the area question.
  const direct = Bot.handleMessage(atFulfil, "btm", { now: MORNING });
  assert.equal(direct.state.step, "ADDRESS");
  assert.equal(direct.state.cart.zoneId, "btm");
});

test("unknown input is handled without losing progress", () => {
  const first = Bot.handleMessage(Bot.createSession(), "do u have cupcakes??", { now: MORNING });
  assert.equal(first.state.step, "MENU");
  assert.match(text(first), /Our cakes/);

  const atSize = run(["hi", "1"]).state;
  let s = atSize;
  let r;
  for (let i = 0; i < 3; i++) {
    r = Bot.handleMessage(s, "banana", { now: MORNING });
    s = r.state;
    assert.equal(s.step, "SIZE");
    assert.equal(s.cart.itemId, "choc");
  }
  assert.match(text(r), /talk to human/);
  assert.equal(Bot.handleMessage(s, "2", { now: MORNING }).state.step, "QTY");

  const menuMiss = run(["hi", "pizza"]).last;
  assert.equal(menuMiss.state.step, "MENU");
  assert.match(text(menuMiss), /couldn't find that cake/);

  const tooMany = run(["hi", "1", "1", "25"]).last;
  assert.equal(tooMany.state.step, "QTY");
  assert.match(text(tooMany), /more than 10 cakes/);

  const longMsg = run(["hi", "1", "1", "1", "tomorrow", "2", "Happy birthday to the best grandmother ever"]).last;
  assert.equal(longMsg.state.step, "MESSAGE");
  assert.match(text(longMsg), /fits 30/);

  for (const empty of ["", "   ", null]) {
    assert.doesNotThrow(() => Bot.handleMessage(atSize, empty, { now: MORNING }));
  }
});

test("talk to human flags a handoff; menu resumes the bot", () => {
  const mid = run(["hi", "2", "2"]).state;
  const r = Bot.handleMessage(mid, "talk to human", { now: MORNING });
  assert.equal(r.state.step, "HUMAN");
  assert.equal(r.state.handoff, true);
  assert.equal(r.events[0].type, "handoff");
  assert.match(text(r), /asked the owner/);
  const idle = Bot.handleMessage(r.state, "ok thanks", { now: MORNING });
  assert.equal(idle.state.step, "HUMAN");
  const back = Bot.handleMessage(r.state, "menu", { now: MORNING });
  assert.equal(back.state.step, "MENU");
  assert.equal(back.state.handoff, false);
});

test("handleMessage is pure: the input state is never mutated", () => {
  const s = run(["hi", "2"]).state;
  const snapshot = JSON.stringify(s);
  Bot.handleMessage(s, "2", { now: MORNING });
  Bot.handleMessage(s, "cancel", { now: MORNING });
  assert.equal(JSON.stringify(s), snapshot);
  assert.throws(() => Bot.handleMessage(s, "2", {}), /opts\.now/);
});
