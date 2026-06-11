# Security overview

The trust claims that the desktop app is built around. This page is for you to evaluate before installing.

For implementation specifics — how each claim is enforced in code — write to **security@minicaai.com**. We respond to security researchers and answer technical questions; we don't publish the implementation details on this page because that information also helps attackers and detection vendors.

## Contents

1. [What we promise](#1-what-we-promise)
2. [What we don't do](#2-what-we-dont-do)
3. [Where your data lives](#3-where-your-data-lives)
4. [The desktop app on your machine](#4-the-desktop-app-on-your-machine)
5. [Authentication and licensing](#5-authentication-and-licensing)
6. [How we handle audio](#6-how-we-handle-audio)
7. [Reporting a security issue](#7-reporting-a-security-issue)

---

## 1. What we promise

- **The pop-out window is invisible to screen-share** on Windows, macOS, and Linux. The interviewer sees the area behind it as if it weren't there.
- **No audio is stored on our servers.** The microphone capture stays in memory in the desktop app for the few seconds it takes to transcribe, and is then discarded.
- **No model-provider training.** Every AI model in the app runs on a paid API tier where the provider's terms exclude API traffic from training datasets.
- **Code-signed installer.** The Windows installer is signed by Azure Trusted Signing, with **Venu Madhav Pentala** as the publisher of record. SmartScreen lets it run without a warning. You can verify the signature in Windows file properties before installing.
- **Auto-update over HTTPS.** Updates are fetched from GitHub Releases over HTTPS and verified against the installer's signature before installation.

## 2. What we don't do

- We don't read other windows on your machine. The app's audio capture is scoped to the system-audio source you explicitly pick (a Chrome tab, the whole screen, or a specific window). Nothing outside that source is read.
- We don't run a keylogger. Keystrokes you type into your interview editor are not observed by the app.
- We don't transmit raw audio to anyone except the transcription service while voice mode is active. The transcription stream goes over a single WebSocket to the speech-to-text provider; we receive the text result and forward only the text to the answer-generation model.
- We don't sell, share, or rent any of your data to advertisers, recruiters, or third parties beyond the named processors below.
- We don't keep payment card numbers. Stripe and Razorpay handle them end-to-end; our servers see only the provider's transaction ID and the amount.

## 3. Where your data lives

| What | Where it lives |
|---|---|
| Your conversations | On your machine in a local database. A copy is mirrored to our server so you can pick up where you left off on a fresh install. |
| Your résumé and the job description | On your machine only. They're sent to the AI model as part of the prompt for active calls; the model provider receives them transiently and doesn't retain them under their API terms. |
| Your subscription state | On our server. A cached copy is on your machine so the app works briefly offline. |
| Your payment details | Only with Stripe or Razorpay. We never see your card. |
| Crash reports | If you opted in, on our server. Crash reports include version + platform metadata and a memory dump from the moment of the crash; no chat content. |

For a full data inventory and the legal basis under GDPR / India DPDP / CCPA, read our **[Privacy policy](./PRIVACY.md)**.

## 4. The desktop app on your machine

- Built on Electron with a sandboxed renderer process. The renderer can't access your filesystem, spawn shells, or read other apps; it only reaches our app's main process via a small pre-defined set of allowlisted IPC channels.
- External links inside the app open in your default browser; the app never navigates its own window to anything outside its bundle.
- The macOS build is currently unsigned (we're in the process of obtaining an Apple Developer ID). On macOS, right-click the app and choose **Open** the first time. We expect to deliver signed builds for macOS by Q3 2026.
- The Linux AppImage and `.deb` are unsigned in the manner Linux desktop apps typically are. Verify the SHA-256 from the GitHub release if you need a hash check.

## 5. Authentication and licensing

- Sign-in supports email + password (bcrypt-hashed server-side) or Google OAuth.
- After sign-in we issue a JWT that's stored in your app's local storage and used to authenticate every API call.
- A license is bound to the device that first activates it. You can sign out and sign back in on the same machine — the license doesn't roam to multiple machines on the same plan.
- If you suspect your account is compromised, write to **support@minicaai.com** and we'll force-revoke active sessions.

## 6. How we handle audio

- Audio capture is opt-in per session — you click **MIC** to start.
- The audio stream goes only to **Deepgram** for real-time transcription. We use a paid Deepgram tier where API audio is excluded from training.
- The transcription text is included in the LLM prompt for the active answer call; nothing else from the audio is retained.
- The microphone indicator in the bottom bar shows **LIVE** whenever audio is being captured. If it shows **MIC OFF**, no audio is leaving your machine.

## 7. Reporting a security issue

If you've found a vulnerability, we want to hear about it before it's exploited. Email **security@minicaai.com** with:

- A description of the issue
- Reproduction steps if applicable
- Your contact info so we can credit you

We don't pay bounties yet but we do publicly credit reporters who request it. We do not file DMCA notices against researchers reporting in good faith.

---

This page is the *trust* surface — what to take on faith if you're evaluating whether to install. For the *legal* surface — what data we collect, your rights, retention, processors — see our **[Privacy policy](./PRIVACY.md)**. For pricing and subscription mechanics, see **[Tiers & Billing](./TIERS.md)**.
