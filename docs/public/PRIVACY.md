# Privacy policy

Last updated: 2026-05-10.

This is our customer-facing privacy policy. It explains what data we collect, why, where it lives, how long we keep it, and what rights you have over it. If you want a more technical security overview, see **[Security](./SECURITY.md)**.

If you have questions or want to exercise any of the rights listed below, write to **privacy@minicaai.com**.

## Contents

1. [Who we are](#1-who-we-are)
2. [What data we collect](#2-what-data-we-collect)
3. [How we use your data](#3-how-we-use-your-data)
4. [Third parties that process your data](#4-third-parties-that-process-your-data)
5. [Where your data is stored](#5-where-your-data-is-stored)
6. [How long we keep it](#6-how-long-we-keep-it)
7. [Your rights](#7-your-rights)
8. [Children](#8-children)
9. [How we handle changes to this policy](#9-how-we-handle-changes-to-this-policy)

---

## 1. Who we are

**Interview Copilot AI** is operated by **Venu Madhav Pentala** (Indianapolis, Indiana, USA), reachable at **support@minicaai.com**. The product is a desktop application that helps job candidates prepare for and conduct video interviews. Our website is **minicaai.com**.

For privacy questions specifically: **privacy@minicaai.com**.

## 2. What data we collect

We split data into two categories: what you give us directly, and what the app generates as you use it.

### What you give us directly

| Category | Examples |
|---|---|
| Account identity | Your email address, display name, country, and (if you sign in with Google) a Google account ID |
| Authentication | Your password (stored as a bcrypt hash; we never see the plain text) |
| Payment information | Handled entirely by **Stripe** or **Razorpay**. We see your subscription state and the transaction amount; we never see your card number |
| Résumé and job description | The files you drop into the **Files** panel inside the app. The copy of record lives on your machine. Two other things happen with the text: it's sent to the AI model as part of the prompt for answer calls (the model provider receives it transiently for that call and doesn't retain it under their API terms), and we hold a copy **in memory on our server for up to 3 hours** so the app can send a short reference instead of re-uploading your whole knowledge base with every question. That copy is never written to our disks, is readable only by your own account, and is deleted immediately if you delete your account. See [§5 Where your data is stored](#5-where-your-data-is-stored) |
| Custom instructions | Any persistent instructions you've written for the model. Stored on your machine |

### What the app generates

| Category | Examples |
|---|---|
| Conversation history | The questions you typed and the answers the AI returned. Stored on your machine and mirrored to our server so you can resume on a fresh install |
| Audio (voice mode) | What you and your interviewer said during a session. Held in memory only on your machine for the few seconds it takes to transcribe, then discarded |
| Transcripts | The text result of the live transcription. Becomes part of your conversation history; not separately stored |
| Subscription state | Your tier, billing cycle, region, sessions used. Stored on our server |
| Device fingerprint | A hash of your screen resolution, timezone, browser user-agent, and a few other browser-reported values. Used to bind your license to one device |
| Login logs | Each sign-in attempt: timestamp, IP address, country (derived from IP), success or failure reason. Used for fraud and account-security investigations |
| Crash reports | Written locally on your machine only (a memory dump plus app version and OS — no chat content). Uploading crash reports to our server is currently disabled. |

### Screen captures (Auto-Solve and Auto-Type)

Two features read your screen, and both are worth stating plainly because they are the only place the app looks outside its own window.

| Feature | Plans | What is captured | Where it goes |
|---|---|---|---|
| **Auto-Solve** | every paid plan | A single still frame of your **whole display**, taken when you press the button — not a recording, and never without that press. Whatever else is on that display is in the frame | Sent with your prompt to the AI model for that one call. Not stored on our server |
| **Auto-Type** | Ultra & Enterprise | A single still frame of the display your cursor is on, taken only when the app cannot read the code editor through the accessibility APIs it tries first | Uploaded to our server, which passes it straight to the AI model so it can read the editor, and does not keep it. A copy **is written to your own machine** under the app's data folder (`autotype-screenshots`), where the 50 most recent are kept so you can see what the assistant saw. Deleting the app's data folder removes them |

Neither feature records continuously, and neither runs on the free trial.

We do **not** collect: keystrokes outside the app, your contact list, your browser history, the contents of other windows *except* in the single-frame captures described immediately above, or anything else that isn't explicitly listed here.

## 3. How we use your data

We use the categories above to:

- **Run the product**: send your prompts to the AI provider and return the response, transcribe your audio in real time, sync your conversation history across reinstalls
- **Bill you**: process payments via Stripe or Razorpay, manage subscription renewals, issue refunds
- **Enforce the terms**: per-plan device allowances cap how many machines a license can be active on at once; region pricing prevents VPN-based price arbitrage
- **Keep the product secure**: detect compromised accounts, investigate fraudulent payments, debug crashes
- **Improve the product**: aggregate usage stats (e.g. "what % of users hit Auto-Solve") at a level that doesn't identify you personally. We do not train models on your data and do not sell your data

We never sell, share, or license your data to advertisers, recruiters, or third parties beyond the named processors in the next section.

## 4. Third parties that process your data

These are the only third parties that ever see any part of your data, and only the parts listed:

| Processor | What they receive | Why |
|---|---|---|
| **Anthropic, OpenAI, Google, Groq, xAI** | The active prompt (your question + your résumé + the JD + the AI's prior responses in this session) | To generate the AI answer. Each provider's terms exclude API traffic from training |
| **Deepgram** | Live audio while voice mode is on | Real-time transcription. Audio is not retained per their API terms |
| **Brave Search** | Anonymized keyword queries derived from your interview transcript | Web search context for technical answers. The query carries no personal identifier |
| **Stripe** (US, EU, ROW customers) | Your email, the subscription tier, the transaction amount, and your card details | Payment processing |
| **Razorpay** (India customers) | Same as Stripe but for INR transactions | Payment processing |
| **GitHub** | Your IP address when the app checks for updates (standard web request metadata; nothing from your account) | GitHub Releases hosts the app's auto-update feed and installers |
| **Resend** | Your email address only, transient | Sending password-reset and account emails |
| **Railway** | Server hosting | The infrastructure our backend runs on |

## 5. Where your data is stored

- **On your machine**: a local SQLite database in your user-data directory. Holds your conversation history, your résumé and job description, your custom instructions, and your settings. Auto-Type also keeps its 50 most recent screen captures here.
- **On our server (US-East)**: subscription state, conversation mirror, login logs, and the audit log. The database is hosted on Railway with daily backups.
- **In our server's memory, briefly**: the text of your knowledge-base files, for up to 3 hours from last use, so the app can reference it rather than re-upload it on every question. Held in memory only — never written to our disks, never in a backup, and gone on restart, on expiry, or the moment you delete your account.
- **With third-party processors**: only the data listed in the table above, only for the duration each processor needs to do its job.

We do not transfer data outside our US-East server other than to the named processors. Stripe and Razorpay may store payment information in their own jurisdictions per their respective policies.

## 6. How long we keep it

| Data | Retention |
|---|---|
| Conversation history (server mirror) | While your account is active. Deleted within 30 days of account deletion |
| Knowledge-base text (in-memory server cache) | Up to 3 hours from last use. Deleted immediately on account deletion — it is not part of the 30-day window below because it never reaches disk |
| Auto-Type screen captures | On your machine only; the 50 most recent are kept, older ones are deleted automatically |
| Login logs | 12 months |
| Audit log (admin actions affecting your account) | 24 months; entries that document a payment, refund, or dispute are kept with the payment records below |
| Crash reports | Stored locally on your machine only — server upload is currently disabled |
| Payment records | 7 years (legally required for tax) |
| Subscription state | While your account is active |

When you delete your account, the data above (except payment records, which we're legally required to retain) is removed from our active systems within 30 days and from backups within 90 days.

## 7. Your rights

Depending on where you live, you have the following rights over your data:

- **Right to access**: ask for a copy of everything we have about you. Email **privacy@minicaai.com**; we respond within 30 days.
- **Right to rectification**: ask us to correct anything inaccurate. Your display name is editable in the app (Manage subscription → Account); for email or region changes, write to us.
- **Right to erasure**: ask us to delete your account and the associated data. Ask **Minica** (the in-app support chat) to delete your account — it confirms, then deletes immediately — or email **privacy@minicaai.com**.
- **Right to restrict processing**: ask us to stop processing your data while we resolve a dispute.
- **Right to portability**: ask for your conversation history in a portable JSON format.
- **Right to object**: object to specific uses of your data by writing to **privacy@minicaai.com**. (Crash reports never leave your machine today — server upload is disabled.)
- **Right to withdraw consent**: withdraw any consent you've given us. The app and its data deletion routines respect this.

We don't make automated decisions that produce legal effects against you.

## 8. Children

The product is not intended for users under 16. We don't knowingly collect data from anyone under that age. If you believe a child has signed up, write to **privacy@minicaai.com** and we'll delete the account.

## 9. How we handle changes to this policy

We update this policy when our practices change or when the law requires us to. The **Last updated** date at the top reflects the most recent change. Major changes (new data categories, new processors, expanded retention) are notified via email at least 30 days before they take effect.

---

For the trust-and-security companion document — what we promise about how the desktop app behaves on your machine — see **[Security overview](./SECURITY.md)**.
