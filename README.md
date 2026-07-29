# Interview Copilot AI

> A real-time AI interview assistant. Listens to your interviewer through system audio, drafts candidate-voice answers in real time, types code into proctored editors with a human rhythm, and stays invisible to screen-share.

**Version 4.0.4** · Windows · macOS · Linux · Electron desktop app · Railway-hosted backend at `api.minicaai.com`

---

## What is this?

When you're on a live job interview — Zoom, Google Meet, Teams, HackerRank, CoderPad, Ropes.ai — Interview Copilot:

- **Captures system audio** (the interviewer's voice from your meeting app) and transcribes it word-by-word via Deepgram Nova 3.
- **Drafts answers in your voice** using one of five LLMs (Gemini 3 Flash, Groq, GPT-5.5, Grok, or Claude Sonnet 4.6) seeded with your resume + the JD.
- **Stays invisible to screen-share.** Both the main window and the popout overlay are content-protected at the OS level (`setContentProtection(true)`), the icon hides from the taskbar, and the system tray gets torn down during active sessions.
- **Types code for you** into the candidate-side editor with a human-shaped rhythm — Gaussian cadence, decision-point pauses, occasional typos with backspace correction, mouse twitches every 18–31 lines — tuned to defeat keystroke-biometric flags on proctored coding platforms.
- **Pre-researches the role** via Claude's hosted `web_search` — every tech in your resume + the JD gets a current factsheet (latest version, recent changes, pricing, gotchas) cached for 24 hours so version/pricing/comparison questions answer in 2–3 seconds instead of 12–25.

The product is positioned for senior+ engineers, data engineers, and PMs who don't want to fail a live interview because they couldn't recall what version of Apache Airflow shipped a particular operator change last quarter.

The website at `minicaai.com` is the marketing + auth + download surface only. The actual product is the Electron desktop app — `App.tsx`'s top-level wrapper redirects authenticated browser users to the download page.

---

## Headline features

### For everyone

- **Voice mode** — Press the mic. The renderer fetches a short-lived Deepgram key from the server, opens a WebSocket directly to Deepgram's Nova-3 endpoint, and streams 250 ms `MediaRecorder` chunks. Auto-reconnects on network blips with exponential backoff.
- **5-model picker** — Gemini 3 Flash · Groq · GPT-5.5 · Grok · Claude Sonnet 4.6. Each is gated to a tier; locked models stay visible in the picker so users see what an upgrade unlocks.
- **Resume + JD context** — Upload PDFs, DOCX, or images. Files are extracted on-device (mammoth + pdfjs-dist + tesseract for images) and seeded into every prompt as `KNOWLEDGE BASE`.
- **Conversation history** — Local SQLite (Electron-side, per-user-scoped), auto-titled by an LLM after the first response so "Interview <date>" placeholders become topic summaries. Synced to the cloud for cross-device + admin visibility.
- **Stealth pop-out** — A transparent, frameless, always-on-top overlay (`alwaysOnTop('screen-saver')`, re-enforced periodically) that doesn't steal focus from your browser tab — clicks on its buttons don't fire `window.onblur` on the proctoring tab.

### Pro and Max

- **Auto-Solve** — Click during a coding-platform screenshare. The renderer takes a screenshot, the AI returns code-only output (no prose, no docstrings, no `__main__` blocks), and you can either copy it or trigger Auto-Type.
- **Auto-Type** — Paste-free typing into HackerRank, CoderPad, CodeSignal, Codility, LeetCode, or any Monaco/CodeMirror-backed editor. Reads the editor's current text + cursor via Windows UIA, computes which lines are already on screen (so the function signature isn't re-typed), and types char-by-char with rhythm camouflage.
- **System audio capture** + everything in the free tier.

### Max-only

