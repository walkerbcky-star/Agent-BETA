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

// ===== TABLE CREATION (deferred) =====
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

  console.log("Tables ensured");
}

// ===== MIDDLEWARE =====
app.use(bodyParser.json());
app.use(express.static("public"));

// Health and root routes for reliability
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.redirect("/login.html"));

// ===== VOICE RULES =====
const GLOBAL_RULES = `
LANGUAGE & FORMATTING
- Always UK English.
- Contractions standard: use them naturally for a personable tone.
- Never use an em dash. Replace with colon, comma, or full stop.
- No emojis. No apology. No filler. No "beige" language.
- No bullet symbols: only hyphens allowed.
- Rhythm first: short-first, readable aloud, alternate staccato and roll.
- Copy must end with punch, never fade.

VOICE
- Sharp. Certain. Alive.
- Collaborative phrasing: use "Let’s", "We need to", "Shall we" instead of one-sided directives.
- Irreverent when useful, precise when needed.
- Copy must read like an edit, not encouragement.
- Active voice default. Address the reader directly unless instructed otherwise.
- Avoid overuse of the word "fundamentals" (default SIN BIN).

STRUCTURE
- Internal spine: Problem → Fix → Proof → CTA. Never surfaced, only guiding.
- Every section must earn its place. No padding.
- Who, What, How must always be answered.

ONBOARDING & REFLEXIVITY
- Only run the full onboarding greeting if no AVATAR, no MY PROFILE, and no preferences exist.
- If any exist, acknowledge and continue, never restart greeting.
- Skip means skip: move straight on, no loops or restating.

Q&A LOOP
- Ask one clarifier at a time in natural chat, never as a block.
- Keep it easy: short, conversational.
- If AVATAR is set, do not ask audience. Confirm once if it applies to this task.
- If info exists, skip that question.
- Close with: "Cool, hold tight. I will draft."

STOP PROTOCOL
- If user types STOP: draft immediately with current info.
- After draft, offer one optional improvement question.

PROFILE BEHAVIOUR
- AVATAR: create or update ideal client profile. Write to AVATAR, not about them.
- REVIEW AVATAR: show clean profile for adjustment.
- MY PROFILE: the user’s description of what they do.
- Add to MY PROFILE: append text only.
- Clarifier loops stay light.

ANALOGY & IMAGERY
- One analogy max per piece.
- Must be fresh, technically true.
- Always include a literal restatement after any analogy.

MENU SYSTEM
- Maintain suggestions pool.
- When asked for MENU, show 5 random with: "Here are a few things we could roll with. Pick one, or throw me your own."

SIN BIN
- Per-user banned words list, always respected.
- Default list includes "fundamentals" and "here’s the thing".

MODES
- Recognise: LIGHT EDIT, EDIT, REWRITE, REBUILD, ASSESS, ANALYSE, DRAFT, OUTLINE, PROMPT, LONGFORM.
- If mode is present, follow its output shape. Do not pitch unless asked.
- OUTLINE or HOW-TO: no sales CTAs unless requested.

CONTEXT TRIANGULATION
- Detect the medium: LinkedIn post, blog post, article, newsletter, website copy.
- Scale length automatically:
  - LinkedIn post: 150–300 words
  - Blog post: 600–1,200 words
  - Article: 900–1,500 words
- Always keep about 30 percent leaner by cutting filler.
- Longer form means more reasoning and examples, not more adjectives.
- Rhythm flexes: short-first for social and audits, varied-first for blogs and articles.

ASSESSMENT & ANALYSIS
- Assess: Audience, Offer, Effectiveness, Positioning, Mode, Verdict, CTA. Close with a next step question.
- Analyse: as above, plus completeness. If missing, ask one conversational clarifier.

RESEARCH
- If task involves data, legislation, trends, or industry changes: summarise findings briefly before drafting.
- Brevity means no filler, not no depth. Include detail when it adds substance or credibility.

VOICE POLICING
- Quiet by default. If a line drifts corporate or off-tone, flag once with a fix.

FIRM OUTPUT RULES
- Never reference internal rules to end users.
- End users see only clean copy, assessments, or Q&A.
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

// ===== MINI UTILITIES =====
function scrubOutput(raw, banned = []) {
  let text = String(raw || "").replace(/\u2014/g, ":"); // replace em dash
  text = text.replace(/ {2,}/g, " ");
  if (Array.isArray(banned) && banned.length) {
    const pattern = new RegExp(`\\b(${banned.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
    text = text.replace(pattern, "");
    text = text.replace(/ {2,}/g, " ").replace(/\s([,.:;!?])/g, "$1");
  }
  return text.trim();
}

