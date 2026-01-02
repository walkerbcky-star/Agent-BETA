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

// ===== PURPOSE INFERENCE (BUSINESS JOB) =====

function inferPrimaryPurpose(message) {
  const m = String(message || "").toLowerCase();

  // Default for small businesses unless clearly overridden
  let purpose = "authority-building";

  // Explicit selling signals
  if (/\b(sell|selling|offer|launch|book|buy|cta|conversion|sales page)\b/.test(m)) {
    purpose = "sell";
  }

  // Trust and credibility signals
  if (/\b(case study|results|proof|experience|background|why me)\b/.test(m)) {
    purpose = "build trust";
  }

  // Profile and visibility signals
  if (/\b(thoughts on|opinion|take on|commentary|sharing|my view)\b/.test(m)) {
    purpose = "raise profile";
  }

  // Educational framing
  if (/\b(information piece|explainer|overview|guide|introduction|basics|did you know)\b/.test(m)) {
    purpose = "educate";
  }

  // Neutral-only override
  if (/\b(neutral|purely informational|no agenda|academic)\b/.test(m)) {
    purpose = "educate";
  }

  return purpose;
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
- Mirror the client's cadence and word choices from this brief.
- Keep UK English and the structure spine.
- One analogy max, then literalise.
`.trim();
}

function buildMessages({ message, systemPrompt, history = [] }) {
  const safeHistory = history.slice(-4).map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000)
  }));
  return [
    { role: "system", content: systemPrompt },
    ...safeHistory,
    { role: "user", content: message }
  ];
}

// ===== PREFLIGHT (BRIEF STABILISER) =====
// Paste this whole block directly AFTER buildMessages() and BEFORE "// ===== RESEARCH HELPERS ====="

const PREFLIGHT_KEY = "_preflight";

// Heuristic: user is signalling a task, but hasn't given enough to draft.
function isUnclearBrief(message) {
  const m = String(message || "").trim();
  if (!m) return true;

  // If they've pasted real material, it's probably clear enough to proceed.
  if (m.length >= 220) return false;
  if ((m.match(/\r?\n/g) || []).length >= 2) return false;

  // If they've provided a URL, we can proceed into research flow.
  if (/https?:\/\/\S+/i.test(m)) return false;

  // Strong task intent markers with low detail often means "unclear brief".
  const intent = /\b(write|draft|rewrite|rework|create|make|fix|improve|help|need|want)\b/i.test(m);

  // Platform/context markers reduce ambiguity.
  const context = /\b(linkedin|newsletter|substack|blog|article|website|landing page|home page|about page|email|dm|pitch|bio)\b/i.test(m);

  // If it’s intent-heavy but context-light and short, treat as unclear.
  return intent && !context && m.length < 140;
}

function normaliseYesNo(text) {
  const t = String(text || "").trim().toLowerCase();

  const yes = [
    "yes",
    "yeah",
    "yep",
    "yup",
    "right",
    "correct",
    "spot on",
    "exactly",
    "nailed it",
    "that’s it",
    "that's it",
    "sounds right",
    "pretty much",
    "mostly",
    "more or less",
    "close enough"
  ];

  const no = [
    "no",
    "nah",
    "nope",
    "not really",
    "not quite",
    "not exactly",
    "off",
    "wrong",
    "actually",
    "sort of",
    "kind of",
    "but",
    "however",
    "except",
    "instead"
  ];

  // Simple scoring.
  let score = 0;
  for (const y of yes) if (t.includes(y)) score += 2;
  for (const n of no) if (t.includes(n)) score -= 2;

  if (score >= 2) return "YES";
  if (score <= -2) return "NO";
  return "UNKNOWN";
}

function getPreflightState(state) {
  const prefs = state?.preferences && typeof state.preferences === "object" ? state.preferences : {};
  const pf = prefs[PREFLIGHT_KEY] && typeof prefs[PREFLIGHT_KEY] === "object" ? prefs[PREFLIGHT_KEY] : {};
  return {
    pending: Boolean(pf.pending),
    assumption: typeof pf.assumption === "string" ? pf.assumption : "",
    createdAt: pf.createdAt || null
  };
}

function setPreflightStatePatch(state, next) {
  const prefs = state?.preferences && typeof state.preferences === "object" ? state.preferences : {};
  const existing = prefs[PREFLIGHT_KEY] && typeof prefs[PREFLIGHT_KEY] === "object" ? prefs[PREFLIGHT_KEY] : {};
  return {
    preferences: {
      ...prefs,
      [PREFLIGHT_KEY]: { ...existing, ...next }
    }
  };
}

async function generateWorkingAssumption({ openai, systemPrompt, userMessage }) {
  const prompt = `
You are a UK copy agent. The user has given an unclear brief.
Make a working assumption in ONE sentence: "So I'm getting X, aimed at Y, to do Z."
Then ask: "Am I on the right track?"
No other questions. No lists. No extra commentary.
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${prompt}\n\nUSER INPUT:\n${String(userMessage || "").slice(0, 1200)}` }
    ]
  });

  return completion?.choices?.[0]?.message?.content?.trim() || "So I'm getting you want something written, but the brief is still loose. Am I on the right track?";
}

/**
 * Preflight runner.
 * Returns:
 * - { action: "PROCEED" } to continue normal flow
 * - { action: "SHORT_CIRCUIT", reply, statePatch } to respond now and stop
 * - { action: "PROCEED_WITH_BRIEF", rewrittenMessage, statePatch } to proceed with a tightened brief
 */
async function runPreflight({
  message,
  user,
  state,
  voice,
  buildSystemPrompt
}) {
  const m = String(message || "").trim();
  const pf = getPreflightState(state);

  // If a preflight is pending, interpret this message as the user's correction/confirmation.
  if (pf.pending) {
    const yn = normaliseYesNo(m);

    // If they broadly agree, clear pending and proceed as normal with their original task.
    if (yn === "YES") {
      const statePatch = setPreflightStatePatch(state, { pending: false });
      return { action: "PROCEED", statePatch };
    }

    // If they disagree or qualify, treat their reply as data and proceed with a tightened brief.
    // We do not re-run preflight. We fold their correction into a single rewritten message.
    const rewrittenMessage = pf.assumption
      ? `${pf.assumption}\n\nUser correction/addition:\n${m}`
      : m;

    const statePatch = setPreflightStatePatch(state, { pending: false });
    return { action: "PROCEED_WITH_BRIEF", rewrittenMessage, statePatch };
  }

  // No preflight pending: decide if this brief is unclear enough to stabilise.
  if (!isUnclearBrief(m)) return { action: "PROCEED" };

  const openai = await getOpenAI();
  if (!openai) {
    // If OpenAI is unavailable, fail safe: ask the hinge question plainly.
    const reply = `So I'm getting you want something written, but the brief is still loose. Am I on the right track?`;
    const statePatch = setPreflightStatePatch(state, {
      pending: true,
      assumption: "Working assumption: user wants something written but brief is loose.",
      createdAt: new Date().toISOString()
    });
    return { action: "SHORT_CIRCUIT", reply, statePatch };
  }

  const systemPrompt = buildSystemPrompt({ user, state, voice });
  const reply = await generateWorkingAssumption({
    openai,
    systemPrompt,
    userMessage: m
  });

  const statePatch = setPreflightStatePatch(state, {
    pending: true,
    assumption: reply.split(/\n+/)[0] || "",
    createdAt: new Date().toISOString()
  });

  return { action: "SHORT_CIRCUIT", reply, statePatch };
}