- **Claude Sonnet 4.6 with `web_search`** — Hosted by Anthropic; no separate Brave/SerpAPI key needed. The persona prompt includes explicit DO/DON'T trigger rules so Claude searches when it should ("what version", "currently", "right now") and answers from memory when it shouldn't (behavioral, conceptual, your own resume).
- **Train Model** — Pre-research every tech in your resume + JD. Two paths:
  - **Standard** — 15 keywords × batched-of-5 web searches at concurrency 2. ~$0.30/run, ~30 s wall-clock. Result cached 24 h, injected into the system prompt of *every* model (Gemini/GPT/Grok/Groq all benefit, not just Claude).
  - **Beast Mode** (admin only) — 25 keywords × individual deep research × synthesis pass. ~$3–6/run, ~3–5 min.
- **Reasoning effort knob** — `none` / `low` / `medium` / `high` for GPT-5.5. Defaults to `none` paired with Train Model — the cached factsheets fill the depth that reasoning would otherwise compute live.
- **Custom Instructions** — Free-form directives prepended to every prompt as a high-priority block (e.g. "Use STAR for behavioral", "Cite tool versions", "Keep responses under 200 words").

---

## Tier matrix

| Tier  | Price (USD)   | Price (INR)      | Models                                   | Time per session                        | Auto-Solve | Auto-Type | Train Model |
|-------|---------------|------------------|------------------------------------------|-----------------------------------------|:----------:|:---------:|:-----------:|
| Free  | $0            | ₹0               | All except Claude (during trial)         | One-time 10-min trial                   |     —      |     —     |      —      |
| Basic | $25 one-time  | ₹1999 one-time   | + GPT-5.5, Grok, Groq                    | 3 credits / 14 days · renewable +1h     |     ✓      |     —     |      —      |
| Pro   | $29 / month   | ₹2499 / month    | Same four (no Claude)                    | Unlimited                               |     ✓      |     —     |      —      |
| Max   | $69 / month   | ₹5999 / month    | All four + Claude Sonnet 4.6             | Unlimited                               |     ✓      |     ✓     |      ✓      |

**Renewal** for Basic users is +1 hour for $6.99 / ₹599. The server's `grantBasicRenewal` extends `license.expires_at` by 1 h; the client detects the cross-device delta on the next `validateWithServer` call and credits the local ledger so a renewal paid on one device propagates to all devices.

**Region routing** is geo-detected at signup (browser timezone + ipapi.co), then locked to the user record. The server's `regionGate` middleware enforces paid-required for India: free / trial / expired Indian accounts get HTTP 403 from every AI route. Other regions get the one-time 10-minute free trial (nothing stays free after it).

**Admins** (configured via `ADMIN_EMAILS` on the server) bypass every tier gate and region gate, with an unlimited time bucket. The client mirrors this short-circuit so the in-app surface always renders "Max" for admins regardless of stored tier.

For the full tier deep-dive (per-feature gates, status state machine, refund eligibility, region rules) see [docs/TIERS.md](./docs/TIERS.md).

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│                      ELECTRON DESKTOP APP                       │
│                                                                 │
│  ┌──────────────────┐         ┌────────────────────────────┐    │
│  │  Main process    │◄── IPC ─┤    Renderer (React 19)     │    │
│  │  electron/       │  bridge │  App.tsx · MainApp · ...   │    │
│  │  main.cjs        │         │                            │    │
│  └────────┬─────────┘         └─────────────┬──────────────┘    │
│           │                                 │                   │
│           │ better-sqlite3                  │ WebSocket         │
│           │ (per-user SQLite)               │ → Deepgram Nova-3 │
│           │                                 │                   │
│           │ powershell.exe                  │                   │
│           │ (UIA bridge)                    │ HTTPS / SSE       │
│           │                                 │ → api.minicaai    │
│           │ nut-js                          │                   │
│           │ (keystrokes)                    │                   │
└───────────┼─────────────────────────────────┼───────────────────┘
            │                                 │
            ▼                                 ▼
   Target editor                   ┌──────────────────────────┐
   (HackerRank / IDE)              │   Railway server         │
                                   │   api.minicaai.com       │
                                   │                          │
                                   │   Express + SQLite       │
                                   │   Webhooks · Admin · AI  │
                                   └──────┬───────────────────┘
                                          │
                                          ▼
                              ┌────────────────────────────┐
                              │   Anthropic / OpenAI /     │
                              │   Google / Groq / xAI      │
                              │   Stripe / Razorpay        │
                              │   Brave Search · Resend    │
                              └────────────────────────────┘
