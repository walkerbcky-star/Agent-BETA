// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // for Node <18
import dotenv from "dotenv";
import cors from "cors";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-08-27.basil"
});

// Clean, inspectable env
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").trim();
const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY || "").trim();
const SIGNING_SECRET = (process.env.STRIPE_SIGNING_SECRET || "").trim();
const PRICE_ID = (process.env.STRIPE_PRICE_ID || "").trim();

console.log("Loaded API Key:", OPENAI_KEY ? "✓ Found" : "✗ Missing");
console.log("Stripe Secret Key:", STRIPE_SECRET ? "✓ Found" : "✗ Missing");
console.log("Stripe Signing Secret:", SIGNING_SECRET ? "✓ Found" : "✗ Missing");
// JSON.stringify shows hidden characters if any
console.log("Stripe Price ID:", PRICE_ID ? JSON.stringify(PRICE_ID) : "✗ Missing");

// CORS
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("/chat", cors());

// Stripe webhook: must receive raw body
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, SIGNING_SECRET);
    console.log("✅ Stripe event received:", event.type);
  } catch (err) {
    console.error("❌ Stripe signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    console.log("💰 Payment succeeded:", paymentIntent.id);
  }
  if (event.type === "customer.subscription.created") {
    const subscription = event.data.object;
    console.log("📦 Subscription created:", subscription.id);
  }
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    console.log("🧾 Invoice paid:", invoice.id);
  }

  res.status(200).send("ok");
});

// JSON parser for everything else
app.use(bodyParser.json());

// Minimal static routes for your pages
app.get("/success", (_req, res) => res.sendFile(path.join(__dirname, "success.html")));
app.get("/cancel", (_req, res) => res.sendFile(path.join(__dirname, "subscribe.html")));
app.get("/", (_req, res) => res.send("alive"));

// Your chat endpoint (unchanged logic)
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

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
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
      return res.status(response.status).json({ error: data.error?.message || "OpenAI error" });
    }
    const reply = data.choices?.[0]?.message?.content || "No reply";
    res.json({ reply });
  } catch (err) {
    console.error("Network/Fetch error:", err);
    res.status(500).json({ error: "Network error calling OpenAI" });
  }
});

// Create Checkout Session
// 1) try with your Price ID (trimmed)
// 2) if Stripe still says "no such price", fall back to inline price_data so you can proceed
app.get("/create-checkout-session", async (_req, res) => {
  try {
    // Prove the price exists with your key, and log details
    const price = await stripe.prices.retrieve(PRICE_ID);
    console.log("🔎 Retrieved price:", {
      id: price.id,
      active: price.active,
      currency: price.currency,
      recurring: price.recurring
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: "https://agent-beta.onrender.com/success",
      cancel_url: "https://agent-beta.onrender.com/cancel"
    });

    console.log("🛒 Checkout session created:", session.id);
    return res.json({ url: session.url });
  } catch (err) {
    console.error("Price path failed:", err.message);

    // Fallback: inline price for test so you can move forward now
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{
          price_data: {
            currency: "gbp",
            recurring: { interval: "month" },
            unit_amount: 500, // £5.00
            product_data: { name: "Agent Test Subscription (inline fallback)" }
          },
          quantity: 1
        }],
        success_url: "https://agent-beta.onrender.com/success",
        cancel_url: "https://agent-beta.onrender.com/cancel"
      });
      console.log("🛒 Fallback session created:", session.id);
      return res.json({ url: session.url, note: "Using inline fallback price" });
    } catch (fallbackErr) {
      console.error("❌ Fallback also failed:", fallbackErr.message);
      return res.status(500).json({ error: fallbackErr.message });
    }
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
