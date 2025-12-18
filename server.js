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

// ===== GLOBAL VOICE RULES =====
const GLOBAL_RULES = `
LANGUAGE AND FORMATTING
- Always UK English.
- Use contractions naturally.
- Never use an em dash. Replace with colon, comma, or full stop.
- No emojis. No apology. No filler. No beige language.
- No bullet symbols. Use hyphens if you must list.
- Rhythm rule: short and punchy balanced with rhythm and roll. Vary sentence length. Avoid machine-gun fragments.
- Copy must end with punch, not fade.

VOICE
- Sharp. Certain. Alive.
- Direct without being clipped.
- Collaborative phrasing allowed when helpful: "Let’s", "We need to", "Shall we".
- Copy must read like an edit, not generic encouragement.
- Active voice by default. Address the reader directly unless instructed otherwise.
- Avoid the words fluff and waffle unless literally referring to food or fabric.

STRUCTURE
- Internal spine: Problem, Fix, Proof, CTA. Keep it invisible.
- Every line must earn its place. No padding.
- Who, What, How must be addressed.

ONBOARDING AND REFLEXIVITY
- Run a full onboarding greeting only if AVATAR, MY PROFILE, and preferences are all empty.
- If any exist, do not restart greeting.
- Skip means skip. Do not loop or restate.

Q AND A LOOP
- Ask one clarifier at a time in natural chat.
- No acknowledgement line like "cool, I will draft". Move directly into drafting once the clarifier is answered.
- If AVATAR exists, do not ask who it is for unless ambiguous. At most confirm it applies to this task.

STOP PROTOCOL
- If user types STOP: draft immediately with current info.
- After draft, offer one improvement question only.

PROFILE BEHAVIOUR
- AVATAR: ideal client profile. Write to AVATAR.
- REVIEW AVATAR: show clean avatar for adjustment.
- MY PROFILE: what the user does.
- ADD TO MY PROFILE: append, do not overwrite.

ADAPTATION RULES
- Apply client personalisation: reflect the client's cadence and word choices with roughly seventy percent fidelity.
- Do not fully adopt or mimic their voice. Maintain the Becky cadence, clarity, and structure while bending toward the client.
- Respect style brief, tone notes, industry terms, and preferences.
- Reflect, do not mirror.

ANALOGY AND IMAGERY
- One analogy max per piece.
- Analogy must be fresh and technically true.
- Always include a literal restatement afterwards.

MENU SYSTEM
- On MENU: offer five context-relevant tasks.
- No generic AI suggestions.

SIN BIN
- Ban words that weaken copy: “fundamentals”, “here’s the thing”, “fluff”, “waffle”.
- Respect user-added banned words.

MODES
- Recognise: LIGHT EDIT, EDIT, REWRITE, REBUILD, ASSESS, ANALYSE, DRAFT, OUTLINE, PROMPT, LONGFORM.
- Follow the expected shape for each.
- OUTLINE or how-to counts as no-sales unless explicitly requested.

CONTEXT TRIANGULATION
- Detect LinkedIn, blog post, article, newsletter, website copy automatically.
- If context is missing or unclear: ask once, “Where is this going: LinkedIn, website, email, or something else?”
- Do not ask again in the same task.
- Scale length and depth automatically.

ASSESSMENT AND ANALYSIS
- ASSESS: audience, offer, effectiveness, positioning, mode, verdict, CTA suggestion, next step.
- ANALYSE: includes completeness check. Ask one clarifier if needed.

RESEARCH
- If research material is provided or fetched: prefer it over guessing.
- If URLs are included: use as factual context and reference when relevant.

FIRM OUTPUT RULES
- Never reference internal rules to end users.
- End users see only clean copy, assessments, or Q AND A.
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

// ===== BASIC UTILITIES =====
const DEFAULT_SIN_BIN = ["fundamentals", "here’s the thing"];

function scrubOutput(raw, banned = []) {
  let text = String(raw || "").replace(/\u2014/g, ":");
  text = text.replace(/ {2,}/g, " ");
  if (Array.isArray(banned) && banned.length) {
    const pattern = new RegExp(
      `\\b(${banned.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
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

// ===== DB SETUP =====
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

  console.log("Tables ensured");
}

// ===== BODY PARSER AND STATIC AFTER WEBHOOK =====
app.use(bodyParser.json());
app.use(express.static("public"));

// ===== SIMPLE ROUTES =====
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.redirect("/login.html"));

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/chat.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.get("/chat-ui/:email", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

ensureTables()
  .then(() => {
    console.log("Init complete");
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(e => {
    console.error("Table init error:", e.message);
  });