```

The renderer talks to the main process through a strictly-allowlisted contextBridge (`electron/preload.cjs`). Every AI call is proxied through Railway with the user's JWT — provider API keys are never exposed to the client. Live audio bypasses the proxy: the renderer fetches a short-lived Deepgram key from the server, then opens a WebSocket directly to Deepgram (latency-sensitive transport).

For the full architecture deep-dive (process model, IPC channel reference, security boundaries, navigation hardening, crash reporter, single-instance, auto-update flow, the UIA bridge protocol) see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Quickstart for users

1. Visit [https://get.minicaai.com](https://get.minicaai.com) and download the installer for your OS.
2. On Windows, the installer is signed via Azure Trusted Signing — no SmartScreen warnings.
3. Sign up with email + password, or click **Sign in with Google**.
4. New accounts get a one-time 10-minute trial of the full Basic experience automatically (Gemini + GPT + Grok + Groq — no Claude). After it, you pick a plan; nothing stays free.
5. Optional: upload your resume + the JD in **Knowledge Base** (the file icon in the toolbar) for grounded answers.
6. Click the mic icon to start listening. Talk to your interviewer; the AI answers as you.

Hotkey: `Ctrl+Alt+Space` (Windows/Linux) or `Cmd+Alt+Space` (macOS) brings the main window back when it's hidden in the tray.

---

## Development setup

### Prerequisites

- **Node 20+** (the server's `package.json` engines pins this).
- **npm** — the lockfile is npm-shaped; pnpm/yarn will work but produce a divergent lockfile.
- **Windows 10+ / macOS 12+ / any modern Linux** for the desktop side.
- **PowerShell** on Windows — used by the Auto-Type UIA bridge; ships with the OS.
- **Visual Studio Build Tools** with the "Desktop development with C++" workload, only if you'll be code-signing Windows builds locally (provides `signtool.exe`).

### Clone and install

```bash
git clone <repo-url>
cd interview-copilot-ai
npm install
```

`postinstall` runs `patch-package && electron-rebuild -f` automatically — the latter rebuilds `better-sqlite3` and `@nut-tree-fork/nut-js` against Electron's V8 ABI (without it, you get `Module did not self-register` at runtime).

### Run renderer-only (Vite dev server)

```bash
npm run dev
```

Opens on `http://localhost:3005`. The browser path renders only the marketing / auth / download surface; the chat itself is Electron-only — `App.tsx` redirects authenticated browser users to the download page.

### Run the full Electron app (recommended for dev)

```bash
npm run electron:start
```

This starts Vite + Electron concurrently and uses `wait-on tcp:3005` before launching the Electron window. DevTools are auto-enabled when `app.isPackaged === false`; they're disabled in packaged builds because the DevTools window is a separate HWND not covered by `setContentProtection`.

The popout window is launched in-process from `main.cjs` and loads `index.html?mode=popout`; the renderer reads the query param to render the compact overlay variant.

### Run the server locally

```bash
cd server
cp .env.example .env
# Fill in API keys — at minimum:
#   JWT_SECRET, GEMINI_API_KEY, ANTHROPIC_API_KEY,
#   STRIPE_SECRET_KEY (test mode is fine for dev),
#   GOOGLE_CLIENT_ID
npm install
npm run dev   # nodemon on :4000
```

Point the renderer at your local server with `VITE_SERVER_URL=http://localhost:4000` in `.env.local` at the repo root. Note: `licenseService.ts` is hardcoded to `https://api.minicaai.com` in production builds (`import.meta.env.PROD === true`), so a forgotten dev override won't ship in licensing calls. Other services (`aiProxyService`) read `VITE_SERVER_URL` directly — leave it unset before running `npm run build` for production.

### Type check

```bash
npm run lint   # tsc --noEmit on the renderer
```

### Server tests

```bash
cd server
npm test       # vitest run
```

Manual test fixtures are in `server/test-*.md` (model-comparison runs, sequential-flow traces, coding-design round-trips).

### Latency / pipeline simulators

Two Python scripts under `scripts/` exercise the Anthropic API directly with the prompts the renderer ships:

