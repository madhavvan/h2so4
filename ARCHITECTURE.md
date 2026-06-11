# Interview Copilot AI — Architecture Map

> Living document, built by reading the source A–Z. **Integrity rule:** a
> subsystem section is written ONLY after its files have been read in full.
> Status is marked explicitly per section. The Read Ledger at the bottom is
> the source of truth for what has and hasn't been covered.

Status legend: ✅ read in full · 🟡 partially read · ⬜ not yet read

---

## 1. What the app is

A **live-interview AI copilot** — an Electron desktop app that listens to
interview audio, drafts answers in the candidate's voice, and can type those
answers into a coding editor (HackerRank/CoderPad/etc.) with humanized
keystrokes. Screen-share-invisible (`setContentProtection`). Freemium:
Free / Basic / Pro / Max tiers. ~55K lines of app source across ~90 files.

## 2. The three tiers

| Tier | Runs as | Lives in | Talks to |
|---|---|---|---|
| **Renderer** | Sandboxed Chromium (React/TS) | root `*.tsx`, `services/`, `hooks/` | Electron main via `window.electronAPI` IPC; server via HTTPS + WS |
| **Electron main** | Node (full privilege) | `electron/main.cjs` + helpers | OS (windows, keyboard, tray); spawns a PowerShell UIA bridge |
| **Server** | Express on Railway (`api.minicaai.com`) | `server/src/` | SQLite DB; Anthropic/OpenAI/Groq/Gemini/xAI; Stripe/Razorpay; Deepgram |

Renderer ↔ main: allowlisted IPC channels (`electron/preload.cjs`).
Renderer ↔ server: REST + SSE (chat/auto-type) + WebSocket (`/ws/support`).
Main ↔ server: direct `fetch` (auto-type cloud planners, crash upload).

## 3. File inventory

**Renderer (root):** `SubscriptionGate.tsx` (10196) ⬜, `App.tsx` (7048) ✅,
`SupportBot.tsx` (3930) 🟡, `ManageSubscription.tsx` (1448) ⬜,
`Documentation.tsx` (1284) ⬜, `Tutorial.tsx` (327) ⬜, `RefundPolicy.tsx` (227) ⬜,
`ErrorBoundary.tsx` (141) ⬜, `WizardHat/GitHubIcons/ProviderIcons` ⬜,
`index.tsx` `types.ts` `index.html` `index.css` `pip-styles.css` ⬜.

**Renderer services (`services/`):** `aiProxyService.ts` (1754) ⬜,
`claudeService.ts` (957) ⬜, `licenseService.ts` (933) 🟡, `pricingService.ts` ⬜,
`openaiService/geoService/creditTimerService/xaiService/groqService/geminiService/techStateCache/pdfService/docxService` ⬜.

**Renderer hooks (`hooks/`):** `useSpeechRecognition.ts` (367) ⬜,
`useDatabase.ts` (263) ⬜, `usePrefetchContext.ts` ⬜, `useAnimatedModal.ts` ⬜.

**Electron (`electron/`):** `main.cjs` (6145) 🟡 (1–5460 read; 5460–6145 ⬜),
`preload.cjs` (187) ✅, `bracketTracker.cjs` (326) ✅,
`autoTypePlanLog.cjs` (210) ✅, `database.cjs` (289) ⬜.

**Server core (`server/src/`):** `index.js` (1214) 🟡, `database.js` (2562) 🟡,
`email.js` (430) ⬜, `backup.js` (126) ⬜.

**Server routes (`server/src/routes/`):** `payments.js` (1835) ⬜,
`support.js` (1691) ✅, `ai.js` (1466) 🟡 (autotype routes read),
`webhooks.js` (1397) ⬜, `admin.js` (1027) ⬜, `auth.js` (915) ⬜,
`license.js` (251) ⬜, `geo.js` (194) ⬜, `conversations.js` (186) ⬜,
`downloads.js` (91) ⬜.

**Server services (`server/src/services/`):** `botTools.js` (2146) 🟡,
`searchProvider.js` (498) ⬜, `freshContext.js` (445) ⬜,
`autoTypeVisionAgent.js` (353) ✅, `groqAutoTypePlanner.js` (298) ✅,
`autoTypeAgent.js` (294) ✅, `stubDetector.js` (287) ✅,
`anthropicSupport.js` (278) ✅, `supportEscalation.js` (251) ✅,
`questionClassifier.js` (172) ⬜, `ntfy.js` (152) ✅,
`subscriptionStates.js` (137) ⬜, `refundEligibility.js` (123) ⬜.

**Server middleware:** `regionGate.js` `admin.js` `tier.js` `auth.js` ⬜.
**Server utils:** `cryptoDocs.js` (103) ⬜, `version.js` ⬜.
**Tests/scripts:** `server/test/*` (~10 files), `server/scripts/probe-*` (~20) — tooling, not app runtime.

---

