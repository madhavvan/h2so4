# Features

Every feature in the app explained at the level of "what it does for you" — not how it's built. For implementation specifics, write to **security@minicaai.com**.

## Contents

1. [The core loop](#1-the-core-loop)
2. [Capture and transcription](#2-capture-and-transcription)
3. [The pop-out window](#3-the-pop-out-window)
4. [Auto-send](#4-auto-send)
5. [Auto-Solve — screenshots for coding questions](#5-auto-solve--screenshots-for-coding-questions)
6. [Auto-Type — answers typed into your editor (Ultra)](#6-auto-type--answers-typed-into-your-editor-ultra)
7. [Train Model — pre-research the role (Max & Ultra)](#7-train-model--pre-research-the-role-max--ultra)
8. [Custom Instructions](#8-custom-instructions)
9. [Knowledge files — résumé, JD, notes](#9-knowledge-files--résumé-jd-notes)
10. [Multiple AI models](#10-multiple-ai-models)
11. [Web-search-aware answers (Pro & up)](#11-web-search-aware-answers-pro--up)
12. [Conversation history](#12-conversation-history)
13. [Reasoning-effort knob (Max & Ultra)](#13-reasoning-effort-knob-max--ultra)
14. [Region pricing](#14-region-pricing)
15. [Two payment providers](#15-two-payment-providers)
16. [Tier feature matrix](#16-tier-feature-matrix)

---

## 1. The core loop

When you start a session, the app listens to your interview, captures what the interviewer says, and drafts an answer in your voice — character-by-character, in real time. You see the answer on screen; you decide whether to speak it as written, paraphrase, or push back. The interviewer doesn't see the app or the answer.

## 2. Capture and transcription

You click **MIC OFF** in the bottom bar to start capture. The app asks your browser to share a tab, a window, or your whole screen, and you check **Also share tab audio** (or the equivalent system-audio toggle) so the AI can actually hear the interviewer. The audio stream is transcribed live; the resulting text is what the AI sees as the question. The microphone indicator stays **LIVE** for the duration; click it to stop.

Audio is sent only to our transcription provider — never stored on our servers, never used for training under their API terms.

## 3. The pop-out window

The pop-out is a small always-on-top chat window that floats over your interview app (Zoom, Meet, Teams, the proctored browser). Open it with the **External link** icon in the top bar.

What makes it work:
- **Invisible to screen-share** on Windows, macOS, and Linux. The interviewer sees the area behind it.
- **Three sizes** — Small / Medium / Large via the S/M/L button in its header.
- **Resizable** — drag on any edge or corner.
- **Movable** — drag the header to reposition.
- **Doesn't steal focus** — typing into your code editor still goes to the editor. The pop-out only takes focus when you click directly on its input.
- **Closing doesn't end the session** — re-open from the same icon any time.

## 4. Auto-send

Click **AUTO** to enable. With Auto on, every time the interviewer stops talking for ~1.2 seconds, the app drafts an answer automatically — no button press needed. You read it as it streams in. Click **AUTO** again to turn it off; you'll send each question manually with the send arrow.

Use Auto when you're confident in the model and just want it ready. Use manual when you want to edit the transcript before sending (e.g., the interviewer paused mid-sentence).

## 5. Auto-Solve — screenshots for coding questions

Click the magnifier icon during a session to capture your visible screen and have the AI answer the coding question shown. This is the fastest way to get a code answer on LeetCode-style problems where the question is on screen, not spoken.

The screenshot stays in memory for the AI call only — it's not saved to your machine or our servers.

## 6. Auto-Type — answers typed into your editor (Ultra)

Available on the Ultra plan — it's the differentiator of the unlimited monthly subscription. Click the Auto-Type icon, then click into your code editor (the IDE, online judge, or coding sandbox). The AI's answer types into the editor at a realistic human cadence with natural pauses and corrections.

Use it for:
- LeetCode, HackerRank, CodeSignal-style coding questions where the answer goes into a code window
- Long-form take-home questions
- Any text input that supports normal typing

Permissions you need to grant:
- **Windows** — no extra grant; works out of the box
- **macOS** — System Settings → Privacy & Security → Accessibility → toggle Interview Copilot on, then restart the app

## 7. Train Model — pre-research the role (Max & Ultra)

Available on the Max and Ultra plans. Before your interview, click **Train Model** in the chat sidebar. The app reads your résumé and the job description, then prepares a memory pack covering:

- Specific projects from your résumé to reference for likely question themes
- Technologies in the role's stack that match (or don't match) your background
- Likely behavioural-question angles
- Recent company news / product launches you should know about

The pack is loaded into the model's context before your interview starts. Answers are then framed around the angles the trainer flagged.

## 8. Custom Instructions

Type free-form instructions that the model honors across every session. Use this for:

- Voice/tone preferences ("answer like a senior engineer", "be concise — no preamble")
- What to emphasize ("highlight my data pipeline projects", "downplay management experience")
- Specific phrasing to use or avoid ("use 'analytics platform' not 'BI tool'")

Edit Custom Instructions in the **Files** panel. They persist across sessions on the same machine.

## 9. Knowledge files — résumé, JD, notes

Open **Files** (paperclip icon, top-right of the chat) to drop in:

- Your résumé (PDF, DOCX, or paste)
- The job description for the role you're interviewing for
- Optional notes (technologies you should mention, interviewer's name, recent product launches)

These get prepended to every prompt the AI sees. Without them, answers are generic; with them, the AI picks relevant projects from your résumé and frames against what the role asks for. Stored on your machine only.

## 10. Multiple AI models

The app supports five AI providers. Switch between them in the model picker at the top of the chat:

- **Gemini** (Google) — fast, strong on general questions; lighter touch on code. Every plan, free trial included.
- **GPT** (OpenAI) — strong general-purpose model. Every plan, free trial included.
- **Grok** (xAI) — fast inference. Every plan, free trial included.
- **Groq** (open-weight on Groq's fast inference) — lowest latency. Every plan, free trial included.
- **Claude** (Anthropic) — strongest on long-form reasoning and code. Available on Pro, Max, and Ultra; includes web search. Basic is the only paid plan without Claude.

Different interviews may suit different models. Behavioural questions tend to work well on Gemini or GPT; system-design questions where current-state knowledge matters work best on Claude (it has web search).

## 11. Web-search-aware answers (Pro & up)

Claude — available on Pro, Max, and Ultra — can search the web during your answer to pull current information: what's new in a tool, recent API changes, what specific UI controls look like in the latest version of a service. Useful when the interviewer asks about something time-sensitive (a new feature in AWS, a UI tab in Snowflake, a recent benchmark).

You don't trigger web search manually — Claude decides when it's worth the round-trip. The status indicator in the chat shows when a search is happening.

## 12. Conversation history

Every session is saved automatically. Find past conversations in the left sidebar. Each one is searchable and re-openable; you can copy answers from past sessions into a new one if a similar question comes up.

History lives on your machine in a local database; a mirror copy is on our servers so you can pick up where you left off on a fresh install or new device. The mirror stays attached to your account (cancelling a plan doesn't delete it) and is removed immediately and permanently when you delete your account.

## 13. Reasoning-effort knob (Max & Ultra)

For Max and Ultra users on the GPT-5.6 model. The reasoning slider in the chat header has three notches:

- **None** — fastest, simplest answers. The default. Good for behavioural and concept questions.
- **Low / Medium** — adds explicit step-by-step reasoning. Slower; more rigorous on math, code, and design questions.

You can change it mid-session. For most interviews, **None** is the right default — adding reasoning often doesn't change the answer and slows the stream.

## 14. Region pricing

We use IP-based geolocation to detect your country on first sign-in and pin your prices to your local currency.

- **United States and most countries** — USD via Stripe: Basic/Pro/Max as one-time interview passes, Ultra as the monthly subscription.
- **India** — INR via Razorpay (same shapes: one-time passes + monthly Ultra). While our Razorpay merchant account is being provisioned, Indian checkouts run through Stripe in USD instead.

Your region is locked at signup to prevent VPN-based price arbitrage. To change your billing country (e.g., you moved), email **support@minicaai.com**.

## 15. Two payment providers

We accept payment through two providers:

- **Stripe** — USD and most international currencies. Visa, Mastercard, AmEx, Discover, Apple Pay, Google Pay.
- **Razorpay** — INR, UPI, India-issued cards, NetBanking. (While our Razorpay merchant account is being provisioned, Indian checkouts run through Stripe in USD; UPI/NetBanking return the moment it clears.)

The checkout shows the right provider for your region automatically — there's nothing to pick by hand.

## 16. Tier feature matrix

2026-07 model: **Basic, Pro, and Max are one-time interview passes** (use within 30 days); **Ultra is the only monthly subscription**.

| Feature | Free | Basic | Pro | Max | Ultra |
|---|---|---|---|---|---|
| Interview time | 10-min trial total | One 30-min interview | One 1-hour interview | Three 1-hour interviews | Unlimited |
| Extend on interview day | — | +30 min / +1 h / +3 h packs | Same packs | Same packs | Not needed |
| AI models | 4 during trial (no Claude) | Gemini, GPT-5.6, Grok, Groq | All 5 (+ Claude) | All 5 | All 5 |
| Knowledge files | 1 | Unlimited | Unlimited | Unlimited | Unlimited |
| Pop-out window | — | ✓ | ✓ | ✓ | ✓ |
| Auto-Solve | — | ✓ | ✓ | ✓ | ✓ |
| Auto-Type | — | — | — | — | ✓ |
| Train Model | — | — | — | ✓ | ✓ |
| Reasoning-effort knob | — | — | — | ✓ | ✓ |
| Custom Instructions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Web search (in Claude) | — | — | ✓ | ✓ | ✓ |
| Export conversation history | — | ✓ | ✓ | ✓ | ✓ |
| Minica support chatbot | Scripted FAQ | Full AI chat | Full AI chat | Full AI chat | Full AI chat |

For pricing and what each tier costs in your region, see **[Tiers & Billing](./TIERS.md)** or the [Pricing page](https://minicaai.com/#pricing) on the website.

---

For step-by-step troubleshooting, see **[Troubleshooting](./TROUBLESHOOTING.md)**. For quick answers, see **[FAQ](./FAQ.md)**.
