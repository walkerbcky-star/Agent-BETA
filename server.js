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

const PRICE_ID = "price_1S9OD8C0Z5UDd7Ye4p6SbZsH";
const SIGNING_SECRET = (process.env.STRIPE_SIGNING_SECRET || "").trim();

// ===== POSTGRES SETUP =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Test DB connection
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
Voice Prompt = inspiration not law. Short-first. No extras unless asked.

Quick-Scan Rules
- No em dash
- No bullet symbols (use hyphens)
- No beige
- No LinkedIn-safe or coachy tone
- No filler coaching phrases (e.g., "Here’s the thing")
- No padding unless requested
- Rhythm varied: short lines hit, longer lines roll (no staccato crutch)
- Analogy = hook + one beat, then cut to fix
- One analogy max per piece
- No recycling old analogies or set-pieces unless revived
- Active voice as default (never passive unless flagged)

Voice Spine
- Sharp. Certain. Alive.
- Declarative. Tell, don’t ask.
- Irreverent when useful. Precise when needed.
- Reads like an edit, not encouragement.
- Rooted in conceptual art thinking: balance what’s in vs what’s left out.

Structure Spine
- Problem → Fix → Proof → CTA
- Every section must earn its place
- Copy moves fast: clarity first, persuasion through confidence

Modes
- Light Mode (default): Quick-Scan only, fast drafting
- Full Check (on request): Quick-Scan + Voice Prompt reference
`;

// ===== STRIPE WEBHOOK =====
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      // bypass if DISABLE_STRIPE_SIGNING=true
      if (process.env.DISABLE_STRIPE_SIGNING === "true") {
        event = JSON.parse(req.body.toString());
      } else {
        event = stripe.webhooks.constructEvent(req.body, sig, SIGNING_SECRET);
      }

      console.log("Stripe event received:", event.type);

      if (event.type === "checkout.session.completed") {
  const session = event.data.object;
  const email = session.customer_details?.email;
  const name = session.customer_details?.name || email.split("@")[0];
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  console.log(`Checkout completed → ${email}, customer: ${customerId}, sub: ${subscriptionId}`);

  const result = await pool.query(
    `INSERT INTO users (email, name, stripe_customer_id, stripe_subscription_id, is_subscriber)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (email)
     DO UPDATE SET name = $2,
                   stripe_customer_id = $3,
                   stripe_subscription_id = $4,
                   is_subscriber = true,
                   updated_at = NOW()
     RETURNING *`,
    [email, name, customerId, subscriptionId]
  );

  console.log("DB upsert:", result.rows[0]);
}

      if (event.type === "invoice.paid") {
  const invoice = event.data.object;
  const customerId = invoice.customer;

  let subscriptionId = invoice.subscription;
  if (!subscriptionId && invoice.parent?.subscription_details) {
    subscriptionId = invoice.parent.subscription_details.subscription;
  }
  if (!subscriptionId && invoice.lines?.data?.[0]?.parent?.subscription_item_details) {
    subscriptionId = invoice.lines.data[0].parent.subscription_item_details.subscription;
  }

  const email = invoice.customer_email;
  const name = invoice.customer_name || email.split("@")[0];
  console.log(`Invoice paid → ${email}, customer: ${customerId}, sub: ${subscriptionId}`);

  const result = await pool.query(
    `INSERT INTO users (email, name, stripe_customer_id, stripe_subscription_id, is_subscriber)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (email)
     DO UPDATE SET name = $2,
                   stripe_customer_id = $3,
                   stripe_subscription_id = $4,
                   is_subscriber = true,
                   updated_at = NOW()
     RETURNING *`,
    [email, name, customerId, subscriptionId]
  );

  console.log("DB upsert:", result.rows[0]);
}


      if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const cancelAtPeriodEnd = subscription.cancel_at_period_end;
        const periodEnd = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null;

        console.log(
          `Subscription updated → customer: ${customerId}, cancel_at_period_end: ${cancelAtPeriodEnd}, period_end: ${periodEnd}`
        );

        const result = await pool.query(
          `UPDATE users
           SET cancel_at_period_end = $1,
               period_end = $2,
               updated_at = NOW()
           WHERE stripe_customer_id = $3
           RETURNING *`,
          [cancelAtPeriodEnd, periodEnd, customerId]
        );

        console.log("DB update (sub updated):", result.rows[0]);
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        console.log(`Subscription cancelled → customer: ${customerId}, sub: ${subscription.id}`);

        const result = await pool.query(
          `UPDATE users
           SET is_subscriber = false,
               stripe_subscription_id = $1,
               canceled_at = NOW(),
               updated_at = NOW()
           WHERE stripe_customer_id = $2
           RETURNING *`,
          [subscription.id, customerId]
        );

        console.log("DB update (cancel):", result.rows[0]);
      }

      if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        console.log(`Payment failed → customer: ${customerId}, sub: ${invoice.subscription}`);

        const result = await pool.query(
          `UPDATE users
           SET last_payment_failed_at = NOW(),
               updated_at = NOW()
           WHERE stripe_customer_id = $1
           RETURNING *`,
          [customerId]
        );

        console.log("DB update (payment failed):", result.rows[0]);
      }

      res.status(200).send("ok");
    } catch (err) {
      console.error("Webhook error:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(bodyParser.json());

// ===== STATIC PAGES =====
app.get("/", (_req, res) => 
  res.sendFile(path.join(__dirname, "subscribe.html"))
);

app.get("/success", (_req, res) => 
  res.sendFile(path.join(__dirname, "success.html"))
);

app.get("/cancel", (_req, res) => 
  res.sendFile(path.join(__dirname, "subscribe.html"))
);

app.get("/chat-ui/:email", (_req, res) => 
  res.sendFile(path.join(__dirname, "chat.html"))
);



// ===== CHECKOUT SESSION =====
app.get("/create-checkout-session", async (_req, res) => {
  try {
    console.log("Using Price ID for checkout:", PRICE_ID);
    const session = await stripe.checkout.sessions.create({
      customer_email: "tester@example.com",
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: "https://agent-beta.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://agent-beta.onrender.com/cancel",
    });
    console.log("Checkout session created:", session.id, session.url);
    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating session:", err.message);
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
    console.log("Available prices:", prices.data.map((p) => p.id));
    res.json(prices.data);
  } catch (err) {
    console.error("Error listing prices:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== CHAT ENDPOINT WITH SUBSCRIPTION CHECK =====
app.post("/chat", async (req, res) => {
  const { message, email } = req.body; // user must send their email with the request

  try {
    // 1. Look up user in DB
    const result = await pool.query(
      `SELECT is_subscriber FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0 || !result.rows[0].is_subscriber) {
      return res.status(403).json({ error: "Subscription required to use this service." });
    }

    // 2. User is a subscriber → call OpenAI
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
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
      return res
        .status(response.status)
        .json({ error: data.error?.message || "OpenAI error" });
    }

    const reply = data.choices?.[0]?.message?.content || "No reply";
    res.json({ reply });

  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ===== USER INFO ENDPOINT =====
app.get("/user-info/:email", async (req, res) => {
  const email = req.params.email;

  try {
    const result = await pool.query(
      `SELECT email, stripe_customer_id, is_subscriber FROM users WHERE email=$1 LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    res.json({ name: user.name || user.email.split("@")[0], ...user });

  } catch (err) {
    console.error("User lookup error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});


// ===== START SERVER =====
app.listen(process.env.PORT || 3000, () =>
  console.log("Server running on http://localhost:3000")
);
