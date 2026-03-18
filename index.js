import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const SIGNING_TOKEN = process.env.PK_SIGNING_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;
// ─────────────────────────────────────────────────────────────────────────────

if (!SIGNING_TOKEN || !DISCORD_WEBHOOK_URL) {
  console.error("❌  Missing required env vars: PK_SIGNING_TOKEN and/or DISCORD_WEBHOOK_URL");
  process.exit(1);
}

// ── Simple TTL cache ──────────────────────────────────────────────────────────
// Caches PK API responses so repeated webhook events don't re-fetch the same
// system/member data and blow through PluralKit's rate limits.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class TTLCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

const cache = new TTLCache();

// ── Fetch with retry + rate-limit backoff ─────────────────────────────────────
// Retries up to `maxRetries` times. On a 429 it waits for the Retry-After
// header (or a default back-off) before trying again.

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("retry-after") || "2");
      const waitMs = Math.ceil(retryAfter) * 1000;
      console.warn(`⏳ Rate limited on ${url} — waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
    }

    return res;
  }
}

// ── PluralKit API fetchers (cached) ───────────────────────────────────────────

async function fetchSystemName(systemId) {
  const cacheKey = `system:${systemId}`;
  const cached = cache.get(cacheKey);
  if (cached !== null) return cached;

  try {
    const res = await fetchWithRetry(`https://api.pluralkit.me/v2/systems/${systemId}`);
    if (!res.ok) return systemId;
    const data = await res.json();
    const name = data.name ?? systemId;
    cache.set(cacheKey, name);
    return name;
  } catch {
    return systemId;
  }
}

async function fetchMemberName(memberId) {
  const cacheKey = `member:${memberId}`;
  const cached = cache.get(cacheKey);
  if (cached !== null) return cached;

  try {
    const res = await fetchWithRetry(`https://api.pluralkit.me/v2/members/${memberId}`);
    if (!res.ok) return memberId;
    const data = await res.json();
    const name = data.display_name ?? data.name ?? memberId;
    cache.set(cacheKey, name);
    return name;
  } catch {
    return memberId;
  }
}

async function formatMembers(members) {
  if (!members || members.length === 0) return "*no one*";

  const names = await Promise.all(
    members.map((m) =>
      typeof m === "string" ? fetchMemberName(m) : Promise.resolve(m.display_name ?? m.name)
    )
  );
  return names.map((n) => `* **${n}**`).join("\n");
}

// ── Embed builder ─────────────────────────────────────────────────────────────

async function buildDiscordEmbed(event) {
  const { type, system_id, data } = event;

  const systemName = await fetchSystemName(system_id);

  switch (type) {
    case "CREATE_SWITCH": {
      const members = await formatMembers(data?.members);
      return {
        username: "pkSwitch!",
        avatar_url: "https://pluralkit.me/favicon.png",
        embeds: [
          {
            title: `new switch in **${systemName}**!`,
            color: 0x5865f2,
            fields: [
              { name: "in front:", value: members, inline: false },
              ...(data?.timestamp
                ? [{ name: "time:", value: `<t:${Math.floor(new Date(data.timestamp).getTime() / 1000)}:F>`, inline: false }]
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
            title: `switch updated in **${systemName}**!`,
            color: 0xfee75c,
            fields: [
              ...(data?.members !== undefined
                ? [{ name: "now fronting:", value: members, inline: false }]
                : []),
              ...(data?.timestamp
                ? [{ name: "time:", value: `<t:${Math.floor(new Date(data.timestamp).getTime() / 1000)}:F>`, inline: false }]
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

// ── Discord sender with rate-limit retry ──────────────────────────────────────

async function sendToDiscord(payload, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Read body once so we don't hit "body used already"
    const responseText = await res.text();

    if (res.status === 429) {
      let waitMs = 2000;
      try {
        const body = JSON.parse(responseText);
        console.warn("Discord 429 raw body:", JSON.stringify(body));
        if (body.retry_after) waitMs = Math.ceil(body.retry_after * 1000);
      } catch {}
      console.warn(`⏳ Discord rate limited — waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Discord rate limit exceeded after ${maxRetries + 1} attempts`);
    }

    if (!res.ok) {
      throw new Error(`Discord webhook failed (${res.status}): ${responseText}`);
    }

    return; // success
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

  // 2. Handle PING
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