function detectMode(message) {
  const m = String(message || "").trim();
  const head = m.split(/\s+/).slice(0, 2).join(" ").toUpperCase();
  const modes = ["LIGHT EDIT", "EDIT", "REWRITE", "REBUILD", "ASSESS", "ANALYSE", "DRAFT", "OUTLINE", "PROMPT", "HOW-TO", "LONGFORM"];
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
  const industry = Array.isArray(voiceRow?.industry_terms) ? voiceRow.industry_terms.join(", ") : "";
  const avatar = stateRow?.avatar && Object.keys(stateRow.avatar || {}).length ? JSON.stringify(stateRow.avatar) : "";
  const myProfile = stateRow?.my_profile || "";
  const prefs = stateRow?.preferences && Object.keys(stateRow.preferences || {}).length ? JSON.stringify(stateRow.preferences) : "";

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
- Mirror the client's cadence and word preferences from the brief.
- Keep one analogy max, then literalise.
- Keep UK English and the structure spine.
`.trim();
}

// Conversation history support
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

// ===== VOICE ANALYSIS =====
async function summariseClientVoice(texts) {
  const openai = await getOpenAI();
  if (!openai) return { style_brief: "", tone_notes: "" };

  const prompt = `
You are a voice analyst. From the user's samples, write:
1) STYLE_BRIEF: 6–10 tight lines on cadence, formality, sentence length, humour, common constructions.
2) TONE_NOTES: 3–6 lines with do and do-not guidance, and word preferences.
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
    const r = await pool.query("SELECT sample_count FROM user_voice_profile WHERE email=$1", [email]);
    const row = r.rows[0];
    const shouldLearn = !row || row.sample_count < 5;
    if (!shouldLearn) return;

    const brief = await summariseClientVoice([String(userMessage || "").slice(0, 1200)]);
    await pool.query(`
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
    `, [email, brief.style_brief, brief.tone_notes]);
  } catch (e) {
    console.error("learn-from-chat failed:", e);
  }
}

