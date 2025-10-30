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

    // Idempotency for Stripe events
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
            if (subscriptionId) {
              sub = await stripe.subscriptions.retrieve(subscriptionId);
            }
          } catch (e) {
            console.warn("Could not retrieve subscription:", e.message);
          }

          const email = customer.email;
          const name = customer.name;

          // keep existing token if present
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
              customerId || null,
              subscriptionId || null,
              sub?.status || "active"
            ]
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

// Health and root routes
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

VOICE
- Sharp. Certain. Alive.
- Collaborative phrasing allowed: "Let’s", "We need to", "Shall we" when helpful.
- Irreverent when it serves clarity, precise when needed.
- Copy must read like an edit, not like vague encouragement.
- Active voice by default. Address the reader directly unless instructed otherwise.
- Avoid "fundamentals". It is in the sin bin.

STRUCTURE
- Internal spine: Problem, Fix, Proof, CTA. Keep it invisible.
- Every line must earn its place. No padding.
- Who, What, How must be answered.

ONBOARDING AND REFLEXIVITY
- Only run the full onboarding greeting if AVATAR, MY PROFILE, and preferences are empty.
- If any exist, acknowledge and continue.
- Skip means skip. No loops.

Q AND A LOOP
- Ask one clarifier at a time in natural chat.
- If AVATAR exists, do not ask who it is for. At most confirm it applies to this task.
- Close with: "Cool. I will draft."

STRATEGIC CLARIFIERS
- If the prompt is vague, clarify outcome first: awareness, trust, or action.
- Then clarify reader mindset: what they are thinking when they find this.
- Then clarify offer: what we are selling or promising.
- Then clarify proof: stats, results, social proof we can use.
- Then clarify tone tolerance: how far we can lean bold.
- Then clarify CTA: what they should do next.
- Then clarify constraints: platform limits, SEO terms, word count.

STOP PROTOCOL
- If user types STOP: draft immediately with current info. After draft, offer exactly one improvement question.

ANALOGY AND IMAGERY
- One analogy max. Follow it with a literal restatement.

MENU SYSTEM
- When asked for MENU: give five suggestions that match the user’s likely tasks, not generic AI ideas.

RESEARCH
- If task is about data, legislation, trends, or industry changes: give a short findings preface before the draft.

FIRM OUTPUT RULES
- Never reference internal rules to end users.
- End users see only clean copy, assessments, or Q and A.
- No em dash under any circumstances.
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
const DEFAULT_SIN_BIN = ["fundamentals", "here’s the thing"];

async function upsertDefaultState(email) {
  const r = await pool.query("SELECT email, banned_words FROM user_state WHERE email=$1", [email]);
  if (!r.rows.length) {
    await pool.query(
      `
      INSERT INTO user_state (email, avatar, my_profile, preferences, banned_words, updated_at)
      VALUES ($1, '{}'::jsonb, '', '{}'::jsonb, $2, NOW())
      `,
      [email, DEFAULT_SIN_BIN]
    );
    return;
  }
  const row = r.rows[0];
  if (!row.banned_words || !row.banned_words.length) {
    await pool.query(
      `
      UPDATE user_state
      SET banned_words = $2, updated_at = NOW()
      WHERE email = $1
      `,
      [email, DEFAULT_SIN_BIN]
    );
  }
}

