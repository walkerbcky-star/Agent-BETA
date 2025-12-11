// ===== SETUP ===== 
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import Stripe from "stripe";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import getRawBody from "raw-body";
import fetch from "node-fetch"; // <-- FIXED: added fetch import

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
- Ban words that weaken copy: "fundamentals", "here’s the thing", "fluff", "waffle".
- Respect user-added banned words.

MODES
- Recognise: LIGHT EDIT, EDIT, REWRITE, REBUILD, ASSESS, ANALYSE, DRAFT, OUTLINE, PROMPT, LONGFORM.
- Follow the expected shape for each.
- OUTLINE or how-to counts as no-sales unless explicitly requested.

CONTEXT TRIANGULATION
- Detect LinkedIn, blog post, article, newsletter, website copy automatically.
- If context is missing or unclear: ask once, "Where is this going: LinkedIn, website, email, or something else?"
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

// ... [ALL OTHER FUNCTIONS UNCHANGED] ...

// ===== CHAT ROUTE (WITH RESEARCH) =====
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
    let voice = await getVoice(email);

    maybeLearnFromChat(email, message);

    const cmd = parseCommand(message);

    // Simple commands handled before model
    if (cmd) {
      switch (cmd.type) {
        case "MENU":
          {
            const reply =
              "Here are a few things we could roll with.\n- Website about page tune up\n- LinkedIn profile rewrite for clarity\n- Service page sharpen for conversions\n- Landing page quick audit\n- Headline and CTA set\nPick one, or throw me your own.";
            await insertChatHistory(email, "assistant", reply);
            return res.json({ reply });
          }
        case "MENU_AGAIN":
          {
            const reply =
              "Fresh picks:\n- Bio rewrite for trust\n- Short email nurture outline\n- Offer page structure\n- FAQ block in your voice\n- Social post variants (3 to 5)\nWant one of these, or something else?";
            await insertChatHistory(email, "assistant", reply);
            return res.json({ reply });
          }
        case "REVIEW_AVATAR":
          {
            const clean = JSON.stringify(state?.avatar || {}, null, 2);
            const reply =
              clean && clean !== "{}"
                ? `Current avatar profile:\n${clean}\nAnything you want to tweak?`
                : "No avatar is set yet. Tell me who you serve in plain terms and I will store it.";
            await insertChatHistory(email, "assistant", reply);
            return res.json({ reply });
          }
        case "SET_AVATAR":
          {
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
        case "SET_PROFILE":
          {
            state = await setState(email, { my_profile: cmd.payload });
            const reply = "Profile saved.";
            await insertChatHistory(email, "assistant", reply);
            return res.json({ reply });
          }
        case "ADD_PROFILE":
          {
            const combined = `${state?.my_profile || ""}\n${cmd.payload}`.trim();
            state = await setState(email, { my_profile: combined });
            const reply = "Added to your profile.";
            await insertChatHistory(email, "assistant", reply);
            return res.json({ reply });
          }
        case "SINBIN_ADD":
          {
            const list = Array.isArray(state?.banned_words) ? state.banned_words : DEFAULT_SIN_BIN;
            const next = [...new Set([...list, cmd.word].filter(Boolean))];
            state = await setState(email, { banned_words: next });
            const reply = `Added to SIN BIN: ${cmd.word}`;
            await insertChatHistory(email, "assistant", reply);
            return res.json({ reply });
          }
        case "SINBIN_REMOVE":
          {
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
          break;
      }
    }

    // RESEARCH MODE:
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

    // <-- FIXED: renamed mode variable to avoid duplicate declaration -->
    const detectedMode = detectMode(strippedMessage);
    const noSales = detectedMode === "OUTLINE";

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
      mode: detectedMode,
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