- `latency-test-claude.py` — measures time-to-first-token across question categories, reports whether `web_search` fired.
- `train-model-sim.py` — runs the Train Model pipeline end-to-end against a sample resume + JD and prints the resulting cached card.

Both load `ANTHROPIC_API_KEY` from `server/.env`.

---

## Project structure

```
interview-copilot-ai/
├── electron/                       # Electron main process
│   ├── main.cjs                    # 3,600 lines — windows, IPC, Auto-Type, UIA, updater
│   ├── preload.cjs                 # contextBridge with strict IPC allowlists
│   ├── database.cjs                # Local SQLite (sessions/messages/context_files)
│   └── tray-icon.png               # 32×32 brand icon for the tray
│
├── App.tsx                         # 6,710 lines — root + MainApp + every chat surface
├── SubscriptionGate.tsx            # 9,976 lines — landing/auth/admin/mobile views
├── ManageSubscription.tsx          # 1,225 lines — in-app billing modal
├── Tutorial.tsx                    # First-launch walkthrough
├── ErrorBoundary.tsx               # Top-level render-error catch
├── RefundPolicy.tsx                # Refund-policy modal
├── ProviderIcons.tsx               # Lobe-hub MIT brand SVGs
├── GitHubIcons.tsx                 # Custom paper-airplane send icon
├── WizardHat.tsx                   # Custom Max-tier "aureole star" icon
│
├── hooks/
│   ├── useDatabase.ts              # SQLite IPC wrapper, auto-syncs to cloud
│   ├── useSpeechRecognition.ts     # Deepgram WebSocket + auto-reconnect
│   ├── usePrefetchContext.ts       # Speculative cache warming
│   └── useAnimatedModal.ts         # Mount/visible flag separation
│
├── services/
│   ├── aiProxyService.ts           # 1,753 lines — proxy + persona prompts + voice rules
│   ├── claudeService.ts            # 957 lines — Claude + web_search + Train Model
│   ├── licenseService.ts           # 900 lines — auth + tier + credits
│   ├── pricingService.ts           # USD/INR base, special INR
│   ├── creditTimerService.ts       # Per-second tick + boundaries
│   ├── techStateCache.ts           # 24h localStorage cache
│   ├── geoService.ts               # Region detection (never blocks)
│   ├── openaiService.ts            # Direct-API fallback (BYOK)
│   ├── geminiService.ts            # Direct-API fallback
│   ├── xaiService.ts               # Direct-API fallback
│   ├── groqService.ts              # Direct-API fallback
│   ├── docxService.ts              # mammoth wrapper
│   └── pdfService.ts               # pdfjs-dist wrapper
│
├── server/                         # Railway backend
│   ├── src/
│   │   ├── index.js                # Express bootstrap, CORS, rate limits, WS
│   │   ├── database.js             # Schema + queries (~88 KB)
│   │   ├── email.js                # Resend + SMTP fallback
│   │   ├── backup.js               # Daily VACUUM INTO snapshot
│   │   ├── middleware/
│   │   │   ├── auth.js             # JWT + force-logout check + step-up claims
│   │   │   ├── admin.js            # adminOnly · stepUpOnly · audit helper
│   │   │   ├── tier.js             # requireTier(...) reads live license row
│   │   │   └── regionGate.js       # India-paid-required gate
│   │   ├── routes/
│   │   │   ├── auth.js             # signup · login · google (web + Electron) · password reset
│   │   │   ├── payments.js         # checkout · upgrade · renewal · cancel · portal
│   │   │   ├── webhooks.js         # stripe + razorpay (raw body, idempotent)
│   │   │   ├── license.js          # validate · session · revoke (admin)
│   │   │   ├── admin.js            # full admin surface
│   │   │   ├── ai.js               # /chat/* · /stream/* · /autotype-* · /prefetch-context
│   │   │   ├── conversations.js    # CRUD + sync + messages
│   │   │   └── downloads.js        # /windows · /mac{,-x64,-arm64} · /linux redirects
│   │   ├── services/
│   │   │   ├── autoTypeAgent.js    # Sonnet 4.6 + tool_use planner
│   │   │   ├── groqAutoTypePlanner # Llama-3.3-70B fallback planner
│   │   │   ├── freshContext.js     # Classifier → search → format injector
│   │   │   ├── searchProvider.js   # Brave + page-content cache
│   │   │   ├── questionClassifier  # Behavioral / coding / system design / etc.
│   │   │   ├── refundEligibility   # Time-based eligibility rules
│   │   │   └── subscriptionStates  # State machine + access predicates
│   │   ├── utils/version.js        # Semver compare
│   │   └── stealth-test.html       # Public diagnostic page
│   ├── scripts/                    # stripe-setup, dev-login, test runners
│   └── data/                       # Local SQLite when DATABASE_PATH unset
│
├── scripts/
│   ├── build-icons.mjs             # SVG → multi-size PNG/ICO/ICNS via sharp + png2icons
│   ├── sign-windows.cjs            # Azure Trusted Signing electron-builder hook
│   ├── install-signing-dlib.ps1    # One-time NuGet fetch of Microsoft's sign dlib
│   ├── azure-signing-metadata.json
│   ├── latency-test-claude.py      # Anthropic round-trip benchmark
│   └── train-model-sim.py          # End-to-end Train Model simulation
│
├── public/                         # Vite static assets (favicons, tray icons)
├── build/                          # Generated icons (ICNS/ICO/PNG)
├── patches/                        # patch-package patches
│
├── index.html                      # CSP, theming tokens, font config
├── index.tsx                       # ReactDOM.createRoot + Promise.withResolvers polyfill
├── index.css                       # Tailwind entry
├── pip-styles.css                  # Pop-out window styles (transparent + non-focus)
├── types.ts                        # Shared TS types (AppSettings, Message, ContextFile)
├── electron-api.d.ts               # window.electronAPI type definitions
│
├── package.json                    # Dependencies + electron-builder config
├── tsconfig.json
├── vite.config.ts                  # SVGR plugin, version inject, alias
├── tailwind.config.cjs
├── postcss.config.cjs
├── netlify.toml                    # Marketing-site SPA rewrite
└── REFUND_POLICY.md
```