function scrubOutput(raw, banned = []) {
  let text = String(raw || "").replace(/\u2014/g, ":");
  text = text.replace(/ {2,}/g, " ");
  if (Array.isArray(banned) && banned.length) {
    const pattern = new RegExp(
      `\\b(${banned.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
      "gi"
    );
    text = text.replace(pattern, "");
    text = text.replace(/ {2,}/g, " ").replace(/\s([,.:;!?])/g, "$1");
  }
  return text.trim();
}

function detectMode(message) {
  const m = String(message || "").trim();
  const head = m.split(/\s+/).slice(0, 2).join(" ").toUpperCase();
  const modes = [
    "LIGHT EDIT",
    "EDIT",
    "REWRITE",
    "REBUILD",
    "ASSESS",
    "ANALYSE",
    "DRAFT",
    "OUTLINE",
    "PROMPT",
    "HOW-TO",
    "LONGFORM"
  ];
  for (const mode of modes) {
    if (head.startsWith(mode) || m.toUpperCase().startsWith(`MODE: ${mode}`)) {
      return mode === "HOW-TO" ? "OUTLINE" : mode;
    }
  }
  return null;
}

function buildClientBrief(voiceRow, stateRow) {
  const styleBrief = voiceRow?.style_brief || "";
  const toneNotes = voiceRow?.tone_notes || "";
  const industry = Array.isArray(voiceRow?.industry_terms)
    ? voiceRow.industry_terms.join(", ")
    : "";
  const avatar =
    stateRow?.avatar && Object.keys(stateRow.avatar || {}).length
      ? JSON.stringify(stateRow.avatar)
      : "";
  const myProfile = stateRow?.my_profile || "";
  const prefs =
    stateRow?.preferences && Object.keys(stateRow.preferences || {}).length
      ? JSON.stringify(stateRow.preferences)
      : "";

  const lines = [];
  if (styleBrief) lines.push(`STYLE BRIEF: ${styleBrief}`);
  if (toneNotes) lines.push(`TONE NOTES: ${toneNotes}`);
  if (industry) lines.push(`INDUSTRY TERMS: ${industry}`);
  if (avatar) lines.push(`AVATAR: ${avatar}`);
  if (myProfile) lines.push(`MY PROFILE: ${myProfile}`);
  if (prefs) lines.push(`PREFERENCES: ${prefs}`);

  if (!lines.length) return "";
  return `
CLIENT VOICE BRIEF
${lines.join("\n")}

ADAPTATION RULES
- Mirror the client's cadence and word choices.
- Keep UK English and the structure spine.
- One analogy max, then literalise.
`.trim();
}

function preferencesToRules(prefs = {}) {
  const blocks = [];
  if (prefs.no_sales === true) {
    blocks.push(`
NO-SALES SWITCH
- Do not add CTAs unless the user asks for one.
- Focus on explanation and structure.
`.trim());
  }
  if (prefs.mode && typeof prefs.mode === "string") {
    const m = prefs.mode.toUpperCase();
    if (m === "LIGHT EDIT") {
      blocks.push(`
MODE: LIGHT EDIT
- Keep user formatting.
- Fix grammar, spelling, rhythm.
- Do not reframe the whole piece.
`.trim());
    }
  }
  if (prefs.sin_bin && Array.isArray(prefs.sin_bin) && prefs.sin_bin.length) {
    blocks.push(`
EXTRA SIN BIN
- Avoid these terms: ${prefs.sin_bin.join(", ")}.
`.trim());
  }
  return blocks.join("\n\n");
}

function buildMessages({ message, systemPrompt, history = [] }) {
  const safeHistory = history.slice(-4).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000)
  }));
  return [
    { role: "system", content: systemPrompt },
    ...safeHistory,
    { role: "user", content: message }
  ];
}

// ===== VOICE ANALYSIS =====
async function summariseClientVoice(texts) {
  const openai = await getOpenAI();
  if (!openai) return { style_brief: "", tone_notes: "" };

  const prompt = `
You are a voice analyst for a UK copywriter.
From the user's samples, produce:
1) STYLE_BRIEF: 6 to 10 tight lines on cadence, formality, sentence length, humour, common constructions.
2) TONE_NOTES: 3 to 6 lines with do and do not, and word preferences.
Keep UK English.
No coaching tone.
No filler.

SAMPLES
${texts.map((t, i) => `#${i + 1}\n${String(t).slice(0, 2000)}`).join("\n\n")}
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }]
  });

  const raw = completion?.choices?.[0]?.message?.content || "";
  const stylePart = raw.split(/TONE[_ ]NOTES\s*:/i)[0] || "";
  const tonePart = raw.split(/TONE[_ ]NOTES\s*:/i)[1] || "";
  return {
    style_brief: stylePart.replace(/STYLE[_ ]BRIEF\s*:/i, "").trim(),
    tone_notes: (tonePart || "").trim()
  };
}

