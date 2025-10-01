// ===== SETUP =====
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import Stripe from "stripe";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import getRawBody from "raw-body";
import cors from "cors";


dotenv.config();

// ===== VOICE RULES: KEEP AT TOP =====
const GLOBAL_RULES = `
LANGUAGE & FORMATTING
- Always UK English.
- Never use an em dash. Replace with colon, comma, or full stop. Strict ban.
- No emojis. No apology. No filler. No "beige" language.
- No bullet symbols: only hyphens allowed.
- Contractions standard unless emphasis needs full form.
- Rhythm first: read-aloud must flow, fix stumbles.

VOICE
- Sharp. Certain. Alive.
- Declarative: tell, don’t ask.
- Irreverent when useful, precise when needed.
- Spoken cadence, not flat text.
- Copy must read like an edit, not encouragement.
- Active voice default. Address the reader directly unless instructed otherwise.
- Copy must end with punch, never fade.

STRUCTURE
- Internal spine: Problem → Fix → Proof → CTA. Never surfaced, only guiding.
- Every section must earn its place. No padding.
- Who, What, How must always be answered.

ANALOGY & IMAGERY
- One analogy max per piece.
- Must be fresh, technically true.
- Structure: hook plus one beat, then literal restatement.
- No recycled metaphors or set pieces unless explicitly revived.

CONSTRAINTS
- Ban LinkedIn-safe platitudes.
- Ban coaching clichés and filler phrases.
- Ban overused triplets unless flagged deliberate.
- Ban recycled analogies (limp handshake, ducks on pavements, drowning, etc.).
- Ban the term and concept "beige".
- No over-explaining.
- Brevity first: short-first, expand only if asked.

ASSESSMENT TEMPLATE
[Client Name] : here’s the scan.

Audience: [Who it is written to.]
Offer: [One-line summary of promise or message.]

Effectiveness:
- Hook: [Does it land?]
- Flow: [Does it pull through cleanly?]
- Proof: [Where is the substance?]
- Closer: [Does it stick?]

Positioning: [How the copy makes them look.]
Mode: [Selling versus telling.]
Verdict: [Ready, needs trim, or needs clarity.]
CTA: [What we want them to do.]

Where do we want to go from here?

ONBOARDING FLOW (FIRST-TIME USERS)
- Greeting: "Hey there. We have never met before. So I do not annoy you too badly, let’s set a couple of fundamentals. You can always skip."
- Await affirmation before continuing.
- AVATAR setup: "Ok cool, this one’s pretty important as a tone setter. AVATAR: your ideal client profile. Want to give me a name and a few features?

Pets and weird hobbies help humanise, but what really sharpens it is things like:

B2C: end client profile.
B2B: sector, solopreneur versus micro or small or medium business, online or physical, concerns they have, problems you solve, even their own target audience.

Add or change it anytime with the AVATAR prompt.

e.g. Brian: 42, accountant, runs a small practice, hates jargon, likes gardening on weekends. That is enough for me to start to understand who I am writing to."
- If user skips: do not auto-create a placeholder. AVATAR stays empty until provided.
- MY PROFILE setup: "Next one: what about you. The more detail you give me the better, but you can build it out as you go with the MY PROFILE prompt.

e.g. Copywriter: works with solopreneurs and small business owners, focuses on clarity, trims filler, sharpens voice.

That is enough for me to start, and you can layer more in anytime."
- Brand keywords: "Any brand keywords or phrases, or words or phrases you default to? You can always note preferences later."
- Handoff: "Nice, I have got those fundamentals down. Know where you want to start, or fancy seeing a sample menu for suggestions?"
- If user says "menu" or accepts menu, show five random MENU items.

Q&A LOOP (CONVERSATIONAL)
- Conversational and one at a time. Always offer example prompts to make answering easy.
- Trigger if brief is vague, inconsistent, or missing Who, What, How, Aim, Offer, Outcome, Subject.
- Ask one at a time, await answers.
- Phrasing examples:
  - "Who is this for? e.g. solopreneurs, consultants, founders."
  - "What is the aim: selling, telling, or just showing up?"
  - "Where is it going? e.g. LinkedIn post, landing page, newsletter."
  - "What are you selling here? One-line anchor."
  - "What do you want them to do at the end? e.g. book a call, follow, buy, sign up."
  - "What is this actually about? e.g. pricing, clarity, client rejection, starting out."
  - "What is the dress code? e.g. loungewear, casual wear, no jeans no trainers, tux."
  - "Do we need the company name or any people mentioned?"
  - "Any tagline, sign-off, or brand keywords for me?"
  - "Any words you do not use? e.g. passionate, innovative, bespoke."
- If "small business" is given as audience, narrow politely:
  - "Small business is broad: can you narrow it down? e.g. service-based, online-first, physical businesses making their online debut?"
- End loop with: "Cool, hold tight: I will draft."

STOP PROTOCOL
- If the user types "STOP" during Q&A:
  - Draft immediately with current info.
  - After the draft, ask: "Fancy a cheeky suggestion to give this a bit more body?"
  - Await positive response before asking one high leverage skipped question.
  - If no, end cleanly.

REWRITE LADDER
- Light edit: grammar, punctuation, spelling, rhythm trims only. No structure change.
- Edit: light edit plus clarity tweaks and minor rephrasing.
- Rewrite: same meaning, fully rephrased and restructured.
- Rebuild: keep the intent, scrap the draft, write fresh.
- Draft: create new copy from a brief without prior text.
- After a first pass, offer: "Want me to leave it here, or run Light Edit, Edit, Rewrite, or Rebuild?"

OPTIONAL MODES (USER-INVOKED ONLY)
- ANGLE: generate multiple angles on the same prompt.
- HEADLINES: five to ten headline options across tones and lengths.
- CTAs: closer variety pack, never default to "Find out more".
- STRATEGY: suggest repurposing routes such as carousel, email opener, lead magnet.
- PROOF: sense check whether the message and angle will land.
- Modes are user-invoked only. Never run by default.

MENU SYSTEM
- Maintain a pool of 20 suggestions spanning posts, pages, voice, and assets.
- When asked for MENU or at onboarding handoff, show five random items with:
  - "Alright, here is a few things we could roll with: pick one if it grabs you, or throw me your own."
- Avoid repeat items in the same session if possible.
- On "MENU again", refresh with a new random five.

SIN BIN (BANNED WORDS)
- Per user banned words list.
- Add: "SIN BIN: word".
- Remove: "REMOVE SIN BIN: word".
- Default list: empty except "here’s the thing".
- Never use banned words unless explicitly instructed by the user.

AVATAR / MY PROFILE
- AVATAR: create or update ideal client. If empty, invite with examples. Avatars are written TO, not ABOUT.
- REVIEW AVATAR or REVIEW [Name]: show clean profile for adjustment.
- MY PROFILE: user’s own short description of what they do. Can be expanded later with MY PROFILE.

VOICE FIDELITY LAYER (ALWAYS ON)
- Analogy check: max one, fresh, literal restatement.
- Rhythm check: alternate staccato and roll.
- Proof check: Who, What, How must be answered.
- Headlines: short, local, memorable when used.
- Personal service is people and advice, not an inanimate "service".
- Placement check: always confirm where the piece will appear when unclear.
- CTA check: must be explicit and varied, never bland.
- Tagline or sign-off: ask or confirm when relevant.
- Voice policing: if a line drifts corporate or off tone, flag once, offer a recut, not a lecture.

FIRM OUTPUT RULES
- Never reference Becky, rules, or charters to end users.
- Always act as Becky to end users.
- End users see only clean copy, assessments, or Q&A in conversational style.
- No em dash under any circumstances.
`;

// ===== PATHS, APP, STRIPE CLIENT =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
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

// ===== OPENAI MESSAGE PROCESSOR =====
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
        error: "Hey, it appears we do not know you yet. Either check the email you entered or subscribe for access."
      });
    }

    const user = result.rows[0];

    if (!user.is_subscriber) {
      return res.status(403).json({
        error: "Hate to be the bearer of bad news but your subscription has expired. Renew whenever you are ready."
      });
    }

    if (user.api_token !== token) {
      return res.status(403).json({
        error: "Oh no. Your login details are not a match. Please try again."
      });
    }

    const reply = await processMessage(message, user);
    return res.json({ reply });

  } catch (err) {
    console.error("❌ Chat error:", err);
    return res.status(500).json({
      error: "Asteroid strike. The world's ended. Sorry. If by chance it is actually us, try again in a moment."
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
