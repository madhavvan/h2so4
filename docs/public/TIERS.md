# Tiers and billing

What each plan unlocks, how pricing varies by region, when refunds are available, and how cancellation works.

For the customer-facing **[Refund Policy](https://minicaai.com/refund-policy)** in detail, see the dedicated page on minicaai.com. This document is the friendly explainer.

## Contents

1. [The four tiers](#1-the-four-tiers)
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
| AI models | 4 during trial (no Claude) | Gemini, GPT-5.5, Grok, Groq | + Claude Sonnet 5 (all 5) | All 5 | All 5 |
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
- **India**: INR pricing via Razorpay — Basic/Pro/Max as one-time charges, Ultra as a monthly subscription

Indian customers must have an active paid subscription to access the AI features. The Free tier is not available in India due to regional licensing constraints; this is enforced server-side and applies regardless of the app you install.

## 5. Switching tiers

You can upgrade or downgrade at any time from the **Manage Subscription** dialog inside the app, or by emailing **support@minicaai.com**.

- **Upgrades** take effect immediately. Stripe charges the prorated difference for the remainder of your current cycle.
- **Downgrades** take effect at the end of your current billing cycle. You keep the higher tier's features until then; on renewal, the new lower tier kicks in.
- **Switching from Pro to Basic mid-cycle** preserves the unused time as a credit on your account, applied to your next renewal.

## 6. Refunds

Our refund policy is documented in full at **[minicaai.com/refund-policy](https://minicaai.com/refund-policy)**. The summary:

| Case | Eligible for refund? |
|---|---|
| Within 14 days of first paid charge, fewer than 2 hours used | Yes — full refund |
| Within 14 days of first paid charge, more than 2 hours used | At our discretion (typically pro-rated) |
| Past 14 days of first paid charge | No — subscriptions don't include retroactive refunds beyond the trial window |
| Renewal charge for an existing subscription | No — renewals are not refundable; cancel before renewal date to avoid the charge |
| Service fully unavailable for >24 hours due to our outage | Pro-rated credit on next renewal |
| You disputed a charge with your bank without contacting us first | No — chargeback eligibility is independent of our refund policy |

To request a refund, email **support@minicaai.com** with your account email and the approximate purchase date. We respond within 2 business days.

## 7. Cancellation

You can cancel from inside the app's **Manage Subscription** dialog. Cancellation:

- Takes effect at the **end of your current billing cycle** (you keep access until then)
- Is reversible up until the cycle end — click **Reactivate** in the same dialog

Stripe customers can also cancel through their bank's customer portal if needed. Razorpay customers cancel through the in-app dialog only.

After your subscription ends:

- You retain read-only access to your conversation history for **180 days**
- You can re-subscribe at any time with the same email; your conversation history reattaches
- Your résumé and JD files stay on your local machine regardless of subscription state

## 8. License binding

A subscription is bound to the device that activates it. Practical effects:

- You can sign out and sign back in on the same machine — that's fine
- You cannot sign in to one license on two different machines simultaneously — the second sign-in evicts the first
- Switching devices (new laptop) requires emailing **support@minicaai.com** so we can release the old binding. This is a one-day turnaround typically

## 9. Renewals and lapsed subscriptions

- Subscriptions auto-renew at the end of each billing cycle. The card on file is charged 24 hours before renewal.
- A failed renewal puts your account into a **past_due** state. We retry up to 3 times over 7 days. During this window you keep access; after the third failure the subscription transitions to **expired** and access is revoked at cycle end.
- An expired subscription can be renewed at any time by signing in and re-subscribing through the **Manage Subscription** dialog. Your conversation history reattaches automatically.

## 10. Frequently asked questions

**Can I share one license with a friend?** No. The license is device-bound and licensed for one user. Sharing is a violation of our terms.

**Do I need to pay tax?** Stripe and Razorpay handle tax computation automatically based on your billing address (US sales tax, India GST, EU VAT, etc.).

**Is there a discount for students?** Not currently; we may revisit this in 2026.

**Is there an annual plan?** Currently subscriptions are monthly only. Annual plans with a discount are on the roadmap.

**Can I pay by invoice / wire transfer?** Not for individual subscriptions. For team or enterprise licenses (5+ seats), email **sales@minicaai.com**.

**What happens to my conversations when I cancel?** Your local conversation database stays on your machine indefinitely. The server-side mirror is retained for 180 days after cancellation, then deleted.

---

For our trust posture and what we promise about your data, see **[Security](./SECURITY.md)** and **[Privacy](./PRIVACY.md)**.
