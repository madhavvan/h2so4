# Tiers and billing

What each plan unlocks, how pricing varies by region, when refunds are available, and how cancellation works.

For the customer-facing **[Refund Policy](https://minicaai.com/refund-policy)** in detail, see the dedicated page on minicaai.com. This document is the friendly explainer.

## Contents

1. [The five tiers](#1-the-five-tiers)
2. [What each tier unlocks](#2-what-each-tier-unlocks)
3. [Trial mechanics](#3-trial-mechanics)
4. [Pricing and regions](#4-pricing-and-regions)
5. [Switching tiers](#5-switching-tiers)
6. [Refunds](#6-refunds)
7. [Cancellation](#7-cancellation)
8. [License binding](#8-license-binding)
9. [Renewals and lapsed subscriptions](#9-renewals-and-lapsed-subscriptions)
10. [Frequently asked questions](#10-frequently-asked-questions)

---

## 1. The five tiers

We offer five plans: **Free**, **Basic**, **Pro**, **Max**, and **Ultra**. Free lets you try the app without payment. Basic, Pro, and Max are **one-time interview purchases** — you buy a set amount of live-interview time and use it within 30 days. **Ultra** is the only monthly subscription: unlimited interviews plus Auto-Type.

- **Basic** — one 30-minute interview
- **Pro** — one 1-hour interview
- **Max** — three 1-hour interviews
- **Ultra** — unlimited interviews, billed monthly

Because Basic/Pro/Max are one-time buys, there's nothing recurring on them to "downgrade" — you simply purchase the tier that fits the interview ahead of you. Ultra you can cancel any time from **Manage Subscription**.

## 2. What each tier unlocks

| Feature | Free | Basic | Pro | Max | Ultra |
|---|---|---|---|---|---|
| Interview time | 10-min trial total | One 30-min interview | One 1-hour interview | Three 1-hour interviews | Unlimited |
| AI models | 4 during trial (no Claude) | Gemini, GPT-5.6, Grok, Groq | + Claude Sonnet 5 (all 5) | All 5 | All 5 |
| Context files | 1 | Unlimited | Unlimited | Unlimited | Unlimited |
| Pop-out window | — | ✓ | ✓ | ✓ | ✓ |
| Screen capture (Auto-Solve) | — | ✓ | ✓ | ✓ | ✓ |
| Auto-Type into editor | — | — | — | — | ✓ |
| Train Model (résumé + JD pre-research) | — | — | — | ✓ | ✓ |
| Reasoning-effort knob | — | — | — | ✓ | ✓ |
| Custom Instructions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Web search inside Claude answers | — | — | ✓ | ✓ | ✓ |
| Export conversation history | — | ✓ | ✓ | ✓ | ✓ |
| Minica support chatbot | Scripted FAQ + handoff | Full AI chat | Full AI chat | Full AI chat | Full AI chat |
| Talk to a human handoff | ✓ | ✓ | ✓ | ✓ | ✓ |

Notes on the more premium features:

- **Auto-Type** is an **Ultra-only** feature. It types an AI-drafted answer directly into your code editor, with realistic timing. It's the differentiator for the unlimited subscription tier.
- **Claude (Anthropic Sonnet 5 with web_search)** unlocks at **Pro** and above. Basic is the only paid tier without Claude.
- **Train Model** and the **reasoning-effort knob** unlock at **Max** and above.
- **Minica (the AI support chatbot)** is full-featured AI from Basic upward. Free tier uses a scripted FAQ — pick a topic from a list, get a curated answer. Every tier can hand off to a human at any time. The reasoning: AI support calls are billed inference, and the cost per support session is similar to a regular interview call; reserving the AI chat for paid tiers keeps the Free plan genuinely free at our expense.

## 3. Trial mechanics

The Free tier is genuinely free — no card on file, no auto-conversion. You get a one-time 10 minutes of combined trial time with every model except Claude, and one context file. After the 10 minutes are spent, you'll see a prompt to upgrade — nothing stays free past the trial.

We do not auto-convert Free trials to paid subscriptions. You explicitly pick a tier and enter payment details.

## 4. Pricing and regions

Pricing depends on your country. We use IP-based geolocation to detect your region on first sign-in and pin your prices accordingly. To prevent VPN-based price arbitrage, your region is locked at signup; switching countries later requires emailing **support@minicaai.com**.

The current price list is shown on the **[Pricing page](https://minicaai.com/#pricing)**. The two main regional bands:

- **United States and most countries**: USD pricing via Stripe — Basic/Pro/Max as one-time charges, Ultra as a monthly subscription
- **India**: INR pricing via Razorpay — Basic/Pro/Max as one-time charges, Ultra as a monthly subscription. While our Razorpay merchant account is being provisioned, Indian checkouts temporarily run through Stripe in USD; UPI and NetBanking return the moment it clears.

Indian customers must have an active paid subscription to access the AI features. The Free tier is not available in India due to regional licensing constraints; this is enforced server-side and applies regardless of the app you install.

## 5. Switching tiers

Everything happens from the **Manage Subscription** dialog inside the app (or email **support@minicaai.com**). Under the 2026-07 model:

- **Buying a bigger pass** (e.g. Basic → Max): a fresh checkout, charged today. The new pass's full interview clock replaces whatever remained on your old pass, and its 30-day window starts fresh.
- **Need more minutes on the pass you already have?** Use the interview-day extensions instead (+30 min $25 / +1 h $45 / +3 h $80) — they stack onto your existing clock without replacing it.
- **Going Ultra**: starts the monthly subscription immediately at checkout.
- **Leaving Ultra for passes**: cancel Ultra (you keep unlimited access until the cycle ends), then buy passes whenever an interview comes up. There is no in-place swap between Ultra and the one-time passes.

## 6. Refunds

Our refund policy is documented in full at **[minicaai.com/refund-policy](https://minicaai.com/refund-policy)**. The summary:

| Case | Eligible for refund? |
|---|---|
| Within 14 days of first paid charge, fewer than 2 hours used | Yes — full refund |
| Within 14 days of first paid charge, more than 2 hours used | At our discretion (typically pro-rated) |
| Past 14 days of first paid charge | No — the refund window has closed |
| Ultra renewal charges after the first, or interview extension top-ups | No — not refundable; cancel Ultra before the renewal date to avoid the next charge |
| Service fully unavailable for more than 48 consecutive hours due to our outage | Ultra: pro-rated credit on next renewal · Pass holders: refund or replacement interview credits |
| You disputed a charge with your bank without contacting us first | No — and chargebacks result in account termination (see the full policy) |

To request a refund, email **support@minicaai.com** with your account email and the approximate purchase date. We respond within 2 business days.

## 7. Cancellation

Cancellation applies to the **Ultra** subscription — the one-time passes (Basic/Pro/Max) never bill again, so there's nothing to cancel; they simply expire. From the app's **Manage Subscription** dialog, cancelling Ultra:

- Takes effect at the **end of your current billing cycle** (you keep unlimited access until then)
- Is reversible up until the cycle end — click **Resume — keep my subscription** in the same dialog

Stripe customers can also manage or cancel through the Stripe billing portal (**Manage billing in Stripe** in the same dialog). Razorpay customers cancel through the in-app dialog only.

After your subscription ends:

- Your conversation history stays attached to your account — nothing is deleted on cancellation
- You can re-subscribe or buy a one-time pass at any time with the same email; everything picks up where you left off
- Your résumé and JD files stay on your local machine regardless of subscription state

## 8. License binding

Every plan includes a device allowance — how many machines the license can be active on at once:

- **Free / Basic**: 2 devices · **Pro**: 3 · **Max**: 5 · **Ultra**: 10
- Each device registers automatically when you sign in; no support ticket needed to switch machines
- Signing in past your allowance automatically deactivates your **oldest** device — so you can always move to a new laptop instantly, but a seat can't be farmed out to other people

## 9. Renewals and lapsed subscriptions

- **Ultra** renews automatically on your billing-cycle date (the one-time passes never renew — their remaining time simply expires at the end of the 30-day window).
- A failed Ultra renewal puts your account into a **past_due** state while the payment provider retries over roughly the following week. You keep access during the retries; if they exhaust, the subscription ends and your tier drops to Free.
- A lapsed account can come back any time: sign in and buy a pass or restart Ultra from the **Manage Subscription** dialog. Your conversation history is still attached to the account.

## 10. Frequently asked questions

**Can I share one license with a friend?** No. The license is for one person — the device allowance exists so *you* can move between your own machines. Sharing credentials violates our terms and can get the account revoked.

**Do I need to pay tax?** Stripe and Razorpay handle tax computation automatically based on your billing address (US sales tax, India GST, EU VAT, etc.).

**Is there a discount for students?** Not currently; we may revisit this in 2026.

**Is there an annual plan?** Currently subscriptions are monthly only. Annual plans with a discount are on the roadmap.

**Can I pay by invoice / wire transfer?** Not for individual subscriptions. For team or enterprise licenses (5+ seats), email **sales@minicaai.com**.

**What happens to my conversations when I cancel?** Nothing — your local conversation database stays on your machine, and the server-side mirror stays attached to your account. Only deleting the account removes the server copy (immediately and permanently).

---

For our trust posture and what we promise about your data, see **[Security](./SECURITY.md)** and **[Privacy](./PRIVACY.md)**.