// ===== PROBLEM-FIRST GUARDRAIL =====
function buildProblemGuardrail(intentBlock) {
  if (!intentBlock) return "";

  const needsProblemFirst =
    /Business purpose:\s*(authority-building|build trust|raise profile|sell)/i.test(intentBlock) &&
    /Stance:\s*explanatory-with-implications/i.test(intentBlock);

  if (!needsProblemFirst) return "";

  return `
STRUCTURAL REQUIREMENT
- If you imply importance, benefit, protection, or action, you must first state the problem, risk, or loss that makes it necessary.
- Do not move to solutions, benefits, or calls to action without naming what is at stake.
`.trim();
}


// ===== RESEARCH HELPERS =====

// Fetch and strip a page for direct user URLs
async function fetchPageText(url) {
  const res = await fetch(url);
  const html = await res.text();

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, 8000);
}

// External search via Tavily-style API (plug your key into TAVILY_API_KEY)
async function webSearch(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: key
      },
      body: JSON.stringify({
        query,
        max_results: 5
      })
    });

    if (!res.ok) {
      console.error("webSearch HTTP error:", res.status);
      return [];
    }

    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (e) {
    console.error("webSearch failed:", e.message);
    return [];
  }
}

// ===== VOICE ANALYSIS =====
async function summariseClientVoice(texts) {
  const openai = await getOpenAI();
  if (!openai) return { style_brief: "", tone_notes: "" };

  const prompt = `
You are a voice analyst for a UK copywriter.
From the user's samples, produce:
1) STYLE_BRIEF: 6 to 10 tight lines on cadence, formality, sentence length, humour, common constructions.
2) TONE_NOTES: 3 to 6 lines with do and do-not guidance, plus word preferences.

Keep UK English. No coaching tone. No filler.

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
    const r = await pool.query(
      "SELECT sample_count FROM user_voice_profile WHERE email=$1",
      [email]
    );
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

// ===== AUTH + STATE HELPERS =====
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
  return r.rows[0] || null;
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
    await pool.query(
      "INSERT INTO chat_history (email, role, content) VALUES ($1, $2, $3)",
      [email, role, content]
    );
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

// ===== MESSAGE PROCESSOR WITH RESEARCH =====
async function processMessageWithContext({
  message,
  user,
  state,
  voice,
  mode,
  noSales,
  history,
  researchContext
}) {
  const nameLine = user?.name ? `User: ${user.name} <${user.email}>.` : "";
  const clientBrief = buildClientBrief(voice, state);

  const modeBlock = mode
    ? `
MODE: ${mode}
- Follow the ${mode} output shape.
- Do not pitch unless asked.
`.trim()
    : "";

  const salesBlock = noSales
    ? `
NO-SALES SWITCH
- Outline or how to. Do not include CTAs unless explicitly requested.
`.trim()
    : "";

  const researchBlock = researchContext
    ? `
RESEARCH MATERIAL
Use this as factual context. Prefer it over guessing.

${researchContext}
`.trim()
    : "";

const intentBlock =
  String(message).match(/INTENT ASSUMPTION[\s\S]*$/)?.[0] || "";

const guardrailBlock = buildProblemGuardrail(intentBlock);

const systemPrompt = [
  GLOBAL_RULES,
  clientBrief,
  guardrailBlock,
  researchBlock,
  modeBlock,
  salesBlock,
  nameLine
]
  .filter(Boolean)
  .join("\n\n");


  const openai = await getOpenAI();
  if (!openai) return `Noted. ${message}`;

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

// ===== STRIPE WEBHOOK =====
app.post("/stripe/webhook", async (req, res) => {
  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_SIGNING_SECRET
    );
    console.log("Stripe event:", event.type);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
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
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const cust = await stripe.customers.retrieve(sub.customer);
        await pool.query(
          "UPDATE users SET is_subscriber=false WHERE email=$1",
          [cust.email]
        );
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
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

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

// ===== POST-CHECKOUT =====
app.get("/post-checkout", async (req, res) => {
  const { session_id } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
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
    console.error("Post-checkout error:", err);
    res.status(500).send("Post-checkout failed");
  }
});

// ===== USER INFO =====
app.get("/user-info/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const result = await pool.query(
      "SELECT name, is_subscriber, api_token FROM users WHERE email=$1",
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("User info error:", err);
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

// ===== CHAT ROUTE (WITH RESEARCH) =====
app.post("/chat", async (req, res) => {
  let { email, token, message } = req.body;




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
    let voice = await getVoice(email);

    maybeLearnFromChat(email, message);

// ===== CHAT GREETING GUARD =====
const raw = String(message || "").trim().toLowerCase();

// Very short, non-task messages = chat, not work
const isGreeting =
  raw.length <= 12 &&
  /^(hey|hi|hello|hiya|yo|morning|afternoon|evening|you there)\b/.test(raw);

if (isGreeting) {
  const reply = "Alright. What are we working on?";
  await insertChatHistory(email, "assistant", reply);
  return res.json({ reply });
}

    // ===== PREFLIGHT GATE =====
    const preflightResult = await runPreflight({
      message,
      user,
      state,
      voice,
      buildSystemPrompt: ({ user, state, voice }) => {
        const clientBrief = buildClientBrief(voice, state);
        const nameLine = user?.name ? `User: ${user.name} <${user.email}>.` : "";
        return [GLOBAL_RULES, clientBrief, nameLine].filter(Boolean).join("\n\n");
      }
    });

    if (preflightResult?.statePatch) {
      state = await setState(email, preflightResult.statePatch);
    }

    if (preflightResult?.action === "SHORT_CIRCUIT") {
      const reply = preflightResult.reply;
      await insertChatHistory(email, "assistant", reply);
      return res.json({ reply });
    }

    if (preflightResult?.action === "PROCEED_WITH_BRIEF") {
      // Replace the message with the tightened brief and continue
      message = preflightResult.rewrittenMessage;
    }

       // ===== INTENT LOCK (PURPOSE + CONTEXT) =====
    const primaryPurpose = inferPrimaryPurpose(message);
    const contextDefaults = inferContextDefaults(message);

    const intentNote = `
INTENT ASSUMPTION
- Business purpose: ${primaryPurpose}
- Destination: ${contextDefaults.destination}
- Length: ${contextDefaults.length}
- Audience awareness: ${contextDefaults.awareness}
- Stance: ${contextDefaults.stance}

Proceed on this basis unless corrected.
`.trim();

    message = `${message}\n\n${intentNote}`;



    const cmd = parseCommand(message);

    // Simple commands handled before model
    if (cmd) {
      switch (cmd.type) {
        case "MENU": {
          const reply =
            "Here are a few things we could roll with.\n- Website about page tune up\n- LinkedIn profile rewrite for clarity\n- Service page sharpen for conversions\n- Landing page quick audit\n- Headline and CTA set\nPick one, or throw me your own.";
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }
        case "MENU_AGAIN": {
          const reply =
            "Fresh picks:\n- Bio rewrite for trust\n- Short email nurture outline\n- Offer page structure\n- FAQ block in your voice\n- Social post variants (3 to 5)\nWant one of these, or something else?";
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
            w => w.toLowerCase() !== String(cmd.word || "").toLowerCase()
          );
          state = await setState(email, { banned_words: next });
          const reply = `Removed from SIN BIN: ${cmd.word}`;
          await insertChatHistory(email, "assistant", reply);
          return res.json({ reply });
        }
        case "STOP":
          // fall through to drafting with current info
          break;
      }
    }


    // RESEARCH MODE:
    // - Any URLs in the message are fetched as source material.
    // - A first line starting "RESEARCH:" will trigger web search for that query.
    let researchContext = "";

    const urlMatches = String(message).match(/https?:\/\/\S+/g) || [];
    const urlSnippets = [];
    for (const u of urlMatches) {
      try {
        const txt = await fetchPageText(u);
        urlSnippets.push(`SOURCE: ${u}\n${txt}`);
      } catch (e) {
        console.error("fetchPageText failed for", u, e.message);
      }
    }

    const lines = String(message).split(/\r?\n/);
    const firstLine = lines[0] || "";
    let strippedMessage = message;
    const researchMatch = firstLine.match(/^RESEARCH:\s*(.+)$/i);
    if (researchMatch) {
      const q = researchMatch[1].trim();
      strippedMessage = lines.slice(1).join("\n") || message;
      try {
        const results = await webSearch(q);
        const searchSnips = results.map((r, i) => {
          return `${i + 1}) ${r.title || "Result"} - ${r.url || ""}\n${r.content || r.snippet || ""}`;
        });
        if (searchSnips.length) {
          researchContext += `SEARCH: ${q}\n${searchSnips.join("\n\n")}`;
        }
      } catch (e) {
        console.error("webSearch error:", e.message);
      }
    }

    if (urlSnippets.length) {
      const block = urlSnippets.join("\n\n");
      researchContext = researchContext
        ? `${researchContext}\n\n${block}`
        : block;
    }

    const mode = detectMode(strippedMessage);
    const noSales = mode === "OUTLINE";

    const stopTriggered = cmd?.type === "STOP";


    const finalMessage = stopTriggered
      ? "Draft now using current context. No clarifiers."
      : strippedMessage;

    const historyRows = await getRecentChatHistory(email, 4);
    voice = voice || (await getVoice(email));

    const reply = await processMessageWithContext({
      message: finalMessage,
      user,
      state,
      voice,
      mode,
      noSales,
      history: historyRows,
      researchContext
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

// ===== START SERVER: ENSURE TABLES, THEN LISTEN =====
const PORT = process.env.PORT || 3000;

ensureTables()
  .then(() => {
    console.log("Init complete");
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      pool
        .query("SELECT 1")
        .then(() => console.log("DB reachable"))
        .catch(e => console.error("DB ping issue:", e.message));
    });
  })
  .catch(e => {
    console.error("Table init error:", e.message);
  });
