// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // for Node <18
import dotenv from "dotenv";
import cors from "cors";
import Stripe from "stripe";

dotenv.config();

console.log("Loaded API Key:", process.env.OPENAI_API_KEY ? "✓ Found" : "✗ Missing");
console.log("Stripe Secret Key:", process.env.STRIPE_SECRET_KEY ? "✓ Found" : "✗ Missing");
console.log("Stripe Signing Secret:", process.env.STRIPE_SIGNING_SECRET ? "✓ Found" : "✗ Missing");
console.log("Stripe Price ID:", process.env.STRIPE_PRICE_ID ? process.env.STRIPE_PRICE_ID : "✗ Missing");

const app = express();

// Enable CORS with full pre-flight support
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("/chat", cors()); // respond to preflight requests

// ============ STRIPE SETUP ============
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_SIGNING_SECRET;

// Stripe needs raw body
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
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

  res.status(200).send("ok");
});
// ======================================

// Now add JSON parser for everything else
app.use(bodyParser.json());

// GLOBAL RULES
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

app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url);
  next();
});

// Chat endpoint
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  console.log("User message:", message);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: GLOBAL_RULES },
          { role: "user", content: message },
        ],
      }),
    });

    console.log("OpenAI status:", response.status);
    const data = await response.json();
    console.log("OpenAI raw:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || "OpenAI error" });
    }

    const reply = data.choices?.[0]?.message?.content || "No reply";
    console.log("AI reply:", reply);
    res.json({ reply });
  } catch (err) {
    console.error("Network/Fetch error:", err);
    res.status(500).json({ error: "Network error calling OpenAI" });
  }
});

// Create a checkout session for your subscription (GET so you can click it)
app.get("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: "https://agent-beta.onrender.com/success",
      cancel_url: "https://agent-beta.onrender.com/cancel",
    });

    console.log("🛒 Checkout session created:", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Error creating checkout session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
