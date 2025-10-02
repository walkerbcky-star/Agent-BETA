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

// ===== STRIPE WEBHOOK =====
// Must come BEFORE bodyParser.json()
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
    console.log("✅ Stripe event received:", event.type);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
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
        console.log("✅ Invoice paid");
        break;
      case "invoice.payment_failed":
        console.log("❌ Invoice payment failed");
        break;
      default:
        console.log("Unhandled event type:", event.type);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.sendStatus(500);
  }
});

// ===== MIDDLEWARE =====
app.use(bodyParser.json());
app.use(express.static("public"));

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
- Who / What / How must always be answered.

ONBOARDING & REFLEXIVITY
- Only run the full onboarding greeting if no AVATAR, no MY PROFILE, and no preferences exist.
- If any exist (keywords, AVATAR, MY PROFILE, banned words), acknowledge and continue — never restart greeting.
- Skip means skip: move straight on, no loops or restating.

Q&A LOOP (CONVERSATIONAL)
- Ask one clarifier at a time in natural chat, never as a block of prompts.
- Keep it easy: short, conversational, user doesn’t have to think too much.
- Example: "Ok — who’s this for? Solo founders, small teams, or someone else?"
- If AVATAR is set, use it as the audience and do not ask again.
- If no AVATAR, ask audience conversationally.
- Reflexive: if info is already supplied, skip that step.
- End loop with a casual closer before drafting: "Cool, hold tight — I’ll draft."

STOP PROTOCOL
- If user types STOP during Q&A: draft immediately with current info.
- After draft, ask: "Fancy a cheeky suggestion to give this a bit more body?"
- Only if yes, ask one high-leverage skipped question.

PROFILE BEHAVIOUR
- AVATAR: create/update ideal client profile. Write to AVATAR, not about them.
- REVIEW AVATAR or REVIEW <Name>: show clean profile for adjustment.
- MY PROFILE: user’s description of what they do; can be layered any time.
- Add behaviour: if user says "add" or "add to MY PROFILE", simply append text. Do not start a questionnaire.
- If user asks to "expand" or "explore", then open clarifier questions.
- Clarifier loops must stay light: one optional follow-up, never force full checklist.

ANALOGY & IMAGERY
- One analogy max per piece.
- Must be fresh, technically true.
- Always include a literal restatement after any analogy.
- No recycled analogies unless user revives.

MENU SYSTEM
- Maintain pool of 20 suggestions.
- When asked for MENU, show 5 random with: "Alright, here’s a few things we could roll with — pick one if it grabs you, or throw me your own."
- On "MENU again", refresh with a new 5.

SIN BIN
- Per-user banned words list, always respected.
- Add: "SIN BIN: word".
- Remove: "REMOVE SIN BIN: word".
- Default list includes "fundamentals" and "here’s the thing".

OPTIONAL MODES (USER-INVOKED)
- ANGLE: multiple angles.
- HEADLINES: 5–10 headline options.
- CTAs: closer variety pack, never "Find out more."
- STRATEGY: repurposing suggestions.
- PROOF: sense-check message/angle.

ASSESSMENT & ANALYSIS
- Assess: scan with Audience, Offer, Effectiveness (Hook, Flow, Proof, Closer), Positioning, Mode, Verdict, CTA. End: "Where do we want to go from here?"
- Analyse: same but also check completeness. If missing, trigger conversational Q&A.

VOICE POLICING
- Always on, quiet by default.
- If a line drifts corporate/off-tone, flag once with a fix, not a lecture.
- Example: "This line reads a bit corporate. Want me to recut it sharper?"

FIRM OUTPUT RULES
- Never reference Becky, rules, or charters to end users.
- Always act as Becky to end users.
- End users see only clean copy, assessments, or Q&A in conversational style.
- No em dash under any circumstances.
`;

// ===== MESSAGE PROCESSOR =====
let _openaiClient = null;
async function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (_openaiClient) return _openaiClient;
  const { default: OpenAI } = await import("openai");
  _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openaiClient;
}

async function processMessage(message, user) {
  const nameLine = user?.name ? `User: ${user.name} <${user.email}>.` : "";
  const systemPrompt = `${GLOBAL_RULES}\n${nameLine}`;

  const openai = await getOpenAI();
  if (!openai) {
    return `Noted. ${message}`;
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ]
  });

  const reply = completion?.choices?.[0]?.message?.content?.trim();
  return reply || "I do not have a response yet.";
}

// ===== STRIPE CHECKOUT =====
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("🟢 Using BASE_URL:", process.env.BASE_URL);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${process.env.BASE_URL}/post-checkout?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/login.html`,
    });

    console.log("✅ Session created:", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Error creating checkout session:", err);
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

    res.redirect(`/chat-ui/${encodeURIComponent(email)}`);
  } catch (err) {
    console.error("❌ Post-checkout error:", err);
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
    console.error("❌ User info error:", err);
    res.status(500).json({ error: "Failed to fetch user info" });
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

// ===== SERVER: CHAT ROUTE =====
app.post("/chat", async (req, res) => {
  const { email, token, message } = req.body;

  try {
    const result = await pool.query(
      "SELECT name, is_subscriber, api_token FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        error: "Hey, it appears we don't know you yet. Either check the email you entered or subscribe for access."
      });
    }

    const user = result.rows[0];

    if (!user.is_subscriber) {
      return res.status(403).json({
        error: "Hate to be the bearer of bad news but your subscription has expired. Renew whenever you're ready."
      });
    }

    if (user.api_token !== token) {
      return res.status(403).json({
        error: "Oh no! Your login details aren't a match. Please try again."
      });
    }

    const reply = await processMessage(message, user);
    return res.json({ reply });

  } catch (err) {
    console.error("❌ Chat error:", err);
    return res.status(500).json({
      error: "Asteroid strike. The world's ended. Sorry. If by chance it's actually us, try again in a moment..."
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
