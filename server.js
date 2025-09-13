// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
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

// Clean env vars
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").trim();
const SIGNING_SECRET = (process.env.STRIPE_SIGNING_SECRET || "").trim();
const PRICE_ID = (process.env.STRIPE_PRICE_ID || "").trim();

console.log("Stripe Price ID:", PRICE_ID);

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Webhook
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, SIGNING_SECRET);
    console.log("✅ Stripe event received:", event.type);
    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Serve static pages
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "subscribe.html")));
app.get("/success", (_req, res) => res.sendFile(path.join(__dirname, "success.html")));
app.get("/cancel", (_req, res) => res.sendFile(path.join(__dirname, "subscribe.html")));

// Chat endpoint (unchanged)
const GLOBAL_RULES = `...`;
app.post("/chat", async (req, res) => { /* unchanged */ });

// Checkout session
app.get("/create-checkout-session", async (_req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: "https://agent-beta.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://agent-beta.onrender.com/cancel"
    });
    console.log("🛒 Checkout session created:", session.id);
    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Error creating session:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// New: fetch session details for success.html
app.get("/session-status", async (req, res) => {
  const sessionId = req.query.session_id;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"]
    });
    res.json(session);
  } catch (err) {
    console.error("❌ Error retrieving session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
