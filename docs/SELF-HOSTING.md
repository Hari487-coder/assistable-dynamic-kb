# Run Your Own Live KB — Plug-and-Play Guide

Every user runs their **own** Live KB instance: your data stays on your box,
your Assistable tools point at your URL, nothing is shared with anyone. First
signup claims the instance and further signups close automatically
(`SIGNUPS=first-only`). The encryption key generates itself on first boot.
There is nothing to configure before you start.

Pick a path:

| Path | Time | Cost | Data durability | Best for |
|---|---|---|---|---|
| A. Render blueprint | ~5 min | $0 | ⚠ resets on redeploy/restart (free tier disk is ephemeral) | Trying it, demos, pilots |
| B. Docker | ~10 min | $0 + any VPS | ✔ volume-backed | Anyone already running Docker |
| C. Oracle Always Free VM | ~20 min once | $0 forever | ✔ persistent disk | Real production at zero cost |

All three end at the same place: an HTTPS URL running your Live KB.

---

## Path A — Render (fastest)

1. Fork/push this repo to your GitHub.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` configures
   everything (free plan, health check, auto-generated encryption key; the
   public URL is auto-detected — zero env editing).
3. Open the URL, sign up — you're the owner; signups then close.
4. Keep it awake: add the URL to UptimeRobot (free) with a 5-minute check —
   the free tier idles after 15 min and a cold start would make a voice agent
   wait ~30-60s.
5. ⚠ **Free-tier disk is ephemeral**: your sources/config reset when Render
   redeploys or restarts the instance. Fine for a pilot (re-upload the CSV);
   for durable data use Path B/C or attach a Render disk (paid).

## Path B — Docker (any machine with a public URL)

```bash
git clone <your-fork-url> live-kb && cd live-kb
docker compose up -d --build
# data persists in the kb-data volume; app on http://localhost:3900
```

Set `BASE_URL` in `docker-compose.yml` to your public HTTPS URL — Assistable's
servers must be able to reach it. No public URL yet? A free Cloudflare Tunnel
works: `cloudflared tunnel --url http://localhost:3900` (dev/testing only —
the URL changes each run, which invalidates provisioned tools).

## Path C — Oracle Always Free VM (production at $0)

1. Create an **Always Free** ARM A1 instance (Ubuntu 22.04+; up to 4 OCPU/24GB
   are free forever). Open ports 80/443 in the VCN security list and `ufw`.
2. Point a DNS A record (`kb.yourdomain.com`, or a free DuckDNS name) at the
   VM's public IP.
3. On the VM:

```bash
git clone <your-fork-url> live-kb
cd live-kb
KB_DOMAIN=kb.yourdomain.com bash deploy/oracle-setup.sh
```

That installs Node 22 + Caddy (automatic HTTPS), a systemd service with
auto-restart, and starts the app at `https://kb.yourdomain.com`. Data lives in
`/opt/live-kb/data` (daily backups in `data/backups/`, kept 7 days).

---

## After deploy: connect Assistable (same for every path)

1. **Sign up** at your URL — first account claims the instance.
2. **Connection** page → paste your Assistable v3 API key. It's verified live,
   encrypted at rest, and never shown again.
3. **Add a source** — CSV upload, feed URL (JSON/CSV/XML), website, or
   Postgres/Supabase (read-only). First sync runs immediately; a
   `live_data_<name>` tool is created in YOUR Assistable account and assigned
   to the assistants you tick. The tool serves **both voice and chat**
   automatically.
4. **Prompt snippet** — paste into each assistant's instructions in Assistable:

   > For ANY question about {your domain, e.g. "our vehicle inventory"},
   > ALWAYS call {tool name} first and answer only from the result. If it
   > returns nothing, say you don't have that information. When a speech_hint
   > is present, read it aloud.

5. **If the assistant has a static KB covering the same topic, unlink those
   docs** — on voice, the platform's built-in KB tool claims to be the "only
   source of truth" and will compete with live data.
6. **Test**: call your assistant and ask something only live data can answer
   ("do you have a 2022 Tacoma under 30 thousand?"). Then check your source's
   detail page — you'll see the agent's query logged with latency and results.

## Day-2 operations

- **Freshness**: sources re-sync on their schedule; "Sync now" any time. Every
  answer carries `as_of` + freshness so agents never silently serve stale data.
- **Safety**: a failed or suspicious sync (e.g. feed suddenly returns 3 rows
  instead of 300) never touches what agents are serving; one-click **Roll back**.
- **Unanswered queries** on the source page show what customers asked that got
  zero results — add the missing data or extend aliases.
- **Backups** (Docker/VM): copy `data/backups/kb-YYYY-MM-DD.db` somewhere
  off-box (free R2/Drive). Restore = stop, replace `data/kb-bridge.db`, start.
- **Key rotation**: delete the tool in Assistable and delete + re-add the
  source in the portal (re-provisions with a fresh secret). Rotating the
  Assistable API key: just paste the new one on the Connection page.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Agent says "brief connection issue" | Assistable couldn't reach your URL: instance asleep (Render free — add the pinger), wrong `BASE_URL`, or firewall. Hit `<your-url>/healthz`. |
| Tool created but agent never calls it | Prompt snippet missing, or a static KB is competing (step 5). |
| Voice ignores new filter columns | Voice caches the tool schema at assistant-save — re-save the assistant in Assistable (the portal shows a banner when needed). |
| "signups are closed" | `SIGNUPS=first-only` and an owner exists. That's the self-host default working as intended. |
| First sync failed | Source detail page shows the exact error (SSRF-blocked URL, robots.txt, bad credentials, empty feed…). Fix config and "Sync now". |
| Feed/website URL rejected | The SSRF guard blocks private/internal addresses by design — the URL must be publicly reachable. |
