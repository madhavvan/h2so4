# Minica AI — Interview Copilot

A real-time interview assistant for senior engineers, data engineers and PMs.

**[minicaai.com](https://minicaai.com)** · Download: **[get.minicaai.com](https://get.minicaai.com)** · Support: **support@minicaai.com**

---

## This is a commercial product

Minica AI is a paid desktop application. This repository holds its source for
the team that builds it — it is **not** an open-source project, not a template,
and not something to stand up yourself.

**No licence is granted** to use, copy, modify, distribute, host or run this
software, in whole or in part. All rights reserved. Access to the source does
not convey a right to use it. If you want the product, buy it — that is what
funds the work.

Reports of a security issue are genuinely welcome at **support@minicaai.com**.

---

## Getting the app

1. Download the installer for your platform from **[get.minicaai.com](https://get.minicaai.com)**.
   Windows builds are signed via Azure Trusted Signing; macOS builds are
   notarized by Apple.
2. Sign up in the app with email or Google.
3. Plans, tiers and current pricing live on **[minicaai.com](https://minicaai.com)** — that page is
   the single source of truth. Nothing here restates them, because a price in a
   README is a price that goes stale.

User-facing help ships with the app (**Help → Documentation**) and is mirrored
in [`docs/public/`](./docs/public/): getting started, features, FAQ,
troubleshooting, privacy, security and tiers.

---

## For the team

Engineering documentation — architecture, the server and its endpoints,
prompts, Auto-Type, the build and release runbook, and operations — is **not in
this repository**. It lives in `docs/private/`, which is gitignored and
distributed out of band. Ask if you need access.

Two things that are easy to get wrong and are written down where they belong:

- **Releases go to two repos.** `package.json` → `build.publish` lists the
  update-feed repo first and the source repo second, and entry [0] is what
  electron-builder bakes into every artifact's `app-update.yml`. Publishing to
  only one of them strands part of the installed fleet. Run
  `npm run release:verify` after any release — it walks the update feed
  anonymously, exactly as a shipped app does, and fails if the feed cannot
  actually serve. A green build with a red feed reaches nobody.
- **Never commit `docs/private/`, `AUDIT-*.md`, `.env*`, or anything under
  `.signing/`.** The first two describe unfixed weaknesses in a running
  product; the last two are credentials.

---

## Trademarks

"Minica", "Minica AI" and the Minica mark are trademarks of the project owner.
Nothing here grants any right to use them.

© Minica AI. All rights reserved.
