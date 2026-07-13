# FAQ

Quick answers to questions we hear most. For full walkthroughs, see **[Getting Started](./GETTING_STARTED.md)**, **[Features](./FEATURES.md)**, or **[Troubleshooting](./TROUBLESHOOTING.md)**.

## Contents

1. [General](#1-general)
2. [Plans and billing](#2-plans-and-billing)
3. [Privacy and security](#3-privacy-and-security)
4. [Compatibility](#4-compatibility)
5. [Account](#5-account)
6. [Refunds and cancellation](#6-refunds-and-cancellation)

---

## 1. General

**What is Interview Copilot?**
A desktop assistant that listens to your interview through system audio, holds your résumé and the role in working memory, and drafts answers in your voice — character-by-character, in real time. The pop-out is invisible to screen-share, so the interviewer doesn't see it.

**Is this cheating?**
We don't make that call for you. The product exists because real interviews increasingly test recall of obscure trivia and high-pressure performance more than they test the actual job. Whether to use it is your decision. We provide the tool; you choose how to use it.

**Does the interviewer see the app?**
No. The pop-out is invisible to screen-share on Windows, macOS, and Linux. The interviewer sees the area behind it. The desktop app's main window can be screen-shared if you choose to share its window — but the pop-out specifically is not.

**Can I use it during an in-person interview?**
The app needs to hear the interviewer through your computer's system audio. In-person interviews don't route audio through your computer, so no — it's designed for video / remote interviews.

**What's the difference between the desktop app and the website?**
The desktop app is where you do the actual interview. The website (minicaai.com) is for marketing, sign-up, and account management. The desktop app calls the website's backend for authentication and billing, but the AI/transcription happens in the app.

## 2. Plans and billing

**What plans are there?**
Free, Basic, Pro, Max, and Ultra. Free is genuinely free (no card required). Basic, Pro, and Max are **one-time interview purchases** — no recurring charge. Ultra is the only monthly subscription. See **[Tiers & Billing](./TIERS.md)** for the full feature breakdown.

**How much do they cost?**
Pricing varies by region. The website's **Pricing page** shows your local currency once we detect your region. In USD: Basic is $30 (one 30-minute interview), Pro is $50 (one 1-hour interview), Max is $89 (three 1-hour interviews) — all one-time. Ultra is $159/month for unlimited interviews plus Auto-Type.

**Can I try before I buy?**
Yes. The Free tier gives you a one-time 10 minutes of trial time with every model except Claude, and one knowledge file. No card on file, no auto-conversion to paid — after the trial you pick a plan to keep going.

**Does the Free trial auto-convert to paid?**
No. Free is genuinely free — we never charge you unless you explicitly pick a paid tier and enter payment details.

**Do you have an annual plan?**
Not yet. Subscriptions are monthly only as of 2026. An annual plan with a discount is on our roadmap.

**Is there a student discount?**
Not currently. We may revisit in 2026.

**Can I pay by invoice / wire transfer?**
Not for individual subscriptions. For team or enterprise (5+ seats), email **sales@minicaai.com**.

**Do I need to add a card to use the Free tier?**
No card required for Free. You only enter payment details when you explicitly pick Basic, Pro, or Max.

**What payment methods do you accept?**
- **USD and most countries**: Visa, Mastercard, Amex, Discover, Apple Pay, Google Pay (via Stripe)
- **India**: Visa, Mastercard, RuPay, UPI, NetBanking (via Razorpay)

**Why do I see prices in INR when I'm not in India?**
The first time you signed in, we detected your IP as India. Your region is locked at signup to prevent VPN price arbitrage. If you've actually moved, email **support@minicaai.com** to switch your billing region.

## 3. Privacy and security

**Is my interview audio sent to your servers?**
No. Audio is sent only to our transcription provider (Deepgram) on a paid API tier where audio is excluded from training. We never receive the audio; we receive the transcribed text result.

**Do AI providers train on my data?**
No. Every model we use runs on a paid API tier where the provider's terms exclude API traffic from training datasets.

**Where is my conversation history stored?**
Locally on your machine in a SQLite database, mirrored to our server (US-East) so you can resume on a fresh install. The server mirror is retained while your subscription is active + 180 days after cancellation, then deleted.

**Can the app read other windows on my machine?**
No. Audio capture is scoped to the specific source you pick (a tab, a window, or the whole screen). Outside that source, the app sees nothing. We don't run a keylogger.

**Can other users see my conversation history?**
Never. History is private to your account and bound to your device.

**Is the app code-signed?**
The Windows installer is signed by Azure Trusted Signing with Venu Madhav Pentala as publisher of record. SmartScreen runs it without warning. macOS is currently unsigned (Apple Developer ID coming Q3 2026). Linux .deb / .AppImage are unsigned in the manner Linux desktop apps typically are.

**Reporting a security issue?**
Email **security@minicaai.com**. We respond to researchers and publicly credit good-faith reports.

## 4. Compatibility

**Which operating systems are supported?**
- **Windows** 10 (build 19044) or later — recommended Windows 11
- **macOS** 12 Monterey or later — recommended macOS 14 Sonoma
- **Linux** Ubuntu 22.04 LTS / Fedora 38+ — AppImage or .deb

**Does it work on iOS / Android?**
Not yet. We focus on the desktop because interviews on mobile are uncommon and the experience would be worse.

**Which interview platforms work?**
Any platform that uses your computer's audio output. Tested on:
- Google Meet (Chrome tab, with tab audio shared)
- Zoom (desktop app, with system audio shared)
- Microsoft Teams (desktop app)
- Webex (desktop app)
- HackerRank live interviews
- CodeSignal
- CoderPad

Anything that routes audio through your computer should work; if it doesn't, write to **support@minicaai.com** with the platform.

**Does it work with Lockdown Browser / proctored exams?**
Some proctored environments fingerprint visible windows. The pop-out is invisible to screen-share, but a stricter proctor could detect Electron's window class. We don't make claims about specific proctors — test it against the platform you're being interviewed in before relying on it.

**Does the Apple Silicon (M-series) build run natively?**
Yes. The macOS build is a Universal Binary that includes both Apple Silicon (arm64) and Intel (x64) slices. Your Mac picks the native slice automatically.

## 5. Account

**How do I change my password?**
Account menu → **Account settings** → **Change password**. You'll need to enter your current password.

**How do I change my email?**
Email **support@minicaai.com** with both the old and new email. We can't change the email field in the app itself (it's also the account identifier).

**How do I sign in on a new machine?**
Sign out on the old machine, then sign in on the new one. The license is device-bound, so the second sign-in evicts the first. If you no longer have access to the old machine, email **support@minicaai.com** to release the binding.

**Can I share my account with a friend?**
No. The license is licensed for one user, bound to one device. Sharing violates our terms.

**How do I delete my account?**
Account menu → **Manage Subscription** → **Delete account**. Or write to **privacy@minicaai.com** from your account email. Data is removed within 30 days from active systems and 90 days from backups.

## 6. Refunds and cancellation

**What's your refund policy?**
- Within 14 days of first paid charge, fewer than 2 hours used → full refund.
- Within 14 days of first paid charge, more than 2 hours used → at our discretion, typically pro-rated.
- Past 14 days → no refund.
- Renewal charges → not refundable; cancel before renewal date to avoid the charge.

Full policy at **minicaai.com/refund-policy**.

**How do I request a refund?**
Email **support@minicaai.com** with your account email and approximate purchase date. We respond within 2 business days.

**How do I cancel my subscription?**
Inside the app: **Account menu → Manage Subscription → Cancel**. Cancellation takes effect at the end of your current billing cycle — you keep access until then.

**Can I get a partial refund for time I haven't used?**
For mid-month cancellations, we don't pro-rate. The reasoning: you keep access to the higher tier until cycle end, so the partial month wasn't wasted. If your circumstances are unusual (e.g., you accidentally renewed despite having cancelled), email **support@minicaai.com** and we'll review.

**What happens to my data when I cancel?**
Your conversation history mirror on our server is retained for **180 days** after cancellation; deleted after that. Your local database stays on your machine indefinitely (it's just files in your user folder). Resubscribing within 180 days reattaches your history automatically.

**Will my card be charged after I cancel?**
No. Cancellation stops future renewals immediately. The current cycle plays out, then your tier drops to Free (or expired, depending on configuration).

---

For anything not covered here, write to **support@minicaai.com** or use the chat with Minica.