async function maybeLearnFromChat(email, userMessage) {
  try {
    const r = await pool.query("SELECT sample_count FROM user_voice_profile WHERE email=$1", [email]);
    const row = r.rows[0];
    const shouldLearn = !row || row.sample_count < 5;
    if (!shouldLearn) return;

    const brief = await summariseClientVoice([String(userMessage || "").slice(0, 1200)]);
    await pool.query(
      `
      INSERT INTO user_voice_profile (email, style_brief, tone_notes, last_learned_at, sample_count)
      VALUES ($1, $2, $3, NOW(), 1)
      ON CONFLICT (email) DO UPDATE
        SET style_brief = CASE
              WHEN LENGTH(user_voice_profile.style_brief) < 2000 THEN user_voice_profile.style_brief || ' ' || EXCLUDED.style_brief
              ELSE EXCLUDED.style_brief
            END,
            tone_notes = EXCLUDED.tone_notes,
            last_learned_at = NOW(),
            sample_count = user_voice_profile.sample_count + 1
      `,
      [email, brief.style_brief, brief.tone_notes]
    );
  } catch (e) {
    console.error("learn-from-chat failed:", e);
  }
}

// ===== AUTH AND STATE HELPERS =====
async function getAuthedUser(email, token) {
  const r = await pool.query(
    "SELECT email, name, is_subscriber, api_token FROM users WHERE email=$1",
    [email]
  );
  const user = r.rows[0];
  if (!user) return null;
  if (!user.is_subscriber) return null;
  if (user.api_token !== token) return null;
  return user;
}

async function getState(email) {
  const r = await pool.query(
    "SELECT email, avatar, my_profile, preferences, banned_words FROM user_state WHERE email=$1",
    [email]
  );
  if (!r.rows.length) return null;
  return r.rows[0];
}

async function setState(email, patch) {
  const r = await pool.query(
    "SELECT email, avatar, my_profile, preferences, banned_words FROM user_state WHERE email=$1",
    [email]
  );
  const current =
    r.rows[0] || {
      email,
      avatar: {},
      my_profile: "",
      preferences: {},
      banned_words: DEFAULT_SIN_BIN
    };
  const next = {
    avatar: patch.avatar ?? current.avatar,
    my_profile: typeof patch.my_profile === "string" ? patch.my_profile : current.my_profile,
    preferences: patch.preferences ?? current.preferences,
    banned_words: Array.isArray(patch.banned_words)
      ? patch.banned_words
      : current.banned_words
  };
  await pool.query(
    `
    INSERT INTO user_state (email, avatar, my_profile, preferences, banned_words, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (email) DO UPDATE
      SET avatar=$2, my_profile=$3, preferences=$4, banned_words=$5, updated_at=NOW()
    `,
    [email, next.avatar, next.my_profile, next.preferences, next.banned_words]
  );
  return next;
}

async function getVoice(email) {
  const r = await pool.query(
    "SELECT style_brief, tone_notes, industry_terms FROM user_voice_profile WHERE email=$1",
    [email]
  );
  return r.rows[0] || null;
}

async function insertChatHistory(email, role, content) {
  try {
    await pool.query("INSERT INTO chat_history (email, role, content) VALUES ($1, $2, $3)", [
      email,
      role,
      content
    ]);
  } catch (e) {
    console.error("chat history insert failed:", e.message);
  }
}

