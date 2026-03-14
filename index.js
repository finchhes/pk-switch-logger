import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ── Config (set these as environment variables) ──────────────────────────────
const SIGNING_TOKEN = process.env.PK_SIGNING_TOKEN;   // from PluralKit dashboard
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; // Discord webhook URL
const PORT = process.env.PORT || 3000;
// ─────────────────────────────────────────────────────────────────────────────

if (!SIGNING_TOKEN || !DISCORD_WEBHOOK_URL) {
  console.error("❌  Missing required env vars: PK_SIGNING_TOKEN and/or DISCORD_WEBHOOK_URL");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMembers(members) {
  if (!members || members.length === 0) return "*no one (cleared)*";
  return members.map((m) => `**${m}**`).join(", ");
}

function buildDiscordEmbed(event) {
  const { type, system_id, id, data } = event;

  switch (type) {
    case "CREATE_SWITCH": {
      const members = formatMembers(data?.members);
      return {
        username: "PluralKit Switch Log",
        avatar_url: "https://pluralkit.me/favicon.png",
        embeds: [
          {
            title: "🔄 New Switch Logged",
            color: 0x5865f2,
            fields: [
              { name: "Fronting", value: members, inline: false },
              { name: "Switch ID", value: `\`${id}\``, inline: true },
              { name: "System", value: `\`${system_id}\``, inline: true },
              ...(data?.timestamp
                ? [{ name: "Time", value: `<t:${Math.floor(new Date(data.timestamp).getTime() / 1000)}:F>`, inline: false }]
                : []),
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    case "UPDATE_SWITCH": {
      const members = formatMembers(data?.members);
      return {
        username: "PluralKit Switch Log",
        avatar_url: "https://pluralkit.me/favicon.png",
        embeds: [
          {
            title: "✏️ Switch Updated",
            color: 0xfee75c,
            fields: [
              ...(data?.members !== undefined
                ? [{ name: "New Fronters", value: members, inline: false }]
                : []),
              ...(data?.timestamp
                ? [{ name: "New Time", value: `<t:${Math.floor(new Date(data.timestamp).getTime() / 1000)}:F>`, inline: false }]
                : []),
              { name: "Switch ID", value: `\`${id}\``, inline: true },
              { name: "System", value: `\`${system_id}\``, inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    default:
      return null;
  }
}

async function sendToDiscord(payload) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook failed (${res.status}): ${text}`);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  const event = req.body;

  // 1. Validate signing token
  if (!event || event.signing_token !== SIGNING_TOKEN) {
    console.warn("⚠️  Invalid or missing signing_token — rejecting request");
    return res.status(401).json({ error: "Invalid signing token" });
  }

  const { type } = event;
  console.log(`📨 Received event: ${type}`);

  // 2. Handle PING (PluralKit health check)
  if (type === "PING") {
    console.log("🏓 PING received — responding 200");
    return res.status(200).json({ ok: true });
  }

  // 3. Only forward switch-related events
  const SWITCH_EVENTS = ["CREATE_SWITCH", "UPDATE_SWITCH"];
  if (!SWITCH_EVENTS.includes(type)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  // 4. Build and send Discord message
  try {
    const payload = buildDiscordEmbed(event);
    if (payload) {
      await sendToDiscord(payload);
      console.log(`✅ Forwarded ${type} to Discord`);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error forwarding to Discord:", err.message);
    return res.status(500).json({ error: "Failed to forward to Discord" });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "pk-switch-webhook" }));

app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT} — POST /webhook`);
});
