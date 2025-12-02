// ===== SETUP =====
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import Stripe from "stripe";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import getRawBody from "raw-body";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ===== VOICE RULES =====
const GLOBAL_RULES = `
LANGUAGE & FORMATTING
- Always UK English.
- Never use an em dash.
- No emojis. No filler. No beige.
- Use hyphens, never bullet symbols.

VOICE
- Sharp. Certain. Alive.
- Reads like an edit, not encouragement.

STRUCTURE
- Internal spine: Problem, Fix, Proof, CTA.

ANALOGY
- One analogy max, then literalise.

STOP PROTOCOL
- If user types STOP: draft immediately.

CONTEXT TRIANGULATION
- Adjust automatically for LinkedIn, blogs, articles.
`;

// ===== OPENAI CLIENT =====
let _openaiClient = null;
async function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (_openaiClient) return _openaiClient;
  const { default: OpenAI } = await import("openai");
  _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openaiClient;
}

// ===== UTILITIES =====
function scrub(text) {
  return String(text || "").replace(/\u2014/g, ":").trim();
}

function detectMode(message) {
  const m = message.toUpperCase();
  if (m.startsWith("LIGHT EDIT")) return "LIGHT EDIT";
  if (m.startsWith("EDIT")) return "EDIT";
  if (m.startsWith("REWRITE")) return "REWRITE";
  if (m.startsWith("REBUILD")) return "REBUILD";
  if (m.startsWith("ASSESS")) return "ASSESS";
  return null;
}

function parseCommand(raw) {
  const txt = raw.trim().toUpperCase();
  if (txt === "STOP") return { type: "STOP" };
  if (txt === "MENU") return { type: "MENU" };
  if (txt === "MENU AGAIN") return { type: "MENU_AGAIN" };
  if (txt.startsWith("AVATAR")) return { type: "SET_AVATAR", payload: raw.slice(6).trim() };
  if (txt.startsWith("MY PROFILE")) return { type: "SET_PROFILE", payload: raw.slice(10).trim() };
  return null;
}

// ===== DB HELPERS =====
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      is_subscriber BOOLEAN DEFAULT false,
      api_token TEXT
    );
  `);

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

  console.log("Tables ensured");
}

async function getAuthedUser(email, token) {
  const r = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
  const user = r.rows[0];
  if (!user) return null;
  if (!user.is_subscriber) return null;
  if (user.api_token !== token) return null;
  return user;
}

async function getState(email) {
  const r = await pool.query("SELECT * FROM user_state WHERE email=$1", [email]);
  return r.rows[0] || null;
}

async function setState(email, patch) {
  const curr = await getState(email);
  const next = {
    avatar: patch.avatar ?? curr?.avatar ?? {},
    my_profile: patch.my_profile ?? curr?.my_profile ?? "",
    preferences: patch.preferences ?? curr?.preferences ?? {},
    banned_words: patch.banned_words ?? curr?.banned_words ?? []
  };

  await pool.query(`
    INSERT INTO user_state (email, avatar, my_profile, preferences, banned_words, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (email) DO UPDATE
    SET avatar=$2, my_profile=$3, preferences=$4, banned_words=$5, updated_at=NOW()
  `, [email, next.avatar, next.my_profile, next.preferences, next.banned_words]);

  return next;
}

async function insertChat(email, role, content) {
  try {
    await pool.query(
      "INSERT INTO chat_history (email, role, content) VALUES ($1, $2, $3)",
      [email, role, content]
    );
  } catch (e) {
    console.error("chat_history insert error:", e.message);
  }
}

async function getHistory(email) {
  const r = await pool.query(
    "SELECT role, content FROM chat_history WHERE email=$1 ORDER BY created_at DESC LIMIT 4",
    [email]
  );
  return r.rows.reverse();
}

async function getVoice(email) {
  const r = await pool.query("SELECT * FROM user_voice_profile WHERE email=$1", [email]);
  return r.rows[0] || null;
}

// ===== PROCESS MESSAGE =====
async function processMessageWithContext({ message, state, voice, mode, history }) {
  const openai = await getOpenAI();

  const system = `
You are a sharp UK copywriter.
Follow these rules:
${GLOBAL_RULES}

CLIENT VOICE:
${voice?.style_brief || ""}
${voice?.tone_notes || ""}

CLIENT AVATAR:
${JSON.stringify(state?.avatar || {})}

PROFILE:
${state?.my_profile || ""}

MODE: ${mode || "default"}
`;

  const messages = [
    { role: "system", content: system },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: message }
  ];

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages
  });

  return scrub(completion.choices[0].message.content);
}

// ===== WEBHOOK =====
app.post("/stripe/webhook", async (req, res) => {
  let event;
  try {
    const raw = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      raw,
      req.headers["stripe-signature"],
      process.env.STRIPE_SIGNING_SECRET
    );
  } catch (err) {
    return res.sendStatus(400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const customer = await stripe.customers.retrieve(session.customer);
        await pool.query(
          `INSERT INTO users (email, name, is_subscriber, api_token)
           VALUES ($1, $2, true, $3)
           ON CONFLICT (email) DO UPDATE
           SET is_subscriber=true, name=$2, api_token=$3`,
          [customer.email, customer.name, Math.random().toString(36).slice(2)]
        );
        await pool.query(
          `INSERT INTO user_state (email) VALUES ($1)
           ON CONFLICT (email) DO NOTHING`,
          [customer.email]
        );
        break;
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ===== MIDDLEWARE =====
app.use(bodyParser.json());
app.use(express.static("public"));

// ===== HEALTH =====
app.get("/healthz", (req, res) => res.send("ok"));

// ===== PAGES =====
app.get("/", (req, res) => res.redirect("/login.html"));
app.get("/login.html", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "login.html"))
);
app.get("/chat-ui/:email", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "chat.html"))
);

// ===== CHECKOUT =====
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.BASE_URL}/post-checkout?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/login.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// ===== POST CHECKOUT =====
app.get("/post-checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    const customer = await stripe.customers.retrieve(session.customer);

    const email = customer.email;
    const name = customer.name;
    const api_token = Math.random().toString(36).slice(2);

    await pool.query(
      `INSERT INTO users (email, name, is_subscriber, api_token)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (email) DO UPDATE
       SET is_subscriber=true, name=$2, api_token=$3`,
      [email, name, api_token]
    );

    await pool.query(
      `INSERT INTO user_state (email) VALUES ($1)
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );

    res.redirect(`/chat-ui/${encodeURIComponent(email)}`);
  } catch (err) {
    res.status(500).send("Post-checkout failed");
  }
});