async function getRecentChatHistory(email, limit = 4) {
  const r = await pool.query(
    `
    SELECT role, content
    FROM chat_history
    WHERE email=$1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [email, limit]
  );
  return r.rows.reverse();
}

// ===== MENU POOL =====
const MENU_POOL = [
  "Website about page tune up",
  "LinkedIn profile rewrite for clarity",
  "Service page sharpen for conversions",
  "Landing page quick audit",
  "Headline and CTA set",
  "Short email nurture outline",
  "Bio rewrite for trust",
  "Offer page structure",
  "Value proposition sharpen",
  "FAQ block in your voice",
  "Sales page opener in your voice",
  "Social post variant set (3 to 5)"
];

function pickMenu(count = 5) {
  const poolLocal = [...MENU_POOL];
  const out = [];
  while (out.length < count && poolLocal.length) {
    const idx = Math.floor(Math.random() * poolLocal.length);
    out.push(poolLocal.splice(idx, 1)[0]);
  }
  return out;
}

// ===== MESSAGE PROCESSOR =====
async function processMessageWithContext({
  message,
  user,
  state,
  voice,
  mode,
  noSales,
  history,
  forceNoOnboarding,
  stopTriggered
}) {
  const nameLine = user?.name ? `User: ${user.name} <${user.email}>.` : "";
  const clientBrief = buildClientBrief(voice, state);
  const prefBlock = preferencesToRules(state?.preferences || {});

  const modeBlock = mode
    ? `
MODE: ${mode}
- Follow the ${mode} output shape.
- Do not pitch unless asked.
`.trim()
    : "";

  const salesBlock =
    noSales || state?.preferences?.no_sales
      ? `
NO-SALES SWITCH
- Outline or how to. Do not include CTAs unless explicitly requested.
`.trim()
      : "";

  const onboardingBlock = forceNoOnboarding
    ? `
ONBOARDING CONTROL
- Do not run onboarding. User already has avatar or profile or preferences.
`.trim()
    : `
ONBOARDING CONTROL
- If no avatar, no profile, and no preferences: run the onboarding greeting once.
`.trim();

  const stopBlock = stopTriggered
    ? `
STOP PROTOCOL
- Draft now using current context.
- After the draft, offer one improvement question only.
`.trim()
    : "";

  const systemPrompt = [
    GLOBAL_RULES,
    clientBrief,
    prefBlock,
    onboardingBlock,
    modeBlock,
    salesBlock,
    stopBlock,
    nameLine
  ]
    .filter(Boolean)
    .join("\n\n");

  const openai = await getOpenAI();
  if (!openai) {
    return `Noted. ${message}`;
  }

  const messages = buildMessages({ message, systemPrompt, history });

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.4,
    messages
  });

  const reply = completion?.choices?.[0]?.message?.content?.trim() || "I do not have a response yet.";
  const banned = Array.isArray(state?.banned_words) ? state.banned_words : DEFAULT_SIN_BIN;
  return scrubOutput(reply, banned);
}

// ===== COMMAND PARSER =====
function parseCommand(raw) {
  const msg = String(raw || "").trim();
  const exact = msg.toUpperCase();

  if (exact === "STOP") return { type: "STOP" };
  if (exact === "MENU") return { type: "MENU" };
  if (exact === "MENU AGAIN") return { type: "MENU_AGAIN" };
  if (exact.startsWith("REVIEW AVATAR")) return { type: "REVIEW_AVATAR" };

  if (exact.startsWith("AVATAR")) {
    const payload = msg.slice(6).trim();
    return { type: "SET_AVATAR", payload };
  }
  if (exact.startsWith("MY PROFILE")) {
    const payload = msg.slice(10).trim();
    return { type: "SET_PROFILE", payload };
  }
  if (exact.startsWith("ADD TO MY PROFILE")) {
    const payload = msg.slice(18).trim();
    return { type: "ADD_PROFILE", payload };
  }
  if (exact.startsWith("SIN BIN:")) {
    const word = msg.slice(8).trim();
    return { type: "SINBIN_ADD", word };
  }
  if (exact.startsWith("REMOVE SIN BIN:")) {
    const word = msg.slice(16).trim();
    return { type: "SINBIN_REMOVE", word };
  }
  return null;
}

// ===== STATE API =====
app.get("/state", async (req, res) => {
  const { email, token } = req.query || {};
  try {
    const user = await getAuthedUser(email, token);
    if (!user) return res.status(403).json({ error: "Auth failed" });
    const state = await getState(email);
    res.json(state || {});
  } catch (e) {
    console.error("GET /state error:", e.message);
    res.status(500).json({ error: "Failed to fetch state" });
  }
});

app.post("/state", async (req, res) => {
  const { email, token, avatar, my_profile, preferences, banned_words } = req.body || {};
  try {
    const user = await getAuthedUser(email, token);
    if (!user) return res.status(403).json({ error: "Auth failed" });
    const next = await setState(email, { avatar, my_profile, preferences, banned_words });
    res.json(next);
  } catch (e) {
    console.error("POST /state error:", e.message);
    res.status(500).json({ error: "Failed to update state" });
  }
});

// ===== USER INFO =====
app.get("/user-info/:email", async (req, res) => {
  const { email } = req.params;
  const { token } = req.query || {};
  try {
    const user = await getAuthedUser(email, token);
    if (!user) {
      return res.status(403).json({ error: "Auth failed" });
    }
    res.json({
      name: user.name,
      is_subscriber: user.is_subscriber,
      api_token: user.api_token
    });
  } catch (err) {
    console.error("User info error:", err);
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

// ===== OPTIONAL VOICE ENDPOINTS =====
app.post("/voice/samples", async (req, res) => {
  const { email, token, texts = [] } = req.body || {};
  try {
    const user = await getAuthedUser(email, token);
    if (!user) return res.status(403).json({ error: "Auth failed" });

    const clipped = texts.map((t) => String(t || "").slice(0, 2000)).filter(Boolean);
    if (!clipped.length) return res.json({ ok: true });

    const brief = await summariseClientVoice(clipped);

    await pool.query(
      `
      INSERT INTO user_voice_profile (email, style_brief, tone_notes, last_learned_at, sample_count)
      VALUES ($1, $2, $3, NOW(), $4)
      ON CONFLICT (email) DO UPDATE
        SET style_brief = EXCLUDED.style_brief,
            tone_notes = EXCLUDED.tone_notes,
            last_learned_at = NOW(),
            sample_count = user_voice_profile.sample_count + $4
      `,
      [email, brief.style_brief, brief.tone_notes, clipped.length]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("voice/samples error:", err);
    res.status(500).json({ error: "Voice learning failed" });
  }
});

app.get("/voice/brief", async (req, res) => {
  const { email, token } = req.query || {};
  try {
    const user = await getAuthedUser(email, token);
    if (!user) return res.status(403).json({ error: "Auth failed" });

    const v = await getVoice(email);
    res.json(v || { style_brief: "", tone_notes: "", industry_terms: [] });
  } catch (err) {
    console.error("voice/brief error:", err);
    res.status(500).json({ error: "Failed to fetch voice brief" });
  }
});

app.post("/voice/reset", async (req, res) => {
  const { email, token } = req.body || {};
  try {
    const user = await getAuthedUser(email, token);
    if (!user) return res.status(403).json({ error: "Auth failed" });
    await pool.query("DELETE FROM user_voice_profile WHERE email=$1", [email]);
    res.json({ ok: true });
  } catch (err) {
    console.error("voice/reset error:", err);
    res.status(500).json({ error: "Failed to reset voice" });
  }
});

// ===== STATIC PAGES =====
app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/chat.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.get("/chat-ui/:email", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

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

    // keep existing token if user already exists
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
app.post("/chat", async (req, res) => {
  const { email, token, message } = req.body;

  try {
    const user = await getAuthedUser(email, token);
    if (!user) {
      return res.status(403).json({
        error:
          "Hey, it appears we do not know you yet. Either check the email you entered or subscribe for access."
      });
    }

    await insertChatHistory(email, "user", message);

    let state = await getState(email);
    if (!state) {
      await upsertDefaultState(email);
      state = await getState(email);
    }
    let voice = await getVoice(email);

    maybeLearnFromChat(email, message);

    const cmd = parseCommand(message);
    if (cmd) {
      switch (cmd.type) {
        case "MENU": {
          const picks = pickMenu(5);
          const reply = `Here are a few things we could roll with. Pick one, or throw me your own.\n- ${picks.join(
            "\n- "
          )}`;
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }

        case "MENU_AGAIN": {
          const picks = pickMenu(5);
          const reply = `Fresh picks:\n- ${picks.join(
            "\n- "
          )}\nWant one of these, or something else?`;
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }

        case "REVIEW_AVATAR": {
          const clean = JSON.stringify(state?.avatar || {}, null, 2);
          const reply =
            clean && clean !== "{}"
              ? `Current avatar profile:\n${clean}\nAnything you want to tweak?`
              : "No avatar is set yet. Tell me who you serve in plain terms and I will store it.";
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }

        case "SET_AVATAR": {
          let avatarObj = {};
          try {
            avatarObj = cmd.payload ? JSON.parse(cmd.payload) : {};
          } catch {
            avatarObj = { summary: cmd.payload || "Unspecified" };
          }
          state = await setState(email, { avatar: avatarObj });
          const reply = "Avatar noted. I will write to this audience unless you change it.";
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }

        case "SET_PROFILE": {
          state = await setState(email, { my_profile: cmd.payload });
          const reply = "Profile saved.";
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }

        case "ADD_PROFILE": {
          const combined = `${state?.my_profile || ""}\n${cmd.payload}`.trim();
          state = await setState(email, { my_profile: combined });
          const reply = "Added to your profile.";
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }

        case "SINBIN_ADD": {
          const list = Array.isArray(state?.banned_words) ? state.banned_words : DEFAULT_SIN_BIN;
          const next = [...new Set([...list, cmd.word].filter(Boolean))];
          state = await setState(email, { banned_words: next });
          const reply = `Added to SIN BIN: ${cmd.word}`;
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }

        case "SINBIN_REMOVE": {
          const list = Array.isArray(state?.banned_words) ? state.banned_words : DEFAULT_SIN_BIN;
          const next = list.filter(
            (w) => w.toLowerCase() !== String(cmd.word || "").toLowerCase()
          );
          state = await setState(email, { banned_words: next });
          const reply = `Removed from SIN BIN: ${cmd.word}`;
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }
      }
    }

    const mode = detectMode(message);
    const noSales = mode === "OUTLINE";

    const stopTriggered = cmd?.type === "STOP";
    const finalMessage = stopTriggered
      ? "Draft now using current context. No clarifiers."
      : message;

    const hasAvatar = state?.avatar && Object.keys(state.avatar || {}).length;
    const hasProfile = state?.my_profile && state.my_profile.trim().length;
    const hasPrefs = state?.preferences && Object.keys(state.preferences || {}).length;
    const forceNoOnboarding = Boolean(hasAvatar || hasProfile || hasPrefs);

    const history = await getRecentChatHistory(email, 4);

    voice = voice || (await getVoice(email));

    const reply = await processMessageWithContext({
      message: finalMessage,
      user,
      state,
      voice,
      mode,
      noSales,
      history,
      forceNoOnboarding,
      stopTriggered
    });

    await insertChatHistory(email, "assistant", reply);

    return res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({
      error:
        "Asteroid strike. The world has ended. If by chance it is actually us, try again in a moment."
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  ensureTables()
    .then(() => console.log("Init complete"))
    .catch((e) => console.error("Table init error:", e.message));

  pool
    .query("SELECT 1")
    .then(() => {
      console.log("DB reachable");
    })
    .catch((e) => {
      console.error("DB ping issue:", e.message);
    });
});
