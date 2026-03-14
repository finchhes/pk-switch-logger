# PluralKit → Discord Switch Webhook

Forwards PluralKit switch events (`CREATE_SWITCH`, `UPDATE_SWITCH`) to a Discord channel via webhook.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env
# then edit .env with your values
```

| Variable | Where to get it |
|---|---|
| `PK_SIGNING_TOKEN` | PluralKit dashboard → Account → Dispatch Webhooks (after registering your URL) |
| `DISCORD_WEBHOOK_URL` | Discord → Server Settings → Integrations → Webhooks → New Webhook → Copy URL |

---

## Hosting

### Railway (recommended)
1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Add your env vars under **Settings → Variables**
4. Railway auto-generates a public URL — use `https://yourapp.up.railway.app/webhook`

### Render
1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo
3. Add env vars under **Environment**
4. Use `https://yourapp.onrender.com/webhook`

> ⚠️ Render's free tier spins down after inactivity. PluralKit's PING events will wake it back up, but there may be a short delay on the first switch after idle.

### Fly.io
1. Install the Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Run `fly launch` in the project folder (it'll detect `fly.toml`)
3. Set secrets instead of a `.env` file:
   ```bash
   fly secrets set PK_SIGNING_TOKEN=xxx DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```
4. Deploy: `fly deploy`
5. Use `https://pk-switch-webhook.fly.dev/webhook`

---

## Registering with PluralKit

1. Go to [dash.pluralkit.me](https://dash.pluralkit.me) → **Account → Dispatch Webhooks**
2. Enter your public URL: `https://yourapp.xxx/webhook`
3. Copy the **signing token** it generates → paste into your env as `PK_SIGNING_TOKEN`
4. PluralKit sends a `PING` to verify — if it passes, you're live!

---

## Discord message format

- 🔄 **New switch** → blue embed — shows who's fronting + timestamp
- ✏️ **Switch updated** → yellow embed — shows what changed
