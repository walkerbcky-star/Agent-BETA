// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ===== STRIPE SETUP =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-06-30.basil",
});

// Hard-coded for testing. Replace with env var later.
const PRICE_ID = "price_1S8go1CBPtCaSboQpciy2HQK";
const SIGNING_SECRET = (process.env.STRIPE_SIGNING_SECRET || "").trim();

// ===== POSTGRES SETUP =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Test DB connection
(async () => {
  try {
    const client = await pool.connect();
    console.log("✅ Connected to Postgres database");
    client.release();
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
  }
})();

// ===== OPENAI SETUP =====
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").trim();

// ===== VOICE RULES =====
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

// ===== STRIPE WEBHOOK =====
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, SIGNING_SECRET);
      console.log("✅ Stripe event received:", event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const email = session.customer_details.email;
        const customerId = session.customer;

        console.log(`💡 Checkout completed for ${email}`);

        await pool.query(
          `INSERT INTO users (email, stripe_customer_id, is_subscriber)
           VALUES ($1, $2, true)
           ON CONFLICT (email)
           DO UPDATE SET stripe_customer_id = $2, is_subscriber = true, updated_at = NOW()`,
          [email, customerId]
        );
        console.log("📦 User updated in DB");
      }

      if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object;
        const customerId = subscription.c
