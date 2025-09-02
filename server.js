// server.js
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const WebSocket = require("ws");

const app = express();

// ---------- Middleware ----------
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Simple request log (optional)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---------- Clover OAuth: start (redirect owner to Clover consent) ----------
app.get("/clover/oauth/start", (req, res) => {
  const { tenant } = req.query; // your internal tenant id so you know who authorized
  const url = new URL("https://www.clover.com/oauth/authorize");
  url.searchParams.set("client_id", process.env.CLOVER_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", process.env.CLOVER_REDIRECT_URL);
  // keep track of which tenant kicked off OAuth
  url.searchParams.set("state", tenant || "default");
  return res.redirect(url.toString());
});

// ---------- Clover OAuth: callback (exchange code -> access token) ----------
app.get("/clover/oauth/callback", async (req, res) => {
  const { code, merchant_id, state } = req.query;

  if (!code || !merchant_id) {
    return res.status(400).send("Missing code or merchant_id");
  }

  try {
    const tokenResp = await axios.post(
      process.env.CLOVER_TOKEN_URL,
      new URLSearchParams({
        client_id: process.env.CLOVER_CLIENT_ID,
        client_secret: process.env.CLOVER_CLIENT_SECRET,
        code
      })
    );

    const accessToken = tokenResp.data?.access_token;
    console.log("Clover connected:", {
      tenant: state,
      merchant_id,
      token_preview: (accessToken || "").slice(0, 8) + "..."
    });

    // TODO: Persist { tenant: state, merchant_id, access_token } in your DB
    // For quick/manual testing you can copy from the logs.

    return res.send("Clover connected. You can close this window.");
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    return res.status(500).send("OAuth error");
  }
});

// ---------- Clover webhook (payment events, etc.) ----------
app.post("/clover/webhook", (req, res) => {
  // If you configure webhook signatures, switch this route to use raw body and verify.
  console.log("Clover webhook payload:", JSON.stringify(req.body));
  // TODO:
  //  - detect payment success event
  //  - mark order paid in your DB
  //  - send confirmation SMS via GHL/Twilio
  return res.sendStatus(200);
});

// ---------- Helpers: create order + checkout link ----------
async function cloverCreateOrder(merchantId, token, lines) {
  // Create order
  const orderResp = await axios.post(
    `${process.env.CLOVER_API_BASE}/v3/merchants/${merchantId}/orders`,
    { state: "OPEN", title: "Phone AI Order" },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const orderId = orderResp.data.id;

  // Add line items
  for (const l of lines) {
    await axios.post(
      `${process.env.CLOVER_API_BASE}/v3/merchants/${merchantId}/orders/${orderId}/line_items`,
      {
        // Prefer passing a real inventory itemId (so Clover applies taxes/labels)
        item: l.itemId ? { id: l.itemId } : undefined,
        name: l.name,
        price: l.priceCents, // cents
        quantity: l.qty,
        // Add "modifications" here if you use modifier groups
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }

  return orderId;
}

async function cloverCreateCheckout(merchantId, token, orderId, amountCents) {
  const resp = await axios.post(
    `${process.env.CLOVER_API_BASE}/v3/merchants/${merchantId}/checkouts`,
    {
      orderId,
      amount: amountCents, // cents
      currency: "USD",
      redirectUrl: process.env.CLOVER_REDIRECT_AFTER_PAY || "https://google.com"
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // Clover returns a hosted URL to collect payment (you text this to the guest)
  return resp.data.href;
}

// ---------- Public endpoint AI / GHL will call ----------
app.post("/orders/checkout", async (req, res) => {
  try {
    const { merchantId, accessToken, lines, amountCents, customer } = req.body;

    if (!merchantId || !accessToken || !Array.isArray(lines) || !amountCents) {
      return res.status(400).send("Bad payload");
    }

    const orderId = await cloverCreateOrder(merchantId, accessToken, lines);
    const payUrl = await cloverCreateCheckout(merchantId, accessToken, orderId, amountCents);

    // Optionally: send the SMS here via GHL/Twilio using customer.phone
    // (Or let GHL Workflow send it right after your tool call.)
    // Example (pseudo):
    // await sendSmsViaGHL(customer.phone, `Pay securely here: ${payUrl}`);

    return res.json({ orderId, payUrl });
  } catch (err) {
    console.error("Checkout error:", err.response?.data || err.message);
    return res.status(500).send("Checkout error");
  }
});

// ---------- Twilio Voice: webhook returns <Connect><Stream> ----------
app.post("/voice/incoming", (req, res) => {
  // Twilio will GET/POST this, we respond with TwiML to open a WS to /voice/stream
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${req.hostname}/voice/stream" track="both_tracks" />
      </Connect>
    </Response>
  `;
  res.type("text/xml").send(twiml);
});

// ---------- WebSocket bridge (placeholder) ----------
const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server on", process.env.PORT || 3000);
});

const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  console.log("Voice stream connected");
  ws.on("message", (msg) => {
    // Here you'll receive Twilio <Stream> media frames and events.
    // TODO: bridge to ElevenLabs realtime / your LLM agent and stream audio back.
    // ws.send(...) to send messages back over the stream when needed.
  });
  ws.on("close", () => console.log("Voice stream closed"));
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/voice/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