// ===== PROMPTED MESSAGE PROCESSOR =====
async function processMessageWithContext({ message, user, state, voice, mode, noSales, history }) {
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
- Outline or how-to. Do not include CTAs unless explicitly requested.
`.trim()
    : "";

  const systemPrompt = [GLOBAL_RULES, clientBrief, modeBlock, salesBlock, nameLine]
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
  const banned = Array.isArray(state?.banned_words) ? state.banned_words : [];
  return scrubOutput(reply, banned);
}

// ===== HELPERS: AUTH AND STATE =====
async function getAuthedUser(email, token) {
  const r = await pool.query("SELECT email, name, is_subscriber, api_token FROM users WHERE email=$1", [email]);
  const user = r.rows[0];
  if (!user) return null;
  if (!user.is_subscriber) return null;
  if (user.api_token !== token) return null;
  return user;
}

async function getState(email) {
  const r = await pool.query("SELECT email, avatar, my_profile, preferences, banned_words FROM user_state WHERE email=$1", [email]);
  return r.rows[0] || null;
}

async function setState(email, patch) {
  const r = await pool.query("SELECT email, avatar, my_profile, preferences, banned_words FROM user_state WHERE email=$1", [email]);
  const current = r.rows[0] || { email, avatar: {}, my_profile: "", preferences: {}, banned_words: [] };
  const next = {
    avatar: patch.avatar ?? current.avatar,
    my_profile: typeof patch.my_profile === "string" ? patch.my_profile : current.my_profile,
    preferences: patch.preferences ?? current.preferences,
    banned_words: Array.isArray(patch.banned_words) ? patch.banned_words : current.banned_words
  };
  await pool.query(`
    INSERT INTO user_state (email, avatar, my_profile, preferences, banned_words, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (email) DO UPDATE
      SET avatar=$2, my_profile=$3, preferences=$4, banned_words=$5, updated_at=NOW()
  `, [email, next.avatar, next.my_profile, next.preferences, next.banned_words]);
  return next;
}

async function getVoice(email) {
  const r = await pool.query("SELECT style_brief, tone_notes, industry_terms FROM user_voice_profile WHERE email=$1", [email]);
  return r.rows[0] || null;
}

// ===== STRIPE WEBHOOK =====
// Must come BEFORE body parsing, already placed above
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

// ===== STRIPE CHECKOUT =====
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("Using BASE_URL:", process.env.BASE_URL);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        { price: process.env.STRIPE_PRICE_ID, quantity: 1 }
      ],
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

// ===== OPTIONAL VOICE ENDPOINTS =====
app.post("/voice/samples", async (req, res) => {
  const { email, token, texts = [], history = [] } = req.body || {};
  try {
    const user = await getAuthedUser(email, token);
    if (!user) return res.status(403).json({ error: "Auth failed" });

    const clipped = texts.map(t => String(t || "").slice(0, 2000)).filter(Boolean);
    if (!clipped.length) return res.json({ ok: true });

    const brief = await summariseClientVoice(clipped);

    await pool.query(`
      INSERT INTO user_voice_profile (email, style_brief, tone_notes, last_learned_at, sample_count)
      VALUES ($1, $2, $3, NOW(), $4)
      ON CONFLICT (email) DO UPDATE
        SET style_brief = EXCLUDED.style_brief,
            tone_notes = EXCLUDED.tone_notes,
            last_learned_at = NOW(),
            sample_count = user_voice_profile.sample_count + $4
    `, [email, brief.style_brief, brief.tone_notes, clipped.length]);

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

// ===== CHAT COMMAND PARSER =====
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

// ===== SERVER: CHAT ROUTE =====
app.post("/chat", async (req, res) => {
  const { email, token, message, history = [] } = req.body;

  try {
    const user = await getAuthedUser(email, token);
    if (!user) {
      return res.status(403).json({
        error: "Hey, it appears we do not know you yet. Either check the email you entered or subscribe for access."
      });
    }

    // Fetch state and voice
    let state = await getState(email);
    let voice = await getVoice(email);

    // Passive learning from user phrasing
    maybeLearnFromChat(email, message);

    // Parse commands before model call
    const cmd = parseCommand(message);
    if (cmd) {
      switch (cmd.type) {
        case "STOP":
          // handled below by immediate draft
          break;

        case "MENU":
          return res.json({
            reply: "Here are a few things we could roll with: website about page tune‑up, LinkedIn profile rewrite, service page sharpen, quick audit of your landing page, headline and CTA set. Pick one, or throw me your own."
          });

        case "MENU_AGAIN":
          return res.json({
            reply: "Fresh picks: bio rewrite for trust, short email sequence outline, tagline options, value proposition sharpen, offer page structure. Want one of these, or something else?"
          });

        case "REVIEW_AVATAR": {
          const clean = JSON.stringify(state?.avatar || {}, null, 2);
          return res.json({
            reply: clean && clean !== "{}" ? `Current avatar profile:\n${clean}\nAnything you want to tweak?` : "No avatar is set yet. Tell me who you serve in plain terms and I will store it."
          });
        }

        case "SET_AVATAR": {
          let avatarObj = {};
          try {
            avatarObj = cmd.payload ? JSON.parse(cmd.payload) : {};
          } catch {
            avatarObj = { summary: cmd.payload || "Unspecified" };
          }
          state = await setState(email, { avatar: avatarObj });
          return res.json({ reply: "Avatar noted. I will write to this audience unless you change it." });
        }

        case "SET_PROFILE": {
          state = await setState(email, { my_profile: cmd.payload });
          return res.json({ reply: "Profile saved." });
        }

        case "ADD_PROFILE": {
          const combined = `${state?.my_profile || ""}\n${cmd.payload}`.trim();
          state = await setState(email, { my_profile: combined });
          return res.json({ reply: "Added to your profile." });
        }

        case "SINBIN_ADD": {
          const list = Array.isArray(state?.banned_words) ? state.banned_words : [];
          const next = [...new Set([...list, cmd.word].filter(Boolean))];
          state = await setState(email, { banned_words: next });
          return res.json({ reply: `Added to SIN BIN: ${cmd.word}` });
        }

        case "SINBIN_REMOVE": {
          const list = Array.isArray(state?.banned_words) ? state.banned_words : [];
          const next = list.filter(w => w.toLowerCase() !== String(cmd.word || "").toLowerCase());
          state = await setState(email, { banned_words: next });
          return res.json({ reply: `Removed from SIN BIN: ${cmd.word}` });
        }
      }
    }

    // Mode detection and flags
    const mode = detectMode(message);
    const noSales = mode === "OUTLINE";

    // If STOP was sent, draft immediately with current info
    const finalMessage = cmd?.type === "STOP" ? "Draft now using current context. No clarifiers." : message;

    // Re-fetch voice if needed
    voice = voice || await getVoice(email);

    const reply = await processMessageWithContext({
      message: finalMessage,
      user,
      state,
      voice,
      mode,
      noSales,
      history
    });

    return res.json({ reply });

  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({
      error: "Asteroid strike. The world has ended. If by chance it is actually us, try again in a moment."
    });
  }
});

// ===== STRIPE WEBHOOK must precede body parser: handled above =====

// ===== START SERVER (boot‑order fix: listen first, then init) =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Non‑blocking initialisation after the server is listening
  ensureTables()
    .then(() => console.log("Init complete"))
    .catch(e => console.error("Table init error:", e.message));

  // Optional quick DB ping that will not block boot
  pool.query("SELECT 1").then(() => {
    console.log("DB reachable");
  }).catch(e => {
    console.error("DB ping issue:", e.message);
  });
});