// ===== USER INFO =====
app.get("/user-info/:email", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT name, is_subscriber, api_token FROM users WHERE email=$1",
      [req.params.email]
    );
    if (!r.rows.length) return res.status(404).json({ error: "User not found" });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

// ===== CHAT =====
app.post("/chat", async (req, res) => {
  const { email, token, message } = req.body;

  try {
    const user = await getAuthedUser(email, token);
    if (!user)
      return res.status(403).json({
        error:
          "Hey, it appears we do not know you yet. Either check the email you entered or subscribe for access."
      });

    await insertChat(email, "user", message);

    const state = await getState(email);
    const voice = await getVoice(email);
    const history = await getHistory(email);

    const cmd = parseCommand(message);
    if (cmd?.type === "MENU") {
      const reply = "Menu:\n- Website tune\n- LinkedIn rewrite\n- Service page sharpen\n- Landing audit\n- CTA set";
      await insertChat(email, "assistant", reply);
      return res.json({ reply });
    }
    if (cmd?.type === "MENU_AGAIN") {
      const reply = "New menu:\n- Bio rewrite\n- Email outline\n- Offer structure\n- FAQ block\n- Social variants";
      await insertChat(email, "assistant", reply);
      return res.json({ reply });
    }
    if (cmd?.type === "SET_AVATAR") {
      let obj = {};
      try {
        obj = JSON.parse(cmd.payload);
      } catch {
        obj = { summary: cmd.payload };
      }
      await setState(email, { avatar: obj });
      const reply = "Avatar saved.";
      await insertChat(email, "assistant", reply);
      return res.json({ reply });
    }
    if (cmd?.type === "SET_PROFILE") {
      await setState(email, { my_profile: cmd.payload });
      const reply = "Profile saved.";
      await insertChat(email, "assistant", reply);
      return res.json({ reply });
    }
    if (cmd?.type === "STOP") {
      const reply = await processMessageWithContext({
        message: "Draft now using current context.",
        state,
        voice,
        history
      });
      await insertChat(email, "assistant", reply);
      return res.json({ reply });
    }

    const mode = detectMode(message);

    const reply = await processMessageWithContext({
      message,
      state,
      voice,
      mode,
      history
    });

    await insertChat(email, "assistant", reply);
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({
      error:
        "Asteroid strike. The world has ended. If by chance it is actually us, try again in a moment."
    });
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  ensureTables();
});
