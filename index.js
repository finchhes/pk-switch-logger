import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ── Config (set these as environment variables) ──────────────────────────────
const SIGNING_TOKEN = process.env.PK_SIGNING_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;
// ─────────────────────────────────────────────────────────────────────────────

if (!SIGNING_TOKEN || !DISCORD_WEBHOOK_URL) {
  console.error("❌  Missing required env vars: PK_SIGNING_TOKEN and/or DISCORD_WEBHOOK_URL");
  process.exit(1);
}

// ── PluralKit API fetchers ────────────────────────────────────────────────────

async function fetchSystemName(systemId) {
  try {
    const res = await fetch(`https://api.pluralkit.me/v2/systems/${systemId}`);
    if (!res.ok) return systemId; // fall back to ID if fetch fails
    const data = await res.json();
    return data.name ?? systemId;
  } catch {
    return systemId;
  }
}

async function fetchMemberName(memberId) {
  try {
    const res = await fetch(`https://api.pluralkit.me/v2/members/${memberId}`);
    if (!res.ok) return memberId; // fall back to ID if fetch fails
    const data = await res.json();
    return data.display_name ?? data.name ?? memberId;
  } catch {
    return memberId;
  }
}

async function formatMembers(members) {
  if (!members || members.length === 0) return "*no one*";
  // fetch all member names in parallel
  const names = await Promise.all(
    members.map((m) => (typeof m === "string" ? fetchMemberName(m) : Promise.resolve(m.display_name ?? m.name)))
  );
  return names.map((n) => `**${n}**`).join(", ");
}

// ── Embed builder ─────────────────────────────────────────────────────────────

async function buildDiscordEmbed(event) {
  const { type, system_id, id, data } = event;

  const systemName = await fetchSystemName(system_id);

  switch (type) {
    case "CREATE_SWITCH": {
      const members = await formatMembers(data?.members);
      return {
        username: "pkSwitch!",
        avatar_url: "https://pluralkit.me/favicon.png",
        embeds: [
          {
            title: `new switch in ${systemName}!`,
            color: 0x5865f2,
            fields: [
              { name: "in front:", value: members, inline: false },
              ...(data?.timestamp
                ? [{ name: "time", value: `<t:${Math.floor(new Date(data.timestamp).getTime() / 1000)}:F>`, inline: false }]
                : []),
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    case "UPDATE_SWITCH": {
      const members = await formatMembers(data?.members);
      return {
        username: "pkSwitch!",
        avatar_url: "https://pluralkit.me/favicon.png",
        embeds: [
          {
            title: `switch updated in ${systemName}!`,
            color: 0xfee75c,
            fields: [
              ...(data?.members !== undefined
                ? [{ name: "now fronting:", value: members, inline: false }]
                : []),
              ...(data?.timestamp
                ? [{ name: "new time:", value: `<t:${Math.floor(new Date(data.timestamp).getTime() / 1000)}:F>`, inline: false }]
                : []),
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
    const payload = await buildDiscordEmbed(event);
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