---

## Configuration

### Renderer env (`.env.local` at repo root, optional in dev)

| Variable                | Purpose                                                                                                        |
|-------------------------|----------------------------------------------------------------------------------------------------------------|
| `VITE_SERVER_URL`       | Override the API base URL in dev (default `https://api.minicaai.com`). Production licensing calls ignore this. |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID for the GSI flow. Optional — falls back to a hardcoded default.                         |
| `GEMINI_API_KEY`        | Only when using direct-API mode (`services/geminiService.ts`). Production users go through the proxy.          |

### Server env (`server/.env`)

The full annotated list lives in `server/.env.example`. Required in production:

| Variable                                                              | Purpose                                                                                              |
|-----------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `JWT_SECRET`                                                          | Token signing. Server refuses to start without this in `NODE_ENV=production`.                        |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                          | Stripe payments + webhook verification.                                                              |
| `STRIPE_PRICE_BASIC_USD`, `STRIPE_PRICE_PRO_USD`, `STRIPE_PRICE_MAX_USD` | Per-tier price IDs. Run `npm run stripe:setup` once to create them and print the IDs.              |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`   | Razorpay (India only).                                                                               |
| `RAZORPAY_PLAN_ID_PRO`, `RAZORPAY_PLAN_ID_MAX`                        | Per-tier Razorpay subscription plans.                                                                |
| `GOOGLE_CLIENT_ID`                                                    | OAuth client ID used by both web and desktop flows.                                                  |
| `GOOGLE_CLIENT_SECRET`                                                | Required for the Electron desktop OAuth callback flow.                                               |
| `SERVER_URL`                                                          | Public HTTPS base URL of this server. Required so the Google OAuth callback URI is built correctly behind Railway's proxy. |
| `ADMIN_EMAILS`                                                        | Comma-separated admin emails. These accounts get tier/region bypass and `/api/v1/admin/*` access.    |
| `RESEND_API_KEY`, `EMAIL_FROM`                                        | Primary email transport. Cloud hosts often block outbound SMTP; Resend uses HTTPS port 443.          |
| `ANTHROPIC_API_KEY`                                                   | Claude Sonnet 4.6 + the hosted `web_search` tool.                                                    |
| `OPENAI_API_KEY`                                                      | GPT-5.5.                                                                                             |
| `XAI_API_KEY`                                                         | Grok.                                                                                                |
| `GROQ_API_KEY`                                                        | Llama 3 / GPT-OSS-120B + Auto-Type planner fallback.                                                 |
| `GEMINI_API_KEY`                                                      | Gemini 3 Flash (free-tier model).                                                                    |
| `BRAVE_API_KEY`                                                       | Optional. Without it `freshContext.js` returns null and the chat path proceeds without retrieval.    |
| `DATABASE_PATH`                                                       | **Required on Railway.** Must point inside an attached Volume (e.g. `/data/minicaai.db`) or every restart wipes all users. |

Optional in production:

| Variable                                  | Purpose                                                                                                      |
|-------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| `BACKUP_PATH`                             | Directory for daily SQLite snapshots. Defaults to `<DATABASE_PATH dir>/backups/`. Point at a second volume for off-primary redundancy. |
| `ADMIN_IP_ALLOWLIST`                      | Comma-separated IP allowlist for `/api/v1/admin/*`. Empty = no IP restriction. Recommended in prod.          |
| `CRASH_SUBMIT_URL`, `CRASH_UPLOAD_TO_SERVER` | Crash-reporter endpoint + opt-in flag.                                                                    |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Used only when `RESEND_API_KEY` is unset (local dev / Mailhog).                          |
| `MINICAAI_API_BASE`                       | Renderer-side dev override for the Auto-Type planner endpoint. Set in the dev shell that runs Electron.      |

### Code-signing env (Windows builds only)

| Variable                                                  | Purpose                                                                                                   |
|-----------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Azure App registration credentials for the Trusted Signing API.                                         |
| `SIGNTOOL_PATH`                                           | Optional override for `signtool.exe` location. Without it, the script auto-locates the newest Windows SDK 10 install. |

---

## Build & release

### Build the icons

```bash
npm run icons
```

Renders `build/icon.svg` once at 4096 px internal density into a 1024 px master, then resizes via Lanczos3 for every target size. Outputs `build/icon.{icns,ico,png}` and per-size PNGs.

### Build packaged binaries

```bash
npm run electron:build
```

Runs `vite build` → `dist/`, then `electron-builder` → `dist-electron/`. Targets:

- **Windows**: NSIS one-click installer (`InterviewCopilot-Setup.exe`).
- **macOS**: DMG + ZIP for `x64` and `arm64` (`InterviewCopilot-Mac-{x64,arm64}.{dmg,zip}`).
- **Linux**: AppImage + DEB (`InterviewCopilot-Linux.{AppImage,deb}`).

On Windows, every `.exe` flows through `scripts/sign-windows.cjs` (the custom `electron-builder.sign` hook) which calls `signtool.exe` with the Azure Trusted Signing dlib. One-time setup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-signing-dlib.ps1
```

This downloads `Microsoft.Trusted.Signing.Client` from NuGet and caches the dlib + peer DLLs into `.signing/` (gitignored).

### Build + auto-publish to GitHub Releases

```bash
npm run electron:publish
```

Same as build, but also uploads artifacts to the configured `madhavvan/h2so4` release. The Electron auto-updater inside the running app polls this release feed.

### What ships and where

| Platform | Artifact                                  | Public download URL                  |
|----------|-------------------------------------------|--------------------------------------|
| Windows  | `InterviewCopilot-Setup.exe`              | `get.minicaai.com/windows`           |
| macOS    | `InterviewCopilot-Mac-{x64,arm64}.dmg`    | `get.minicaai.com/mac{,-x64,-arm64}` |
| Linux    | `InterviewCopilot-Linux.AppImage`         | `get.minicaai.com/linux`             |

`get.minicaai.com/<platform>` redirects all resolve to GitHub release CDN URLs by way of `server/src/routes/downloads.js` — keeps the actual GitHub repo name out of any URL the user copies from their browser.

For the full release runbook (semver bumping, fallback-version sync in `server/src/index.js`, smoke-test checklist, rollback procedure) see [docs/BUILD.md](./docs/BUILD.md).

---

## Tech stack

### Renderer (browser + Electron renderer)

- **React 19**, **TypeScript 5.8**, **Vite 6** (with `vite-plugin-svgr` for `?react` SVG imports), **Tailwind 3.4** (+ `@tailwindcss/typography`).
- **AI SDKs (BYOK fallback paths only):** `@google/genai`, `openai`, `groq-sdk`. The production path is the server proxy — these are kept for users who plug in their own keys.
- **Auth:** `@react-oauth/google` (Google Sign-In).
- **Audio:** Deepgram WebSocket — direct `WebSocket` against the Nova-3 endpoint, no SDK.
- **Auto-Type:** `@nut-tree-fork/nut-js` (cross-platform input injection; rebuilt against Electron's V8 ABI).
- **Storage:** `better-sqlite3` (Electron-side per-user database).
- **File extraction:** `mammoth` (DOCX), `pdfjs-dist` (PDF), `tesseract.js` (image OCR fallback for Auto-Type's pre-skip planner).
- **Markdown rendering:** `react-markdown` + `remark-gfm` + `react-syntax-highlighter` (Prism, `vscDarkPlus`).
- **Icons:** `lucide-react` (UI utility), `@phosphor-icons/react` (landing-page duotone), `@lobehub/icons-static-svg` (provider brand marks). Custom: `WizardHat.tsx` for Max tier.

### Electron

- **electron 41**, **electron-builder 26**, **electron-updater 6** (GitHub provider), **electron-log 5**.
- Native module rebuild: `patch-package` + `@electron/rebuild` in `postinstall`.

### Server (Node 20+)

- **Express 4**, **helmet**, **cors**, **rate-limiter-flexible**.
- **Storage:** `better-sqlite3` (WAL mode, daily `VACUUM INTO` snapshots × 7-day retention).
- **Auth:** `jsonwebtoken`, `google-auth-library` (Google OAuth ID-token verification + Electron server-side OAuth callback flow).
- **Payments:** `stripe`, `razorpay`.
- **AI:** `@anthropic-ai/sdk` (Sonnet 4.6 + `web_search_20260209` tool), `@google/genai`, `openai`, `groq-sdk`.
- **Email:** `resend` (HTTPS, primary), `nodemailer` (SMTP fallback).
- **Live support:** `ws` (WebSocket at `/ws/support` with idle sweeper + heartbeat).
- **Tests:** `vitest`.

### Build / signing / scripts

- `sharp` + `png2icons` for icon rasterization.
- Azure Trusted Signing via `signtool.exe` + `Microsoft.Trusted.Signing.Client` dlib (NuGet).
- `concurrently` + `wait-on` for the `electron:start` dev script.

---

## Scripts reference

| Script                                          | Path        | What it does                                                          |
|-------------------------------------------------|-------------|-----------------------------------------------------------------------|
| `npm run dev`                                   | repo root   | Vite dev server on `http://localhost:3005` (renderer only)            |
| `npm run build`                                 | repo root   | Vite production build → `dist/`                                       |
| `npm run preview`                               | repo root   | Preview the production build                                          |
| `npm run lint`                                  | repo root   | `tsc --noEmit` on the renderer                                        |
| `npm run icons`                                 | repo root   | Generate icon assets (`build/icon.{icns,ico,png}` + per-size PNGs)    |
| `npm run electron:start`                        | repo root   | Concurrent vite + electron with `wait-on tcp:3005`                    |
| `npm run electron:build`                        | repo root   | Production build + electron-builder packaging                         |
| `npm run electron:publish`                      | repo root   | Same, plus publish to GitHub release                                  |
| `npm start`                                     | `server/`   | Production: `node src/index.js`                                       |
| `npm run dev`                                   | `server/`   | Nodemon on `:4000`                                                    |
| `npm test`                                      | `server/`   | Vitest                                                                |
| `npm run stripe:setup`                          | `server/`   | One-time: create Stripe products + prices and print the IDs           |
| `node scripts/build-icons.mjs`                  | repo root   | Direct icon build (same as `npm run icons`)                           |
| `python scripts/latency-test-claude.py`         | repo root   | Anthropic round-trip benchmark                                        |
| `python scripts/train-model-sim.py`             | repo root   | End-to-end Train Model simulation                                     |
| `powershell -File scripts/install-signing-dlib.ps1` | repo root | One-time install of Microsoft's signing dlib                        |

---

## Documentation

This README is the entry point. Deeper sections live in `docs/`:

- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — Process model · IPC channel reference · security boundaries · navigation hardening · auto-update flow · crash reporter · single-instance lock · the UIA bridge protocol.
- **[TIERS.md](./docs/TIERS.md)** — Per-tier feature gates · region rules · pricing · subscription state machine · credit ledger semantics · trial mechanics · admin bypass · refund eligibility.
- **[AUTO_TYPE.md](./docs/AUTO_TYPE.md)** — The 4-tier deterministic→AI fallback planner · UIA bridge · Sonnet/Groq/Haiku planners · cadence machine · typo + backtrack + indent-mistake injection · SID drift detection · post-type verify.
- **[PROMPTS.md](./docs/PROMPTS.md)** — The persona prompt · `RESPONSE RULES` user-message block · banned words/phrases/openers · 10 voice examples · domain-specific answer structures · Three Moves · Show Scars · 11-item silent checklist · OLD vs NEW prompt path · auto-solve override.
- **[SERVER.md](./docs/SERVER.md)** — Endpoint reference · middleware stack · rate limits · region gate · tier gate · subscription state machine · webhook idempotency · audit log · daily backup · live support WebSocket.
- **[BUILD.md](./docs/BUILD.md)** — Release runbook · Azure code signing · auto-update mechanics · NSIS gotchas · GitHub release flow · version-bump procedure · rollback.
- **[RUNBOOK.md](./docs/RUNBOOK.md)** — Operations: refunds · bans · audit-log queries · impersonation · force-logout · device reset · grant-comp · extend-expiry · Volume-detach recovery.
- **[PRIVACY.md](./docs/PRIVACY.md)** — Data flows · what's stored locally vs server-side · admin visibility · cross-device sync · cloud sync queue · GDPR-ish considerations.

(These files will be created one at a time alongside this README.)

---

## Support

| Surface              | Where                                                              |
|----------------------|--------------------------------------------------------------------|
| Live in-app chat     | `wss://api.minicaai.com/ws/support` (auth-gated)                   |
| Email                | `support@interviewcopilot.app` (per `package.json` author block)   |
| Crash reports        | Auto-uploaded to `api.minicaai.com/api/v1/crash` when `CRASH_UPLOAD_TO_SERVER=1` is set |
| Refund policy        | `REFUND_POLICY.md` or in-app via **Manage Subscription → Refund Policy** |
| App-version check    | `https://api.minicaai.com/api/v1/app-version`                      |
| Stealth diagnostic   | `https://api.minicaai.com/stealth-test` — verifies popout focus + Auto-Type rhythm without an active interview |

---

## Contributing

PR conventions:

- Branch off `main`. Single-purpose PRs.
- `npm run lint` and `cd server && npm test` must pass.
- Match the existing comment style: rationale + tradeoffs, not "what the code does." The codebase is heavily commented for a reason — when an assumption changes, the comment explains *why* the original approach was chosen so the reviewer knows whether the new state is still consistent. See `services/aiProxyService.ts` for the canonical style.
- New AI route? Pick a tier gate in `server/src/routes/ai.js` (`requireTier(...PAID)` or `requireTier(...MAX_ONLY)`).
- New IPC channel? Add it to the matching set in `electron/preload.cjs` and define the type in `electron-api.d.ts`.
- New license status? Add it to `LICENSE_STATUSES` in `server/src/services/subscriptionStates.js` and update the corresponding union in `services/licenseService.ts`.

---

## License

TODO — confirm. No `LICENSE` file currently in the repo; the source code header in `package.json` lists the author as Interview Copilot (`support@interviewcopilot.app`) and Azure code-signing publisherName as Venu Madhav Pentala.
