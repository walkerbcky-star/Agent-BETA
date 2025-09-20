// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ===== STRIPE SETUP =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-06-30.basil",
});

// Sandbox price ID (hard-coded for now)
const PRICE_ID = "price_1S9OD8C0Z5UDd7Ye4p6SbZsH";

// IMPORTANT: 
// - If testing with CLI, use the `whsec_...` shown when you run `stripe listen`.
// - If testing real sandbox checkout, use the signing secret from the sandbox dashboard webhook.
const SIGNING_SECRET = (process.env.STRIPE_SIGNING_SECRET || "").trim();

// ===== POSTGRES SETUP =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    const client = await pool.connect();
    console.log("✅ Connected to Postgres database");
    client.release();
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
  }
})();

// ===== OPENAI SETUP =====
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").trim();

// ===== VOICE RULES =====
const GLOBAL_RULES = `
Light mode. Apply Quick-Scan rules. Draft in Becky’s voice: sharp, certain, alive. 
...
`;

// ===== STRIPE WEBHOOK =====
// Raw body parser *only for this route*
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  try {
    console.log("🔐 Verifying webhook signature...");
    const event = stripe.webhooks.constructEvent(req.body, sig, SIGNING_SECRET);
    console.log("✅ Stripe event received:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_details.email;
      const customerId = session.customer;

      console.log(`💡 Checkout completed for ${email} (customer ${customerId})`);

      const result = await pool.query(
        `INSERT INTO users (email, stripe_customer_id, is_subscriber)
         VALUES ($1, $2, true)
         ON CONFLICT (email)
         DO UPDATE SET stripe_customer_id = $2, is_subscriber = true, updated_at = NOW()
         RETURNING *`,
        [email, customerId]
      );

      console.log("📦 DB insert/update result:", result.rows[0]);
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const status = subscription.status === "active";

      const result = await pool.query(
        `UPDATE users 
         SET is_subscriber = $1, stripe_subscription_id = $2, updated_at = NOW()
         WHERE stripe_customer_id = $3
         RETURNING *`,
        [status, subscription.id, customerId]
      );

      console.log(`🔄 Subscription status updated: ${subscription.id} (${status})`);
      console.log("📦 DB update result:", result.rows[0]);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ===== MIDDLEWARE =====
// NOTE: This must come *after* the webhook route so raw body is preserved there
app.use(cors());
app.use(bodyParser.json());

// ===== STATIC PAGES =====
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "subscribe.html")));
app.get("/success", (_req, res) => res.sendFile(path.join(__dirname, "success.html")));
app.get("/cancel", (_req, res) => res.sendFile(path.join(__dirname, "subscribe.html")));

// ===== CHECKOUT SESSION =====
app.get("/create-checkout-session", async (_req, res) => {
  try {
    console.log("🔎 Using Price ID for checkout:", PRICE_ID);
    const session = await stripe.checkout.sessions.create({
      customer_email: "tester@example.com", // required for Accounts V2 if no login
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: "https://agent-beta.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://agent-beta.onrender.com/cancel",
    });
    console.log("🛒 Checkout session created:", session.id, session.url);
    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Error creating session:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ===== SUCCESS LOOKUP =====
app.get("/session-status", async (req, res) => {
  const sessionId = req.query.session_id;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DEBUG PRICES =====
app.get("/debug-prices", async (_req, res) => {
  try {
    const prices = await stripe.prices.list({ limit: 10 });
    console.log("📋 Available prices:", prices.data.map(p => p.id));
    res.json(prices.data);
  } catch (err) {
    console.error("❌ Error listing prices:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== WHOAMI DEBUG =====
app.get("/whoami", async (_req, res) => {
  try {
    const account = await stripe.accounts.retrieve();
    console.log("🔑 Connected account:", account.id, account.email);
    res.json({ id: account.id, email: account.email });
  } catch (err) {
    console.error("❌ Error retrieving account:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== CHAT ENDPOINT =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: GLOBAL_RULES },
          { role: "user", content: message },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || "OpenAI error" });
    }
    const reply = data.choices?.[0]?.message?.content || "No reply";
    res.json({ reply });
  } catch (err) {
    console.error("Network/Fetch error:", err);
    res.status(500).json({ error: "Network error calling OpenAI" });
  }
});

// ===== START SERVER =====
app.listen(3000, () => console.log("Server running on http://localhost:3000"));
