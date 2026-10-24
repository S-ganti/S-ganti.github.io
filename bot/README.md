# Bakery WhatsApp ordering bot (demo)

A sample WhatsApp ordering bot for **Butterbird Home Bakery**, a fictional home bakery in Bengaluru. Built by Sriharsh Ganti as portfolio proof for the automation offer. It is a demo, not a client project, and it has no users.

## What is here

| File | What it is |
|---|---|
| `bot-core.js` | The bot: a pure state machine (no DOM, no network, no clock reads). Greeting, menu, cake and size, quantity, date and slot, cake message, pickup or delivery, summary, UPI advance, confirmation with order ID. Handles `menu`, `back`, `cancel`, `talk to human`, `help` and unknown input. |
| `bot-core.test.js` | Tests (Node's built-in `node:test`). |
| `index.html`, `chat.css`, `chat.js` | Web demo: WhatsApp-style chat plus an owner view listing the orders placed in this browser (localStorage, with an in-memory fallback). |
| `build-n8n.js` | Generates the n8n workflow from `bot-core.js`, so both run the same logic. |
| `n8n-whatsapp-bakery.json` | Importable n8n workflow: WhatsApp Trigger, then a Code node running the state machine (one session per phone number in workflow static data), then a WhatsApp send-message node. |

Rules built into the bot: same-day orders close at 11:00 IST, and a same-day slot must start at least 5 hours ahead. Past dates and dates over 30 days ahead are refused. Quantity is 1 to 10. Cake messages are capped at 30 characters. Delivery fees: HSR Layout ₹40, Koramangala ₹70, BTM Layout ₹90. Other areas are refused, with pickup offered instead. The advance is 50% of the total, rounded up to the next ₹10.

The UPI ID `butterbird.demo@notreal` is fake: no bank uses the `notreal` handle. The payment step says so to the customer.

## Run it

From `freelance\portfolio\`:

```
node --test bot/bot-core.test.js     # tests
node bot/build-n8n.js                # rebuild the n8n JSON after editing bot-core.js
```

The web demo is `bot/index.html` on the portfolio server (the "portfolio" entry in `.claude/launch.json`, port 8790).

## The n8n workflow: not tested live

**`n8n-whatsapp-bakery.json` has not been tested against a live WhatsApp Business account.** The Code node was run locally with stubbed n8n inputs: a full order went through and the order was stored. The trigger and send nodes have not been run against Meta. Node parameter names can differ between n8n versions, so check both WhatsApp nodes after you import the file.

To take it live you need:

1. **A Meta Business account** and a Meta developer app with the WhatsApp product added.
2. **A phone number for WhatsApp Business** that is not already registered on the WhatsApp or WhatsApp Business app. Meta also gives you a test number for development.
3. **A permanent access token**: a System User token with `whatsapp_business_messaging` and `whatsapp_business_management`. The temporary token from the developer dashboard expires in about 24 hours.
4. **An n8n instance reachable over HTTPS** (n8n Cloud or self-hosted) so Meta can call the trigger webhook.
5. In n8n: create the **WhatsApp OAuth** credential for the trigger (app ID and secret) and the **WhatsApp API** credential for the send node (access token and business account ID). Then replace the `REPLACE_ME` placeholders, and activate the workflow. Workflow static data, which holds the sessions, is only saved for runs of an active workflow, not for manual test runs.
6. **Business checks before real customers use it:** Meta business verification, a display name approved by Meta, and Meta's conversation pricing. Replies sent within 24 hours of a customer's message are free-form. Messages sent after that need approved templates.

Still to build for a real bakery: the owner alert on `talk to human` (the Code node already outputs `handoff: true`), pausing the bot for that number, writing orders to a Google Sheet, and checking UPI payments. Right now the customer replies "paid" and the owner has to check the credit by hand.