## 4. Subsystems

### 4.1 Electron main — shell ✅ (`main.cjs` 1–1424)

The process foundation. Crash reporter (Crashpad → `/api/v1/crash`).
`uncaughtException`/`unhandledRejection` log instead of crash (a native error
dialog mid-screen-share would leak the app). Single-instance lock that also
serves the `interview-copilot://` custom protocol (Google-OAuth handoff).

**Two windows:** `mainWindow` (opaque, framed, `skipTaskbar`, hide-to-tray on
close) and `popoutWindow` (transparent, frameless, `alwaysOnTop:'screen-saver'`,
`focusable:false` = WS_EX_NOACTIVATE so clicks don't blur the interview tab,
native resize disabled — JS resize handles on top/bottom/corners only so the OS
resize cursor never flashes on screen-share). Both `setContentProtection(true)`.

**Stealth invariants:** content protection on both windows; show/hide
animations + tray + macOS Dock all suppressed while `sessionActive`; native
dialogs avoided (update prompt routed to the renderer — `dialog.showMessageBox`
is an unprotected HWND). Nav hardening: window-open denied, `will-navigate`/
`will-redirect` guarded → external URLs only via allowlisted `shell.openExternal`.

**IPC:** desktop sources, `open-external-robust` (shell → child_process
fallback), popout management + custom resize, window controls, cross-window
relay, `session-active`, and the `support:alert` → OS-notification/dock-badge/
tray bridge. `API_BASE` = `api.minicaai.com`; in dev auto-detects `localhost:4000`.

### 4.2 Auto-type engine ✅

(`main.cjs` 1424–5460; `bracketTracker.cjs`; `autoTypePlanLog.cjs`; server
`autoTypeVisionAgent.js`, `autoTypeAgent.js`, `groqAutoTypePlanner.js`,
`stubDetector.js`; `ai.js` routes `/autotype-{vision,agent,plan}`;
`auto-type-humanization-plan.md`.)

**Pipeline:** renderer `handleAutoType` → IPC `auto-type:send` → countdown →
**perceive** (`readFocusedViaUIA` — a persistent PowerShell process reading
Windows UI Automation TextPattern) → **plan** (deterministic
`planAutoTypeFromUIA`, demoted to a fallback floor; **vision is primary** —
screenshot → `/autotype-vision` → Sonnet multi-op list; fallbacks text-agent
Sonnet→Groq, then Haiku) → **execute** (two engines: multi-op
`executeMultiOpPlan`, and the single-region loop with SID drift detection) →
**humanize** (~900 lines: log-normal timing, burst/flow/hesitation modes,
AR(1) momentum, bigram timing, Pareto pauses, per-key dwell, typos,
autocomplete-accept, backtrack) → **verify/repair** (UIA re-read, bracket
balance, vision repair pass) → **log** (`.autotype-plans.jsonl`).

**Known issues (from the May-2026 audit):** line-coordination drift between
vision's screenshot line numbers and the executor's UIA line numbers →
off-by-N → doubled/wiped content; verify is substring-presence only (misses
doubling); the indent handling was reverted from P3c predict-and-skip to
always-wipe (correctness fix, but re-introduces a humanization tell — proper
fix is probe-and-skip). The **v3 plan** addresses these (perceive via clipboard
when UIA is blind; deterministic diff replaces vision line-counting).

### 4.3 Support bot — server ✅, renderer 🟡

(`support.js` ✅, `anthropicSupport.js` ✅, `ntfy.js` ✅,
`supportEscalation.js` ✅, `botTools.js` 🟡, `SupportBot.tsx` 🟡.)

"Minica" — an in-app support assistant. `/api/v1/support/chat` runs an SSE
tool-loop on Claude Sonnet (`anthropicSupport.js`); `botTools.js` is the
role-gated tool catalog (anon/free → none; user → app-settings + own
subscription; admin → full). Client-side tools emit `tool_call` SSE →
renderer `botActionDispatcher` (fixed earlier this session — App.tsx wasn't
passing it). v2 adds a DB-backed agent inbox, `/ws/support` live chat, a
staged escalation worker (`supportEscalation.js`: ntfy → email → SMS →
fallback), and ntfy.sh phone push.

### 4.4 Renderer — interview core ✅ (`App.tsx`, 7048 lines)

The renderer's heart, top to bottom:

- **Module scope** — `electronIPC` (thin wrapper over the preload bridge,
  no-ops in browser); auto-type OCR-skip helpers (`captureScreenBase64ForOCR`,
  `computeAutoTypeSkipLines` — Tesseract, the non-UIA fallback).
- **`CodeBlock`** — fenced code block + the Auto-Type button & its phase
  machine (idle→thinking→countdown→typing→done/verify-mismatch), listening to
  `auto-type:status`.
- **`MessageRenderer`** — memoized ReactMarkdown + Prism; intercepts the AI's
  `[label](upgrade)` links → dispatches `app:open-manage-subscription`.
