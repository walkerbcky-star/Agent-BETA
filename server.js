import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // for Node <18
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

console.log("Loaded API Key:", process.env.OPENAI_API_KEY ? "✓ Found" : "✗ Missing");

const app = express();

// Enable CORS with full pre-flight support
app.use(cors({
  origin: "*",  // allow all origins for now
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("/chat", cors()); // respond to preflight requests

app.use(bodyParser.json());

// GLOBAL RULES: paste your Quick Reference text here
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
        model: "gpt-4o-mini",   // try "gpt-4o" if this gives model errors
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



  const messages = [
    { role: "system", content: GLOBAL_RULES },
    { role: "user", content: message },
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, // reads from .env
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // choose model
        messages,
      }),
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "No reply";

    console.log("AI reply:", reply);
    res.json({ reply });
  } catch (err) {
    console.error("Error talking to OpenAI:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
