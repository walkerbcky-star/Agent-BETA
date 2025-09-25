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

    // normal chat flow
    const reply = await processMessage(message, user); 
    return res.json({ reply });

  } catch (err) {
    console.error("❌ Chat error:", err);
    return res.status(500).json({ 
      error: "Asteroid strike. The world's ended. Sorry. If by chance it's actually us, try again in a moment..." 
    });
  }
});