- **`Modal`** — reusable focus-trap dialog.
- **`ChatInterface`** — the SHARED chat UI, two render modes: compact popout
  (`isPipMode`) and full main window. Model picker is a portal'd popover (not
  native `<select>` — content-protection).
- **`PiPWindow`** — browser Document-Picture-in-Picture portal (web only).
- **`useFeatureGate`** — effective tier (trial boosts Free→Basic) →
  `FEATURE_GATES` flags. **`MODEL_REGISTRY`/`ModelPickerCard`** — 5-model meta.
- **`useCreditTimer`** + Hour/Low/Exhausted modals — session credit clock for
  Basic + Free-trial (Pro/Max unlimited).
- **Checkout flow** — `openProUpgrade`/`openProRenewal`: POST to
  `payments/create-checkout|upgrade-tier|create-renewal`, open Stripe/Razorpay
  in the OS browser, then `pollForExternalUpgrade/Renewal` polls
  `license/validate` until the server reflects the new tier (the renderer
  never sees Stripe's redirect). Every step emits `app:checkout-status` → toast.
- **`ConversationSidebar`** — date-bucketed session history. **`PopoutResizeHandles`**.
- **`MainApp`** — the big stateful component: `useDatabase`, the auto-title
  pipeline (live + retroactive backfill), the Train Model pipeline (Max), the
  admin support WebSocket (`/ws/support`, event-bus to SupportBot),
  **`executeSend`** (the AI streaming engine — routes to
  `streamGemini/OpenAI/XAI/Groq/Claude`, rAF-coalesced rendering, relays every
  token to the popout), speech handling (autoSend on 1.2s silence), main↔popout
  IPC sync, `botActionDispatcher` (support-bot client tools), file/context
  ingestion, the scroll/pin engine, and every modal.
- **`App`** (default export) — auth wrapper: loads saved auth, focus-revalidates
  the license, renders `SubscriptionGate` when unauthenticated OR on web (the
  app is Electron-only), else `MainApp`.

Cross-cutting: the popout is a thin client (main owns speech, the credit timer,
`executeSend`; popout mirrors via `relay-to-*` IPC); native dialogs are avoided
everywhere for screen-share safety; `session-active` IPC fires off
`_rawIsListening` so main tears down the tray.

### 4.5 Renderer — AI provider services ⬜
`aiProxyService.ts`, `claudeService.ts`, `openaiService/groqService/geminiService/xaiService.ts`, `techStateCache.ts`.

### 4.6 Renderer — auth / licensing / paywall ⬜
`SubscriptionGate.tsx`, `licenseService.ts`, `creditTimerService.ts`, `pricingService.ts`, `geoService.ts`.

### 4.7 Subscriptions & payments ⬜
`ManageSubscription.tsx`, `RefundPolicy.tsx`, server `payments.js`, `webhooks.js`, `subscriptionStates.js`, `refundEligibility.js`.

### 4.8 Server core ⬜
`index.js` (Express bootstrap, WS server, middleware chain), `database.js` (SQLite schema + all helpers), `email.js`, `backup.js`.

### 4.9 Server routes & middleware ⬜
`ai.js` (non-autotype), `auth.js`, `admin.js`, `license.js`, `geo.js`, `conversations.js`, `downloads.js`; middleware `auth/admin/tier/regionGate`.

### 4.10 Server AI services ⬜
`searchProvider.js`, `freshContext.js`, `questionClassifier.js`, `cryptoDocs.js`.

### 4.11 Electron-side DB + renderer hooks ⬜
`electron/database.cjs`, `main.cjs` 5460–6145; `hooks/useDatabase.ts`, `useSpeechRecognition.ts`, `usePrefetchContext.ts`, `useAnimatedModal.ts`.

---

## 5. Read Ledger (honesty record)

✅ **Fully read:** `App.tsx` · `main.cjs` 1–5460 · `preload.cjs` ·
`bracketTracker.cjs` · `autoTypePlanLog.cjs` · `support.js` ·
`anthropicSupport.js` · `ntfy.js` · `supportEscalation.js` ·
`autoTypeVisionAgent.js` · `autoTypeAgent.js` · `groqAutoTypePlanner.js` ·
`stubDetector.js` · `ai.js` autotype routes · `auto-type-humanization-plan.md`.

🟡 **Partial:** `SupportBot.tsx` · `botTools.js` · `database.js` ·
`index.js` · `licenseService.ts` · `ai.js` (non-autotype).

⬜ **Not yet read:** `SubscriptionGate.tsx`, `ManageSubscription.tsx`,
`Documentation.tsx`, renderer services + hooks, `electron/database.cjs`,
`main.cjs` 5460–6145, server `index.js`/`database.js`/`email.js` + routes +
services + middleware.

*Next: §4.6 — `SubscriptionGate.tsx` (auth / licensing / paywall).*
