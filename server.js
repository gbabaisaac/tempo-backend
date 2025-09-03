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
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---------- Clover OAuth: start (redirect owner to Clover consent) ----------
app.get("/clover/oauth/start", (req, res) => {
  const { tenant } = req.query; // your internal tenant id
  const url = new URL("https://www.clover.com/oauth/authorize");
  url.searchParams.set("client_id", process.env.CLOVER_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", process.env.CLOVER_REDIRECT_URL);
  url.searchParams.set("state", tenant || "default");
  res.redirect(url.toString());
});

// ---------- Clover OAuth: callback (exchange code -> access token) ----------
app.get("/clover/oauth/callback", async (req, res) => {
  const { code, merchant_id, state } = req.query;
  if (!code || !merchant_id) return res.status(400).send("Missing code or merchant_id");

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

    // TODO: Persist { tenant: state, merchant_id, access_token } to your DB
    res.send("Clover connected. You can close this window.");
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth error");
  }
});

// ---------- Clover webhook (payment events, etc.) ----------
app.post("/clover/webhook", (req, res) => {
  console.log("Clover webhook payload:", JSON.stringify(req.body));
  // TODO: detect payment success -> mark paid -> notify via GHL/Twilio
  res.sendStatus(200);
});

// ---------- Helpers: create order + checkout link ----------
async function cloverCreateOrder(merchantId, token, lines) {
  const orderResp = await axios.post(
    `${process.env.CLOVER_API_BASE}/v3/merchants/${merchantId}/orders`,
    { state: "OPEN", title: "Phone AI Order" },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const orderId = orderResp.data.id;

  for (const l of lines) {
    await axios.post(
      `${process.env.CLOVER_API_BASE}/v3/merchants/${merchantId}/orders/${orderId}/line_items`,
      {
        item: l.itemId ? { id: l.itemId } : undefined,
        name: l.name,
        price: l.priceCents, // cents
        quantity: l.qty
        // TODO: add "modifications" for modifiers if needed
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
  return resp.data.href; // hosted payment link
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

    // Optionally send SMS here via GHL/Twilio with customer.phone
    res.json({ orderId, payUrl });
  } catch (err) {
    console.error("Checkout error:", err.response?.data || err.message);
    res.status(500).send("Checkout error");
  }
});

// ---------- Twilio Voice: webhook returns <Connect><Stream> ----------
app.post("/voice/incoming", (req, res) => {
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
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  console.log("Voice stream connected");
  ws.on("message", (msg) => {
    // TODO: bridge Twilio <Stream> media to ElevenLabs realtime and stream audio back
  });
  ws.on("close", () => console.log("Voice stream closed"));
});

// Single server listener (Render requires process.env.PORT)
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("Server on", PORT);
});

// Upgrade HTTP -> WS for /voice/stream
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/voice/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});
