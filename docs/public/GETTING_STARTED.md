# Getting started

A short walkthrough — install the desktop app, sign in, drop in your résumé and the job description, and start your first interview.

## Contents

1. [What Interview Copilot does](#1-what-interview-copilot-does)
2. [System requirements](#2-system-requirements)
3. [Install](#3-install)
4. [Sign in and pick a plan](#4-sign-in-and-pick-a-plan)
5. [Add your résumé and the job description](#5-add-your-resume-and-the-job-description)
6. [Start your first session](#6-start-your-first-session)
7. [The pop-out window](#7-the-pop-out-window)
8. [Common issues](#8-common-issues)

---

## 1. What Interview Copilot does

Interview Copilot is a desktop assistant that listens to your interview through system audio, holds your résumé and the role in working memory, and drafts answers in your voice — character-by-character, in real time. It runs as an always-on-top pop-out window that's invisible to the interviewer's screen-share.

You stay in control of every answer. The copilot suggests; you decide what to say.

## 2. System requirements

| Platform | Minimum | Recommended |
|---|---|---|
| Windows | Windows 10 build 19044 | Windows 11 |
| macOS | macOS 12 Monterey | macOS 14 Sonoma |
| Linux | Ubuntu 22.04 LTS / Fedora 38+ | — |
| Memory | 8 GB | 16 GB |
| Disk | 500 MB free | — |
| Network | Stable broadband | — |

Microphone access is required so the app can capture system audio. Screen-capture permission is required if you plan to use Auto-Solve (one-shot screenshot answer for coding questions).

## 3. Install

Pick the right installer for your operating system:

- **Windows** → [InterviewCopilot-Setup.exe](https://get.minicaai.com/windows)
- **macOS** (Apple Silicon and Intel — single Universal Binary) → [InterviewCopilot-Mac.dmg](https://get.minicaai.com/mac)
- **Linux (AppImage)** → [InterviewCopilot-Linux.AppImage](https://get.minicaai.com/linux)
- **Linux (Debian / Ubuntu .deb)** → [InterviewCopilot-Linux.deb](https://get.minicaai.com/linux)

The Windows installer is signed by Azure Trusted Signing, so SmartScreen lets it run without a warning. The macOS build is currently delivered unsigned — on first launch, right-click the app and choose **Open** to bypass Gatekeeper, then **Open** again in the prompt. (Notarization is on the roadmap; once it's in place the right-click step goes away.)

## 4. Sign in and pick a plan

The first time you open the app you'll be asked to sign in. Use email + password or Google. Your account is bound to the device that activates it; you can sign out and sign back in on the same machine, but the license doesn't roam across multiple machines on the same plan.

After sign-in you'll see a tier picker:

- **Free** — 5 sessions, 30-minute trial total, Gemini model, one context file
- **Basic** — Unlimited sessions, credit-gated time (3-hour starting bank, renewable), four models (Gemini, GPT, Grok, Groq), unlimited context files, pop-out, screen capture, Auto-Solve
- **Pro** — Same as Basic plus unlimited time, no credit gating
- **Max** — Adds Claude with web search, Auto-Type, Train Model, reasoning-effort knob

Pricing varies by region; the picker shows your local currency.

## 5. Add your résumé and the job description

Open **Files** (paperclip icon in the top-right of the chat) and drop in:

- Your résumé (PDF, DOCX, or paste)
- The job description for the role you're interviewing for
- Optional: any company-specific notes (technologies you should mention, recent product launches, your interviewer's name)

The copilot prepends these to every answer it drafts. Without them, answers are generic; with them, the copilot picks relevant projects from your résumé and frames them against what the role asks for.

## 6. Start your first session

1. Click **MIC OFF** in the bottom bar — it flips to **MIC LIVE**.
2. Pick the source: a Chrome tab playing your video call, your whole screen, or a specific window. **Important:** check **Also share tab audio** (or the equivalent system-audio toggle) — without it, the copilot can't hear the interviewer.
3. Click **AUTO** to enable auto-send. Now every time the interviewer finishes a question, the copilot auto-drafts an answer 1.2 seconds after they stop talking. You can read it on screen or wait for them to elaborate.
4. To send manually instead, leave **AUTO** off and click the send arrow when you want a response.
5. To get a coding answer from a screenshot, click the magnifier icon (**Auto-Solve**). The app captures the visible screen, hands the question + image to the model, and drafts a code answer.

When the interview ends, click **MIC LIVE** to stop. Your conversation is saved automatically.

## 7. The pop-out window

The pop-out is a small always-on-top chat window that floats over your interview app (Zoom, Meet, Teams, the proctored browser). Open it with the **External link** icon in the top bar.

A few things to know:

- The pop-out is invisible to screen-sharing on every supported OS. The interviewer sees the area behind it.
- It cycles between three sizes (S / M / L) via the **S/M/L** button in its header.
- Drag to move; pull on top, bottom, or any corner to resize.
- Closing it doesn't end the session — re-open from the same icon.

If you're typing into your code editor and the pop-out steals focus, click on the editor again. The pop-out is non-focusable by default and only takes focus when you click directly on its text input.

## 8. Common issues

**The copilot can't hear my interviewer.** You forgot to check **Also share tab audio**. Stop the mic, restart it, and re-pick the source — make sure the audio toggle is on.

**The pop-out is missing / opened off-screen.** Click **External link** again to bring it back. The window will re-spawn at the center of your current display.

**Auto-Solve doesn't capture anything.** Grant screen-capture permission in your OS settings (Privacy & Security → Screen Recording on macOS; Settings → Privacy → Screenshots on Windows). Restart the app afterward.

**My subscription isn't showing.** Sign out and sign back in. The license refreshes from our servers on every fresh login.

**Auto-update didn't pick up the latest version.** Quit the app fully (system tray → Quit) and re-launch. Updates install on the next clean launch.

For anything else, email **support@minicaai.com**.
