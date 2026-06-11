# Troubleshooting

Step-by-step fixes for the issues we hear about most. If your problem isn't here, write to **support@minicaai.com** or click **Talk to a human** in the chat with Minica.

## Contents

1. [The interviewer's voice isn't being heard](#1-the-interviewers-voice-isnt-being-heard)
2. [The pop-out window is missing or off-screen](#2-the-pop-out-window-is-missing-or-off-screen)
3. [Auto-Solve doesn't capture the screen](#3-auto-solve-doesnt-capture-the-screen)
4. [Auto-Type doesn't type anything (Max)](#4-auto-type-doesnt-type-anything-max)
5. [Sign-in failures](#5-sign-in-failures)
6. [My license is stuck on another machine](#6-my-license-is-stuck-on-another-machine)
7. [My subscription doesn't show up](#7-my-subscription-doesnt-show-up)
8. [Auto-update didn't pick up the new version](#8-auto-update-didnt-pick-up-the-new-version)
9. [macOS: Gatekeeper "Cannot be opened" warning](#9-macos-gatekeeper-cannot-be-opened-warning)
10. [Windows: SmartScreen blocks the installer](#10-windows-smartscreen-blocks-the-installer)
11. [Linux: AppImage won't run](#11-linux-appimage-wont-run)
12. [The AI is slow to respond](#12-the-ai-is-slow-to-respond)
13. [Web search isn't working](#13-web-search-isnt-working)
14. [Voice mode is silent](#14-voice-mode-is-silent)
15. [Payment failed but the bank shows the charge](#15-payment-failed-but-the-bank-shows-the-charge)
16. [The app crashes on launch](#16-the-app-crashes-on-launch)
17. [I want to delete my account and data](#17-i-want-to-delete-my-account-and-data)

---

## 1. The interviewer's voice isn't being heard

By far the most common issue. The fix is almost always the **Also share tab audio** checkbox in the screen-share picker.

1. Stop the mic (click **MIC LIVE** to turn it back to **MIC OFF**)
2. Click **MIC OFF** to start again
3. In the browser screen-share popup, pick the right source:
   - For a Chrome-based meeting (Google Meet, Zoom Web), pick the **Chrome Tab**
   - For a desktop Zoom / Teams app, pick the corresponding **Window** or share **Entire Screen**
4. **Check the box "Also share tab audio"** (bottom-left of the Chrome popup) or the equivalent system-audio toggle
5. Click **Share**

The status should switch to **LIVE** in red. If it doesn't, refresh the browser tab and try again.

**On macOS specifically**, you also need OS-level permission. Open **System Settings → Privacy & Security → Screen & System Audio Recording**, toggle **Interview Copilot** on, then **quit and restart the app**. The grant doesn't take effect until restart.

## 2. The pop-out window is missing or off-screen

Click the **External link** icon in the top bar again. The pop-out will re-spawn at the center of your current display. (Sometimes the window state from a previous monitor leaves it positioned where you can't see it — re-opening forces a fresh center position.)

If it still doesn't appear, close the entire app from your system tray ("Quit"), then re-open. The pop-out preferences are reset on next launch.

## 3. Auto-Solve doesn't capture the screen

You need to grant screen-capture permission to the app.

- **macOS** — Open **System Settings → Privacy & Security → Screen & System Audio Recording**, toggle **Interview Copilot** on, then **quit and restart the app**.
- **Windows** — Settings → Privacy → Screenshots → make sure the app is allowed. Restart the app.
- **Linux** — varies by distro; most desktop environments grant screen capture by default once the app requests it.

After granting, test Auto-Solve once with a non-interview screen first to confirm it works.

## 4. Auto-Type doesn't type anything (Max)

Auto-Type uses OS-level accessibility APIs to type into other applications.

- **macOS** — Open **System Settings → Privacy & Security → Accessibility**, toggle **Interview Copilot** on, then **quit and restart the app**. The first Auto-Type click triggers the system prompt automatically; subsequent grants need manual toggle if you've turned it off.
- **Windows** — no extra grant needed; works out of the box. If it's not typing, make sure the target window has focus before clicking Auto-Type.
- **Linux** — Auto-Type uses platform-specific automation; some Wayland-only sessions block synthetic keystrokes. If you're on Wayland and it fails, switch to an X11 session for that interview (most desktops let you pick at the login screen).

## 5. Sign-in failures

If you see "Invalid credentials" or "Your session has expired":

1. Try **Sign out and sign in again** from the account menu in the top-right.
2. If you forgot your password, click **Forgot password** on the sign-in screen. A reset link will be emailed within 5 minutes.
3. If you signed up with Google, make sure you're using the same Google account. The license is bound to the email, not the provider — so switching from email/password to Google with a different email creates a different account.
4. If you used to sign in fine and suddenly can't, check whether your machine's clock is correct. JWT tokens are time-sensitive; a clock that's >5 minutes off causes immediate sign-in failure.

If none of these work, email **support@minicaai.com** with the account email and we'll look at the login logs.

## 6. My license is stuck on another machine

The license is bound to the device that first activates it. To move it:

1. Email **support@minicaai.com** from your account email
2. Include your old device (the one you can't use anymore) and what you want to move to
3. We release the old binding within one business day; you sign in on the new machine after that

If the old machine is no longer accessible (lost, broken, sold), we can release the binding without verification from the old device. Just say so in the email.

## 7. My subscription doesn't show up

After a successful Stripe / Razorpay checkout, the app should detect the new tier within ~30 seconds (or immediately on the next focus event).

If it's still showing your old tier:

1. **Click on the app's window** to trigger a focus event — that re-pings the server and pulls the new tier.
2. **Sign out and sign back in** — refreshes the license from our servers from scratch.
3. **Restart the app** — if neither of the above works.

If you've waited 10 minutes and it's still wrong, email **support@minicaai.com** with your account email and the date/time of the payment. We can refresh the license server-side.

## 8. Auto-update didn't pick up the new version

Updates install on the **next clean launch**, not while the app is running. To force the new version:

1. Right-click the system tray icon → **Quit** (don't just close the window — that hides it, doesn't terminate)
2. Re-open the app from your Start Menu / Applications folder

If the update still doesn't install, download the latest installer directly from the website and run it on top of the existing install. It preserves your conversation history and settings.

## 9. macOS: Gatekeeper "Cannot be opened" warning

The macOS build is currently unsigned (we're in the process of getting an Apple Developer ID; expect signed builds by Q3 2026).

To open the app the first time:

1. Right-click the app in your Applications folder
2. Pick **Open** from the context menu
3. Click **Open** again in the system prompt that appears

After the first launch, subsequent opens don't need this step.

If even the right-click → Open step fails ("malicious software" wording), open **System Settings → Privacy & Security**, scroll to the bottom, and click **Open Anyway** next to the Interview Copilot entry.

## 10. Windows: SmartScreen blocks the installer

The Windows installer is signed by **Azure Trusted Signing** with **Venu Madhav Pentala** as the publisher of record. SmartScreen normally lets it run without warning.

If you see "Windows protected your PC":

1. Click **More info** under the warning
2. Click **Run anyway**

This usually only happens for the very first download on a new machine; after Windows has seen the signature once, the warning doesn't recur.

If you want to verify the signature first, right-click the installer → **Properties** → **Digital Signatures** → you should see Venu Madhav Pentala / Azure Trusted Signing as the signer.

## 11. Linux: AppImage won't run

Make sure the AppImage has execute permission:

```
chmod +x InterviewCopilot-Linux.AppImage
./InterviewCopilot-Linux.AppImage
```

If you see a FUSE error ("AppImages require FUSE to run"), install FUSE:

- Ubuntu / Debian: `sudo apt install libfuse2`
- Fedora: `sudo dnf install fuse-libs`
- Arch / Manjaro: `sudo pacman -S fuse2`

If you prefer not to deal with AppImage, use the `.deb` package instead:

```
sudo dpkg -i InterviewCopilot-Linux.deb
sudo apt --fix-broken install
```

## 12. The AI is slow to respond

The model used + region affects speed. Generally:

- **Groq** is the fastest (small open-weight model, optimized inference)
- **Gemini** is fast (Google's edge POPs)
- **GPT** is medium
- **Grok** is medium
- **Claude** with web search is slowest (multi-step reasoning + search round-trip)

If a specific model is slower than usual for you:

1. Switch to a different model temporarily — the picker is at the top of the chat
2. Check your internet connection (the app needs ~50 KB/s of bandwidth for streaming)
3. Try toggling the reasoning-effort knob (Max) down to **None** — it slows responses significantly

If everything is slow, our provider is likely having a regional outage. Check our status (we'll post on the marketing site banner if there's a known issue) or write to **support@minicaai.com**.

## 13. Web search isn't working

Web search is a **Max-tier feature** specific to **Claude**. It won't fire on other models. Check:

- You're on the Max plan (account menu → **Manage Subscription** shows your tier)
- You've selected **Claude** in the model picker
- Your question is the kind where web search helps — current-state info, recent changes, specific product features. The model decides whether to search; not every Claude call searches.

If you're on Max + Claude + asking a clearly time-sensitive question and don't see "Checking the web…" status, write to **support@minicaai.com**.

## 14. Voice mode is silent

If you've enabled voice mode and aren't hearing anything:

- Voice mode generates spoken answers via TTS. Make sure your system audio output is enabled and the volume is up.
- Check that nothing is muted in your OS volume mixer (Windows Sound Mixer, macOS Audio MIDI Setup).
- Restart the app — TTS audio routing sometimes wedges and a fresh launch resolves it.

## 15. Payment failed but the bank shows the charge

Stripe and Razorpay both issue an **auth hold** on the card before settling. If our system rejected the subscription (license generation failed, region mismatch, etc.), the hold gets released automatically within 3–7 business days; the funds are never actually transferred to us.

You won't see a refund line item — the bank just drops the hold and your available balance recovers. If the hold doesn't clear after 7 business days, email **support@minicaai.com** with the date/time and the last 4 digits of the card. We'll investigate with the provider.

## 16. The app crashes on launch

Open the **opt-in crash reporter** dialog (the app shows it on first launch). Sending us the crash dump is the fastest way to diagnose.

In the meantime, common causes:

- **Old config file** — close the app, delete the app's user-data folder (Windows: `%APPDATA%\interview-copilot-ai`; macOS: `~/Library/Application Support/interview-copilot-ai`; Linux: `~/.config/interview-copilot-ai`), then re-launch. You'll need to sign in again, but settings reset to defaults.
- **Outdated GPU drivers** — Electron uses Chromium, which is sensitive to old GPU drivers. Update yours and retry.
- **macOS Gatekeeper quarantine** — see the Gatekeeper section above.

If the crash persists, email **support@minicaai.com** with your OS version, app version (visible on the **About** screen), and the crash-reporter ID.

## 17. I want to delete my account and data

In the app: **Account menu → Manage Subscription → Delete account** (at the bottom). You'll be asked to confirm.

Or by email: write to **privacy@minicaai.com** from your account email. We respond within 30 days, but typical turnaround is 1 business day.

After deletion, your data is removed from our active systems within 30 days and from backups within 90 days. Payment records are retained for 7 years (legally required for tax) but contain only the transaction amount and the provider's transaction ID — nothing about your card.

---

For quick-answer questions, see **[FAQ](./FAQ.md)**. For feature explanations, see **[Features](./FEATURES.md)**.
