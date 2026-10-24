// Builds n8n-whatsapp-bakery.json from bot-core.js, so the n8n Code node runs
// exactly the same state machine as the web demo and the tests.
// Run from portfolio/: node bot/build-n8n.js
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const core = fs.readFileSync(path.join(__dirname, "bot-core.js"), "utf8");

const glue = `
// ---- n8n glue: one session per WhatsApp number, kept in workflow static data.
// Static data is only saved for production (active-workflow) executions, not manual test runs.
const store = $getWorkflowStaticData('global');
store.sessions = store.sessions || {};
store.orders = store.orders || [];
const results = [];

for (const item of $input.all()) {
  const value = item.json || {};
  const messages = value.messages || [];
  const phoneNumberId = value.metadata ? value.metadata.phone_number_id : null;
  for (const msg of messages) {
    let text = '';
    if (msg.type === 'text' && msg.text) text = msg.text.body;
    else if (msg.type === 'button' && msg.button) text = msg.button.text;
    else if (msg.type === 'interactive' && msg.interactive) {
      const i = msg.interactive;
      text = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '';
    }
    const from = msg.from;
    if (!from) continue;
    if (!text) {
      results.push({ json: { to: from, phoneNumberId, text: 'Sorry, I can only read text messages. Reply *menu* to see our cakes.' } });
      continue;
    }
    const prev = store.sessions[from] || BakeryBot.createSession();
    const res = BakeryBot.handleMessage(prev, text, { now: Date.now() });
    store.sessions[from] = res.state;
    let handoff = false;
    for (const ev of res.events) {
      if (ev.type === 'order_confirmed') store.orders = store.orders.concat([Object.assign({ phone: from }, ev.order)]).slice(-200);
      if (ev.type === 'handoff') handoff = true;
    }
    results.push({ json: { to: from, phoneNumberId, text: res.replies.join('\\n\\n'), handoff, step: res.state.step } });
  }
}
return results;
`;

const jsCode =
  "// Butterbird Home Bakery (DEMO) ordering bot. Generated from bot/bot-core.js by bot/build-n8n.js; edit the source, not this node.\n" +
  "const BakeryBot = (function () {\n  const module = { exports: {} };\n" +
  core +
  "\n  return module.exports;\n})();\n" +
  glue;

const workflow = {
  name: "WhatsApp bakery ordering bot (DEMO)",
  nodes: [
    {
      parameters: { updates: ["messages"] },
      id: "8a0b1c2d-0001-4a00-9a00-000000000001",
      name: "WhatsApp Trigger",
      type: "n8n-nodes-base.whatsAppTrigger",
      typeVersion: 1,
      position: [0, 0],
      webhookId: "REPLACE-WITH-YOUR-WEBHOOK-ID",
      credentials: {
        whatsAppTriggerApi: { id: "REPLACE_ME", name: "WhatsApp OAuth account (placeholder)" }
      }
    },
    {
      parameters: { mode: "runOnceForAllItems", jsCode },
      id: "8a0b1c2d-0002-4a00-9a00-000000000002",
      name: "Bakery state machine",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [260, 0]
    },
    {
      parameters: {
        operation: "send",
        phoneNumberId: "={{ $json.phoneNumberId }}",
        recipientPhoneNumber: "={{ $json.to }}",
        textBody: "={{ $json.text }}",
        additionalFields: {}
      },
      id: "8a0b1c2d-0003-4a00-9a00-000000000003",
      name: "Send WhatsApp reply",
      type: "n8n-nodes-base.whatsApp",
      typeVersion: 1,
      position: [520, 0],
      credentials: {
        whatsAppApi: { id: "REPLACE_ME", name: "WhatsApp account (placeholder access token)" }
      }
    }
  ],
  connections: {
    "WhatsApp Trigger": { main: [[{ node: "Bakery state machine", type: "main", index: 0 }]] },
    "Bakery state machine": { main: [[{ node: "Send WhatsApp reply", type: "main", index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: []
};

const outPath = path.join(__dirname, "n8n-whatsapp-bakery.json");
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2) + "\n");
console.log("wrote " + path.relative(process.cwd(), outPath) + " (" + jsCode.length + " chars of Code node JS)");
