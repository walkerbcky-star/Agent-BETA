// ===== SETUP =====
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import Stripe from "stripe";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

// ===== RUNTIME ENV CHECK (light, non blocking) =====
function checkEnv() {
  const required = [
    "DATABASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_SIGNING_SECRET",
    "STRIPE_PRICE_ID",
    "BASE_URL",
    "OPENAI_API_KEY"
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
  } else {
    console.log("Env looks OK");
  }
}
checkEnv();

// Small helper: strong API token
function makeToken(len = 48) {
  return crypto.randomBytes(len).toString("base64url");
}

// ===== TABLE CREATION =====
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      is_subscriber BOOLEAN DEFAULT false,
      api_token TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_state (
      email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
      avatar JSONB DEFAULT '{}'::jsonb,
      my_profile TEXT DEFAULT '',
      preferences JSONB DEFAULT '{}'::jsonb,
      banned_words TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_voice_profile (
      email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
      style_brief TEXT DEFAULT '',
      tone_notes TEXT DEFAULT '',
      industry_terms TEXT[] DEFAULT '{}',
      last_learned_at TIMESTAMPTZ DEFAULT NOW(),
      sample_count INT DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id SERIAL PRIMARY KEY,
      email TEXT REFERENCES users(email) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      id TEXT PRIMARY KEY,
      type TEXT,
      data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("Tables ensured");
}

// ===== STRIPE WEBHOOK: must see raw body =====
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_SIGNING_SECRET
      );
      console.log("Stripe event:", event.type);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.sendStatus(400);
    }

    try {
      const exists = await pool.query("SELECT 1 FROM stripe_events WHERE id = $1", [event.id]);
      if (exists.rows.length === 0) {
        await pool.query(
          "INSERT INTO stripe_events (id, type, data) VALUES ($1, $2, $3)",
          [event.id, event.type, event.data ? event.data.object : {}]
        );
      } else {
        return res.sendStatus(200);
      }
    } catch (e) {
      console.error("Stripe event store failed:", e.message);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const customerId = session.customer;
          const subscriptionId = session.subscription;
          const customer = await stripe.customers.retrieve(customerId);
          let sub = null;
          try {
            if (subscriptionId) sub = await stripe.subscriptions.retrieve(subscriptionId);
          } catch (e) {
            console.warn("Could not retrieve subscription:", e.message);
          }

          const email = customer.email;
          const name = customer.name;
          const token = makeToken();

          await pool.query(
            `INSERT INTO users (email, name, is_subscriber, api_token, stripe_customer_id, stripe_subscription_id, subscription_status)
             VALUES ($1, $2, true, $3, $4, $5, $6)
             ON CONFLICT (email) DO UPDATE
               SET is_subscriber=true,
                   name=$2,
                   api_token=$3,
                   stripe_customer_id=$4,
                   stripe_subscription_id=$5,
                   subscription_status=$6`,
            [email, name, token, customerId || null, subscriptionId || null, sub?.status || "active"]
          );

          await upsertDefaultState(email);
          break;
        }

        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const status = sub.status;
          const customerId = sub.customer;
          const customer = await stripe.customers.retrieve(customerId);
          const email = customer.email || null;

          if (email) {
            await pool.query(
              `UPDATE users
               SET is_subscriber = $1,
                   stripe_subscription_id = $2,
                   subscription_status = $3
               WHERE email = $4`,
              [status === "active" || status === "trialing", sub.id, status, email]
            );
          }
          break;
        }

        case "invoice.paid":
          console.log("Invoice paid");
          break;

        case "invoice.payment_failed":
          console.log("Invoice payment failed");
          break;

        default:
          console.log("Unhandled event type:", event.type);
      }

      res.sendStatus(200);
    } catch (err) {
      console.error("Webhook handler error:", err);
      res.sendStatus(500);
    }
  }
);

// ===== After webhook: normal middleware =====
app.use(bodyParser.json());
app.use(express.static("public"));

app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.redirect("/login.html"));

// ===== GLOBAL VOICE RULES =====
const GLOBAL_RULES = `
LANGUAGE AND FORMATTING
- Always UK English.
- Use contractions naturally.
- Never use an em dash. Replace with colon, comma, or full stop.
- No emojis. No apology. No filler. No beige language.
- No bullet symbols. Use hyphens if you must list.
- Rhythm first: short-first, readable aloud, alternate staccato and roll.
- Copy must end with punch, not fade.
...
`;

// (All helper and chat logic unchanged for brevity; same as uploaded file)

// ===== STRIPE CHECKOUT =====
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("Using BASE_URL:", process.env.BASE_URL);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.BASE_URL}/post-checkout?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/login.html`
    });

    console.log("Session created:", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ===== POST-CHECKOUT (UI handoff) =====
app.get("/post-checkout", async (req, res) => {
  const { session_id } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const customer = await stripe.customers.retrieve(session.customer);

    const email = customer.email;
    const name = customer.name;

    // keep existing strong token if user already exists
    const existing = await pool.query("SELECT api_token FROM users WHERE email=$1", [email]);
    const api_token = existing.rows[0]?.api_token || makeToken();

    await pool.query(
      `INSERT INTO users (email, name, is_subscriber, api_token, stripe_customer_id, stripe_subscription_id, subscription_status)
       VALUES ($1, $2, true, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE
         SET is_subscriber=true,
             name=$2,
             api_token = COALESCE(users.api_token, EXCLUDED.api_token),
             stripe_customer_id=$4,
             stripe_subscription_id=$5,
             subscription_status=$6`,
      [
        email,
        name,
        api_token,
        session.customer || null,
        session.subscription || null,
        "active"
      ]
    );

    await upsertDefaultState(email);
    res.redirect(`/chat-ui/${encodeURIComponent(email)}`);
  } catch (err) {
    console.error("Post-checkout error:", err);
    res.status(500).send("Post-checkout failed");
  }
});

// ===== CHAT ROUTE =====
// (Unchanged from your uploaded version)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  ensureTables()
    .then(() => console.log("Init complete"))
    .catch((e) => console.error("Table init error:", e.message));

  pool
    .query("SELECT 1")
    .then(() => console.log("DB reachable"))
    .catch((e) => console.error("DB ping issue:", e.message));
});
