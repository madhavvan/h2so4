// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BOT TOOLS — what Minica can DO (not just answer about)
//
//  Three categories, gated by the caller's resolved session role:
//
//    USER_CLIENT     — executes in the renderer. Server returns an
//                      "emit_to_client" payload; the /chat handler
//                      forwards it as an SSE `tool_call` event. We
//                      synthesize an optimistic ok:true result to the
//                      model so the loop can continue without waiting
//                      for a renderer round-trip. (Theme/font/model
//                      changes are pure setState calls that almost
//                      never fail; the tradeoff documented in
//                      /chat.)
//
//    USER_SERVER     — executes here. Wraps existing /auth/* and
//                      /payments/* routes. Uses the caller's JWT.
//
//    ADMIN_SERVER    — admin-only, executes here. Wraps /admin/*
//                      routes. Non-destructive (reads + low-stakes
//                      writes like profile patches).
//
//    ADMIN_DESTRUCTIVE — admin-only, executes here AFTER a step-up
//                      reauth check. Refund / ban / delete-user /
//                      change-tier / impersonate / config-write etc.
//                      If the caller's JWT lacks a fresh stepUp=true
//                      claim, the handler returns
//                      { ok:false, code:'needs_step_up', intent:{...} }
//                      — the /chat handler converts that into the
//                      SSE `step_up_required` event with the intent
//                      embedded, so the client can run an inline
//                      password prompt and replay the exact tool
//                      call after reauth via /reauth-execute.
//
//  Every tool soft-fails. Throwing is a bug — the bot must never see
//  an unhandled exception from a tool wrapper, because the model
//  then has no structured data to recover from and the user sees a
//  raw "something went wrong". Catch everything and return
//  { ok:false, reason:'...' } so the model can re-phrase.
//
//  Audit: every ADMIN_* tool invocation writes one row to audit_log
//  via writeAudit(). User-tier tools don't audit-log here (the
//  underlying /auth/profile etc. routes already log what they need).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const db = require('../database');
const { writeAudit, ADMIN_EMAILS, STEP_UP_TTL_MS } = require('../middleware/admin');

// Tier → which client-side tools are even usable. Mirrors the gating in
// App.tsx's gate.canUseModel + the Max-only knobs. We pre-check here so
// the bot doesn't emit a tool_call the client would reject — that would
// produce a "Done" message with no visible effect.
const CLIENT_MODELS_BY_TIER = {
  anonymous: ['gemini'],
  // Free = the one-time 10-min trial: four models, no Claude (matches the
  // server tier gate's TRIAL_MODELS). Post-trial the time gate blocks live
  // use anyway — this list only governs which preference can be set.
  free: ['gemini', 'groq', 'openai', 'xai'],
  basic: ['gemini', 'groq', 'openai', 'xai'],
  pro: ['gemini', 'groq', 'openai', 'xai', 'claude'],
  max: ['gemini', 'groq', 'openai', 'xai', 'claude'],
  ultra: ['gemini', 'groq', 'openai', 'xai', 'claude'],
};

const REASONING_EFFORT_VALUES = ['none', 'low', 'medium', 'high'];
const VALID_TIERS = ['free', 'basic', 'pro', 'max', 'ultra'];

// Lazy provider clients — only loaded when an admin actually calls a
// refund / cancel / etc. Mirrors the lazy pattern in routes/admin.js.
let _stripe = null;
let _razorpay = null;
function getStripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
function getRazorpay() {
  if (_razorpay) return _razorpay;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  const Razorpay = require('razorpay');
  _razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  return _razorpay;
}

// Mirrors handleChangeTier defaults in routes/admin.js. Duplicated here
// rather than imported because admin.js doesn't export it — extracting
// is a follow-up refactor.
const DAY_MS = 24 * 60 * 60 * 1000;
// Admin bot grants are UNLIMITED-until-revoked, same as routes/admin.js.
const TIER_LICENSE_DEFAULTS = {
  free:  { expires_at: () => Date.now() + 30 * DAY_MS, sessions_limit: 5 },
  basic: { expires_at: () => -1, sessions_limit: -1 },
  pro:   { expires_at: () => -1, sessions_limit: -1 },
  max:   { expires_at: () => -1, sessions_limit: -1 },
  ultra: { expires_at: () => -1, sessions_limit: -1 },
};

// ─── Step-up gate helper ──────────────────────────────────────────
// Returns null when the caller has a fresh stepUp=true claim, or a
// soft-fail payload the destructive tool should return verbatim.
// We don't throw — the tool wrapper returns this object so the chat
// loop converts it into the SSE step_up_required event.
function checkStepUp(ctx, toolName, args) {
  const u = ctx.user || {};
  if (!u.stepUp || !u.stepUpAt) {
    return {
      ok: false,
      code: 'needs_step_up',
      reason: 'This action needs you to confirm your password first.',
      intent: { tool: toolName, args },
    };
  }
  if (Date.now() - u.stepUpAt > STEP_UP_TTL_MS) {
    return {
      ok: false,
      code: 'needs_step_up',
      reason: 'Your password confirmation has expired. Please reauth.',
      intent: { tool: toolName, args },
    };
  }
  return null;
}

// Audit wrapper that builds a synthetic req-shaped object from ctx so
// writeAudit() works without owning the original Express req.
function botAudit(ctx, action, target, details) {
  const synthReq = {
    user: ctx.user,
    ip: ctx.ip || null,
    get(h) {
      if (h === 'user-agent') return ctx.userAgent || null;
      return null;
    },
  };
  try {
    writeAudit(synthReq, `bot:${action}`, target, details);
  } catch (e) {
    console.error('[botTools] audit failed:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  USER_CLIENT — renderer-executed tools
//
//  Each tool's handler returns:
//    { ok: true,
//      emit_to_client: { action: 'set_theme', args: { theme: 'dark' } },
//      message: 'Theme set to dark.' }
//
//  The chat handler forwards emit_to_client as SSE `tool_call`. The
//  client's onToolCall callback maps `action` → renderer setState.
//  Server-side tier pre-checks live in the handler so we never emit
//  a tool the client would reject.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const USER_CLIENT_TOOLS = [
  {
    name: 'set_theme',
    description: 'Switch the app between light and dark mode. Applied instantly across all surfaces.',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark'], description: 'Target theme.' },
      },
      required: ['theme'],
    },
    handler: async ({ theme }) => ({
      ok: true,
      emit_to_client: { action: 'set_theme', args: { theme } },
      message: `Theme set to ${theme}.`,
    }),
  },
  {
    name: 'set_font_size',
    description: 'Change the chat font size.',
    parameters: {
      type: 'object',
      properties: {
        size: { type: 'string', enum: ['small', 'medium', 'large'] },
      },
      required: ['size'],
    },
    handler: async ({ size }) => ({
      ok: true,
      emit_to_client: { action: 'set_font_size', args: { size } },
      message: `Font size set to ${size}.`,
    }),
  },
  {
    name: 'set_ai_model',
    description:
      'Switch the AI model used for interview answers. Available models depend on the user\'s plan: Free → Gemini only; Basic/Pro → Gemini, Groq, OpenAI, Grok; Max → all of the above + Claude.',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['gemini', 'groq', 'openai', 'xai', 'claude'] },
      },
      required: ['model'],
    },
    handler: async ({ model }, ctx) => {
      const tier = (ctx.tier || 'free').toLowerCase();
      const allowed = CLIENT_MODELS_BY_TIER[tier] || CLIENT_MODELS_BY_TIER.free;
      if (!allowed.includes(model)) {
        return {
          ok: false,
          reason: `${model} is not available on the ${tier} plan. Upgrade to ${model === 'claude' ? 'Max' : 'Basic or higher'} to use it.`,
        };
      }
      return {
        ok: true,
        emit_to_client: { action: 'set_ai_model', args: { model } },
        message: `Active model set to ${model}.`,
      };
    },
  },
  {
    name: 'set_reasoning_effort',
    description:
      'Adjust the GPT reasoning effort knob. Available on the Max plan only. Higher = more thoughtful answers but slower.',
    parameters: {
      type: 'object',
      properties: {
        effort: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
      },
      required: ['effort'],
    },
    handler: async ({ effort }, ctx) => {
      const tier = (ctx.tier || 'free').toLowerCase();
      if (tier !== 'max') {
        return {
          ok: false,
          reason: 'Reasoning effort is a Max-tier feature.',
        };
      }
      if (!REASONING_EFFORT_VALUES.includes(effort)) {
        return { ok: false, reason: `Effort must be one of: ${REASONING_EFFORT_VALUES.join(', ')}.` };
      }
      return {
        ok: true,
        emit_to_client: { action: 'set_reasoning_effort', args: { effort } },
        message: `Reasoning effort set to ${effort}.`,
      };
    },
  },
  {
    name: 'toggle_auto_send',
    description: 'Turn Auto-Send on or off. When on, the AI drafts and sends replies without manual review.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
      },
      required: ['enabled'],
    },
    handler: async ({ enabled }) => ({
      ok: true,
      emit_to_client: { action: 'toggle_auto_send', args: { enabled } },
      message: `Auto-Send ${enabled ? 'enabled' : 'disabled'}.`,
    }),
  },
  {
    name: 'toggle_general_mode',
    description: 'Toggle General Mode. Off = interview-specific answers grounded in the user\'s context. On = general chatbot behavior.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
      },
      required: ['enabled'],
    },
    handler: async ({ enabled }) => ({
      ok: true,
      emit_to_client: { action: 'toggle_general_mode', args: { enabled } },
      message: `General Mode ${enabled ? 'enabled' : 'disabled'}.`,
    }),
  },
  {
    name: 'set_custom_instructions',
    description: 'Replace the user\'s custom-instructions text. Limit ~2000 chars.',
    parameters: {
      type: 'object',
      properties: {
        instructions: { type: 'string', maxLength: 2000 },
      },
      required: ['instructions'],
    },
    handler: async ({ instructions }) => {
      const safe = String(instructions || '').slice(0, 2000);
      return {
        ok: true,
        emit_to_client: { action: 'set_custom_instructions', args: { instructions: safe } },
        message: 'Custom instructions updated.',
      };
    },
  },
  {
    name: 'open_popout_window',
    description: 'Spawn the screen-share-invisible pop-out chat window. No-op if it\'s already open.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({
      ok: true,
      emit_to_client: { action: 'open_popout', args: {} },
      message: 'Pop-out window opened.',
    }),
  },
  {
    name: 'replay_tutorial',
    description: 'Re-run the first-launch tutorial walkthrough.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({
      ok: true,
      emit_to_client: { action: 'replay_tutorial', args: {} },
      message: 'Tutorial restarted.',
    }),
  },
  {
    name: 'sign_out',
    description: 'Sign the user out of the app. They will be returned to the login screen.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({
      ok: true,
      emit_to_client: { action: 'sign_out', args: {} },
      message: 'Signing out.',
    }),
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  USER_SERVER — execute on the server using the caller's JWT.
//
//  These wrap /auth/* and /payments/* routes. Rather than HTTP-loop
//  back to ourselves, we inline the DB / provider logic with the same
//  shape as the route handlers. Comment on each tool ties it to the
//  source route so future maintainers can keep them in sync.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const USER_SERVER_TOOLS = [
  // Mirrors GET /api/v1/payments/subscription.
  {
    name: 'get_my_subscription',
    description: 'Look up the caller\'s subscription — tier, status, renewal date, sessions used, AND the license_key (a public product-key string in MNC-xxxxxxxx-xxxxxxxx format — NOT a credential, safe to display to the user when they ask for it).',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      try {
        const user = db.getUserById(ctx.user.id);
        const license = db.getLicenseByUserId(ctx.user.id);
        if (!user || !license) {
          return { ok: true, status: 'none', tier: 'free', provider: null };
        }
        const customerId = user.stripe_customer_id || '';
        const provider = customerId.startsWith('rzp_')
          ? 'razorpay'
          : customerId.startsWith('cus_') ? 'stripe' : null;
        const isCancelPending = license.status === 'canceling';
        const expiryLabel = license.expires_at === -1
          ? 'never (lifetime)'
          : new Date(license.expires_at).toISOString().slice(0, 10);
        return {
          ok: true,
          status: license.status,
          tier: license.tier,
          provider,
          license_key: license.key,
          expires_at: license.expires_at,
          expires_at_label: expiryLabel,
          sessions_used: license.sessions_used,
          sessions_limit: license.sessions_limit,
          cancel_at_period_end: isCancelPending,
          cancels_at: isCancelPending ? license.expires_at : null,
          message: `Plan: ${license.tier} (${license.status}). License key: ${license.key}. Expires: ${expiryLabel}. Sessions: ${license.sessions_used}/${license.sessions_limit === -1 ? 'unlimited' : license.sessions_limit}.`,
        };
      } catch (e) {
        return { ok: false, reason: `Could not read subscription: ${e.message}` };
      }
    },
  },

  // Mirrors POST /api/v1/payments/portal — opens the Stripe Customer Portal.
  // For Razorpay users, falls back to a structured "no portal available" hint.
  {
    name: 'open_billing_portal',
    description: 'Open the Stripe Customer Portal where the user can update card, view invoices, change plan, cancel. Returns the URL for the client to open.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      try {
        const stripe = getStripe();
        if (!stripe) return { ok: false, reason: 'Billing portal is not configured on this server.' };
        const user = db.getUserById(ctx.user.id);
        let customerId = user?.stripe_customer_id?.startsWith('cus_')
          ? user.stripe_customer_id
          : null;
        if (!customerId) {
          const customers = await stripe.customers.list({ email: ctx.user.email, limit: 1 });
          if (!customers.data.length) {
            return { ok: false, reason: 'No active Stripe subscription on file. If you paid via Razorpay (India), the portal isn\'t available — use the cancel/reactivate tools instead.' };
          }
          customerId = customers.data[0].id;
        }
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: process.env.FRONTEND_URL || 'http://localhost:3005',
        });
        return {
          ok: true,
          portal_url: session.url,
          emit_to_client: { action: 'open_external_url', args: { url: session.url } },
          message: 'Opened the Stripe billing portal in a new tab.',
        };
      } catch (e) {
        return { ok: false, reason: `Could not open the portal: ${e.message}` };
      }
    },
  },

  // Mirrors POST /api/v1/payments/cancel-subscription (the unified route).
  // We don't re-implement Stripe + Razorpay cancellation here; instead we
  // emit_to_client a directive to call the route. This keeps the cancel
  // logic in one place (payments.js) which is non-trivial (period-end
  // computation, gating, license mirror). Trade-off: one extra hop.
  {
    name: 'cancel_subscription',
    description: 'Cancel the user\'s active subscription. Access continues until the end of the current billing period; no immediate refund. Requires explicit user confirmation before running.',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'Must be true. Bot must have explicitly confirmed with the user first.' },
      },
      required: ['confirmed'],
    },
    destructive: true,
    handler: async ({ confirmed }, ctx) => {
      if (!confirmed) {
        return { ok: false, reason: 'Cancellation needs explicit confirmation. Ask the user to confirm.' };
      }
      // Have the renderer call /payments/cancel-subscription with the
      // current JWT. Going through the renderer (not server-direct) keeps
      // the licenseService cache + UI banner refresh in one path.
      return {
        ok: true,
        emit_to_client: {
          action: 'call_authed_endpoint',
          args: {
            method: 'POST',
            path: '/api/v1/payments/cancel-subscription',
            on_success_message: 'Subscription cancelled — you keep access until the end of the current billing period.',
            on_failure_message: 'Couldn\'t cancel — your subscription may have already ended or never been active.',
            refresh_license: true,
          },
        },
        message: 'Cancelling your subscription now.',
      };
    },
  },

  // Mirrors POST /api/v1/payments/reactivate-subscription.
  {
    name: 'reactivate_subscription',
    description: 'Reverse a pending cancellation, restoring auto-renewal on the user\'s Stripe subscription. Only works before the current period ends.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, _ctx) => ({
      ok: true,
      emit_to_client: {
        action: 'call_authed_endpoint',
        args: {
          method: 'POST',
          path: '/api/v1/payments/reactivate-subscription',
          on_success_message: 'Reactivated — your plan will continue to renew normally.',
          on_failure_message: 'Couldn\'t reactivate. The cancellation may have already taken effect, or there\'s no Stripe subscription on file.',
          refresh_license: true,
        },
      },
      message: 'Reactivating your subscription.',
    }),
  },

  // Mirrors PUT /api/v1/auth/profile.
  {
    name: 'update_profile',
    description: 'Update the user\'s display name and/or 2-letter country code.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 100, description: 'New display name (optional).' },
        country_code: { type: 'string', pattern: '^[A-Z]{2}$', description: 'ISO-3166-1 alpha-2, uppercase (optional).' },
      },
    },
    handler: async ({ name, country_code }, ctx) => {
      try {
        const user = db.getUserById(ctx.user.id);
        if (!user) return { ok: false, reason: 'User not found.' };
        const d = db.getDB();
        const updates = [];
        const values = [];
        if (name && name.trim() && name.trim().length <= 100) {
          updates.push('name = ?');
          values.push(name.trim());
        }
        if (country_code && /^[A-Z]{2}$/.test(country_code)) {
          updates.push('country_code = ?');
          values.push(country_code);
        }
        if (!updates.length) return { ok: false, reason: 'Nothing to update. Provide a name or country_code.' };
        updates.push('updated_at = ?');
        values.push(Date.now(), user.id);
        d.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        const updated = db.getUserById(user.id);
        return {
          ok: true,
          user: { id: updated.id, name: updated.name, country_code: updated.country_code },
          emit_to_client: { action: 'refresh_user_profile', args: {} },
          message: 'Profile updated.',
        };
      } catch (e) {
        return { ok: false, reason: `Profile update failed: ${e.message}` };
      }
    },
  },

  // Mirrors PUT /api/v1/auth/password. The bot NEVER asks for the user's
  // password in chat — that's a phishing-style anti-pattern. We surface
  // this as an emit_to_client directive that the renderer translates into
  // the dedicated password-change modal where the input is masked + form
  // semantics signal "this is a credential field" to password managers.
  {
    name: 'change_password',
    description: 'Open the password-change dialog. The user types their old + new password into the dedicated form; the bot never sees either.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, _ctx) => ({
      ok: true,
      emit_to_client: { action: 'open_password_change_dialog', args: {} },
      message: 'Opening the password-change dialog. Type your current and new password there.',
    }),
  },

  // Manage Subscription is a complex flow with plan picker + provider
  // selection. Surface as a render directive instead of in-chat plan UI.
  {
    name: 'open_manage_subscription',
    description: 'Open the Manage Subscription dialog where the user can upgrade, downgrade, or cancel via a guided UI.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({
      ok: true,
      emit_to_client: { action: 'open_manage_subscription', args: {} },
      message: 'Opened the subscription manager.',
    }),
  },

  // ── License details (key, expiry, sessions remaining) ──
  // Distinct from get_my_subscription: this surfaces the license KEY (for
  // copy-paste recovery flows) and the trial / credit balance, which
  // get_my_subscription deliberately omits.
  {
    name: 'get_my_license',
    description: 'Return the CALLER\'S OWN license KEY (MNC-xxxxxxxx-xxxxxxxx format), expiry date, and remaining sessions. PREFER THIS OVER get_my_subscription whenever the user wants the actual license key string, says "what\'s my license key", "show me my key", or "when does my plan expire". get_my_subscription does NOT return the key.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      try {
        const license = db.getLicenseByUserId(ctx.user.id);
        if (!license) return { ok: true, status: 'none', message: 'No license on file yet.' };
        const expiryMs = license.expires_at;
        const expiryLabel = expiryMs === -1
          ? 'never (lifetime)'
          : new Date(expiryMs).toISOString().slice(0, 10);
        const sessionsRemaining = license.sessions_limit === -1
          ? 'unlimited'
          : Math.max(0, (license.sessions_limit || 0) - (license.sessions_used || 0));
        return {
          ok: true,
          license_key: license.key,
          tier: license.tier,
          status: license.status,
          expires_at: expiryMs,
          expires_at_label: expiryLabel,
          sessions_used: license.sessions_used || 0,
          sessions_limit: license.sessions_limit,
          sessions_remaining: sessionsRemaining,
          credits_remaining_seconds: license.credits_remaining_seconds || 0,
        };
      } catch (e) {
        return { ok: false, reason: `Could not read license: ${e.message}` };
      }
    },
  },

  // ── List user's own recent conversations ──
  // Read-only, scoped to ctx.user.id. Returns names + counts only — no
  // message bodies — to keep payloads small and to avoid surprising the
  // user with their old chat content being summarized back at them.
  {
    name: 'view_my_recent_conversations',
    description: 'List the CALLER\'S OWN recent conversations (name, message count, last updated). Returns up to 10. Does NOT return message bodies. PREFER THIS OVER the admin view_recent_conversations whenever the user is asking about THEIR OWN history ("show MY chats", "what did I talk about last week", "list my conversations"). The admin tool is for cross-user audit, this one is scoped to the caller.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many to return. Defaults to 10.' },
      },
    },
    handler: async ({ limit }, ctx) => {
      try {
        const max = Math.max(1, Math.min(20, Number(limit) || 10));
        const rows = db.getConversationsByUser(ctx.user.id) || [];
        const items = rows.slice(0, max).map(r => ({
          id: r.id,
          name: r.name || '(untitled)',
          message_count: r.message_count || 0,
          updated_at_label: r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : null,
        }));
        return { ok: true, count: items.length, conversations: items };
      } catch (e) {
        return { ok: false, reason: `Could not read conversations: ${e.message}` };
      }
    },
  },

  // ── Self-DSAR: email the user a JSON dump of their account data ──
  // Addresses the user complaint that the old bot had no way to send mail.
  // Read-only on data; the only write is the email transport itself.
  // If mail isn't configured (Resend + SMTP both unset), falls back to
  // returning the payload inline so the renderer can offer a JSON download.
  {
    name: 'request_data_export',
    description: 'Email the user a copy of their account data (profile, license, payment history summary, recent conversation list — no message bodies). Free, rate-limited to once per 24h by the email transport. Requires explicit user confirmation.',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'Must be true. Bot must explicitly confirm with the user first.' },
      },
      required: ['confirmed'],
    },
    handler: async ({ confirmed }, ctx) => {
      if (!confirmed) {
        return { ok: false, reason: 'Need user confirmation before sending account-data export.' };
      }
      try {
        const user = db.getUserById(ctx.user.id);
        const license = db.getLicenseByUserId(ctx.user.id);
        const convs = (db.getConversationsByUser(ctx.user.id) || []).slice(0, 50)
          .map(r => ({ id: r.id, name: r.name || null, updated_at: r.updated_at }));
        const payload = {
          generated_at: new Date().toISOString(),
          user: user ? {
            id: user.id, email: user.email, name: user.name,
            tier: user.tier, country_code: user.country_code,
            created_at: user.created_at, last_login_at: user.last_login_at,
            oauth_provider: user.oauth_provider || null,
          } : null,
          license: license ? {
            key: license.key, tier: license.tier, status: license.status,
            expires_at: license.expires_at, sessions_used: license.sessions_used,
            sessions_limit: license.sessions_limit,
          } : null,
          conversation_summaries: convs,
        };
        const { sendMail } = require('../email');
        const subject = 'Your minicaai account data';
        const text = [
          `Hi ${user?.name || 'there'},`, '',
          'Attached is the data we have on file for your account, as of ' + payload.generated_at + '.',
          'Conversation message bodies are excluded by default — reply to this email if you need a full export.',
          '', JSON.stringify(payload, null, 2),
          '', '— minicaai',
        ].join('\n');
        const html = `<pre style="font-family:monospace;font-size:12px;white-space:pre-wrap">${text.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>`;
        let mailResult;
        try {
          mailResult = await sendMail({ to: user.email, subject, html, text });
        } catch (err) {
          mailResult = { ok: false, reason: (err && err.message) || 'sendMail threw' };
        }
        if (mailResult?.ok) {
          return {
            ok: true,
            delivered: true,
            message: `Sent the export to ${user.email}.`,
          };
        }
        // Mail transport not configured / failed → offer the renderer a
        // client-side JSON download instead. This keeps the feature usable
        // in dev without Resend/SMTP and addresses "nothing works including
        // mail" head-on.
        return {
          ok: true,
          delivered: false,
          fallback: 'download',
          emit_to_client: {
            action: 'download_json',
            args: {
              content: JSON.stringify(payload, null, 2),
              filename: `minicaai-account-${(user?.email || 'export').replace(/[^a-z0-9]/gi, '_')}.json`,
            },
          },
          message: `Email isn't configured on this server — I started a JSON download of your data instead.`,
        };
      } catch (e) {
        return { ok: false, reason: `Could not prepare export: ${e.message}` };
      }
    },
  },

  // ── Preview a tier change BEFORE running it ──
  // Returns the diff between current tier and target tier: which
  // features unlock vs which features are lost, sessions limit
  // change, effective date semantics (Stripe = immediate with
  // proration on next invoice; Razorpay = effective at cycle end on
  // downgrade, immediate on upgrade). The bot should ALWAYS call
  // this before invoking cancel_subscription or before suggesting
  // open_manage_subscription so the user knows what they're doing.
  {
    name: 'preview_tier_change',
    description: 'Show the user what they GAIN and what they LOSE by switching from their current tier to a target tier. Use BEFORE any actual cancel/upgrade/downgrade so the user has full impact awareness. Returns: features_gained, features_lost, sessions_change, effective_date_semantics, suggested_alternative (e.g. pause instead of cancel).',
    parameters: {
      type: 'object',
      properties: {
        target_tier: {
          type: 'string',
          enum: ['free', 'basic', 'pro', 'max', 'ultra'],
          description: 'The tier the user is considering switching to.',
        },
      },
      required: ['target_tier'],
    },
    handler: async ({ target_tier }, ctx) => {
      try {
        const license = db.getLicenseByUserId(ctx.user.id);
        if (!license) return { ok: false, reason: 'No license on file.' };
        const currentTier = license.tier || 'free';
        if (currentTier === target_tier) {
          return {
            ok: true,
            current_tier: currentTier,
            target_tier,
            no_change: true,
            message: `You're already on ${currentTier}. Nothing would change.`,
          };
        }

        // Mirror of FEATURE_GATES in services/licenseService.ts (2026-07
        // model: Basic/Pro/Max = one-time passes, Ultra = the monthly
        // unlimited subscription; Claude at Pro+, Train Model + reasoning
        // at Max+, Auto-Type Ultra-only). Kept in sync manually — the bot
        // lives server-side so it can't import the frontend module. If
        // gates drift, update both. `free` here = post-trial free (the
        // state a downgrade actually lands in — the one-time trial can't
        // be re-entered).
        const FEATURES = {
          free:  { time: 'nothing usable after the one-time 10-min trial', models: [],                                autoSolve: false, autoType: false, popout: false, reasoning: false, trainModel: false },
          basic: { time: 'one 30-minute interview',                        models: ['Gemini','GPT','Grok','Groq'],    autoSolve: true,  autoType: false, popout: true,  reasoning: false, trainModel: false },
          pro:   { time: 'one 1-hour interview',                           models: ['Gemini','GPT','Grok','Groq','Claude'], autoSolve: true, autoType: false, popout: true, reasoning: false, trainModel: false },
          max:   { time: 'three 1-hour interviews',                        models: ['Gemini','GPT','Grok','Groq','Claude'], autoSolve: true, autoType: false, popout: true, reasoning: true,  trainModel: true },
          ultra: { time: 'unlimited interviews',                           models: ['Gemini','GPT','Grok','Groq','Claude'], autoSolve: true, autoType: true,  popout: true, reasoning: true,  trainModel: true },
        };
        const cur = FEATURES[currentTier] || FEATURES.free;
        const tgt = FEATURES[target_tier] || FEATURES.free;
        const gained = [];
        const lost = [];
        if (tgt.time !== cur.time) gained.push(`interview time: ${tgt.time} (currently ${cur.time})`);
        for (const m of tgt.models) if (!cur.models.includes(m)) gained.push(`${m} model access`);
        for (const m of cur.models) if (!tgt.models.includes(m)) lost.push(`${m} model access`);
        if (tgt.autoType && !cur.autoType) gained.push('Auto-Type (typing into the editor for you)');
        if (cur.autoType && !tgt.autoType) lost.push('Auto-Type');
        if (tgt.autoSolve && !cur.autoSolve) gained.push('Auto-Solve (screen-capture problem solving)');
        if (cur.autoSolve && !tgt.autoSolve) lost.push('Auto-Solve');
        if (tgt.popout && !cur.popout) gained.push('Pop-out (screen-share-invisible window)');
        if (cur.popout && !tgt.popout) lost.push('Pop-out');
        if (tgt.trainModel && !cur.trainModel) gained.push('Train Model (résumé + role pre-research)');
        if (cur.trainModel && !tgt.trainModel) lost.push('Train Model');
        if (tgt.reasoning && !cur.reasoning) gained.push('Reasoning effort control');
        if (cur.reasoning && !tgt.reasoning) lost.push('Reasoning effort control');

        const tierRank = { free: 0, basic: 1, pro: 2, max: 3, ultra: 4 };
        const isDowngrade = tierRank[target_tier] < tierRank[currentTier];
        const isUpgrade = tierRank[target_tier] > tierRank[currentTier];

        // Provider detection. stripe_customer_id starts with 'cus_'.
        // razorpay's stored on user.razorpay_subscription_id (or via
        // license events). We detect Stripe primary, Razorpay fallback.
        const user = db.getUserById(ctx.user.id);
        const isStripe = user?.stripe_customer_id && String(user.stripe_customer_id).startsWith('cus_');
        const isRazorpay = !!user?.razorpay_subscription_id;
        const provider = isStripe ? 'stripe' : (isRazorpay ? 'razorpay' : 'none');

        // Effective-date semantics under the 2026-07 model: Basic/Pro/Max
        // are ONE-TIME passes (a "switch" between them is a fresh pass
        // purchase charged today — the new pass's clock replaces what's
        // left of the old one); Ultra is the only subscription (cancel =
        // access until cycle end, then Free).
        const cycleEnd = license.expires_at && license.expires_at > 0
          ? new Date(license.expires_at).toISOString().slice(0, 10)
          : 'the end of your current cycle';
        let effective;
        if (target_tier === 'ultra') {
          effective = 'immediate after checkout — Ultra is the monthly subscription, billed from today';
        } else if (target_tier === 'free') {
          effective = currentTier === 'ultra'
            ? `cancel any time — you keep Ultra access until ${cycleEnd}, then drop to Free`
            : 'your pass simply expires on its own — there is nothing to cancel and no ongoing billing';
        } else if (currentTier === 'ultra') {
          effective = `passes are one-time purchases — cancel Ultra first (access until ${cycleEnd}), then buy the ${target_tier} pass whenever the next interview comes up`;
        } else {
          effective = `immediate after checkout — a fresh ${target_tier} pass is charged today and its full interview clock replaces whatever remains on your current pass`;
        }

        let suggested_alternative = null;
        if (target_tier === 'free' && currentTier === 'ultra') {
          suggested_alternative = isStripe
            ? 'If cost is the concern, you could pause the subscription from the Stripe billing portal instead of canceling — or switch to one-time passes (Basic $30 / Pro $50 / Max $89) after the cycle ends and pay only when an interview comes up.'
            : 'After your cycle ends you can use one-time passes (Basic / Pro / Max) instead — pay only when an interview comes up, no monthly bill.';
        } else if (isDowngrade && currentTier !== 'ultra' && target_tier !== 'free') {
          suggested_alternative = 'Heads up: buying a smaller pass replaces the time left on your current one. If you just need more minutes on the pass you already have, the +30 min / +1 h / +3 h extensions are usually the better deal.';
        }

        return {
          ok: true,
          current_tier: currentTier,
          target_tier,
          direction: isUpgrade ? 'upgrade' : isDowngrade ? 'downgrade' : 'lateral',
          features_gained: gained,
          features_lost: lost,
          provider,
          effective_date_semantics: effective,
          suggested_alternative,
          message: gained.length || lost.length
            ? `Switching from ${currentTier} → ${target_tier}: ${gained.length ? 'gains ' + gained.join(', ') : 'no gains'}${gained.length && lost.length ? '; ' : ''}${lost.length ? 'loses ' + lost.join(', ') : ''}. ${effective}.`
            : `${currentTier} and ${target_tier} have the same features for your usage. No functional change.`,
        };
      } catch (e) {
        return { ok: false, reason: `Could not preview tier change: ${e.message}` };
      }
    },
  },

  // ── Request a refund on the caller's most recent paid invoice ──
  // User-initiated refunds work like every enterprise billing portal
  // (Notion, Linear, Vercel): if the PUBLISHED policy allows it
  // (REFUND_POLICY.md — 14 days from charge + under 2 hours of session
  // time; extension top-ups never refundable), auto-process via the
  // original provider (Stripe / Razorpay refunds API). Otherwise file
  // an admin-review row in audit_log and respond "we'll get back to
  // you" — admin sees it in the bot's get_audit_log output and can
  // manually refund_payment from there.
  //
  // ⚠️ computeRefundEligibility is the ONLY gate for the auto-refund. An
  // earlier version ran its own 7-day age check and IGNORED the
  // eligibility result it computed — auto-refunding heavy users and even
  // non-refundable top-ups, while queuing day-8–14 requests the policy
  // says are automatic.
  //
  // This complements the admin-side refund_payment tool: that's for
  // admin acting on behalf of others; this is users acting on their
  // own bill.
  {
    name: 'request_refund',
    description: 'File a refund request for the caller\'s most recent paid invoice. Auto-approves when the published refund policy allows it (14 days from charge + under 2 hours of use; top-ups are never auto-refunded) — returns refund_processed=true. Otherwise queues an admin review (returns queued=true). The caller does not need to specify which payment — we always target the most recent.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the user wants the refund. Required.', maxLength: 500 },
        confirmed: { type: 'boolean', description: 'Must be true. Bot must confirm with the user first.' },
      },
      required: ['reason', 'confirmed'],
    },
    handler: async ({ reason, confirmed }, ctx) => {
      if (!confirmed) {
        return { ok: false, reason: 'Need user confirmation before filing a refund request. Ask them to confirm.' };
      }
      const reasonText = String(reason || '').trim().slice(0, 500);
      if (!reasonText) {
        return { ok: false, reason: 'A reason is required for refund requests. Ask the user why they want it.' };
      }
      try {
        const payments = db.getPaymentsByUser(ctx.user.id);
        const lastPaid = (payments || []).find(p => p.status === 'completed' && p.amount > 0);
        if (!lastPaid) {
          return {
            ok: false,
            reason: 'No completed paid charges on file to refund.',
            suggestion: 'If you think this is wrong, use open_handoff_form to contact the team — they can look up your account directly.',
          };
        }
        const ageMs = Date.now() - (lastPaid.created_at || 0);

        // THE published-policy engine is the single gate for auto-refunds
        // (same service the admin endpoint enforces): 14 days + <2 h of
        // session time, top-ups never refundable. Pass the precise usage
        // meter so the decision matches what the policy actually promises.
        const { computeRefundEligibility } = require('./refundEligibility');
        const license = db.getLicenseByUserId(ctx.user.id);
        let usageStats;
        try {
          const totals = db.getUsageTotals(ctx.user.id);
          usageStats = {
            totalSessionSeconds: totals.lifetime_used_seconds,
            sessionsUsed: license?.sessions_used,
          };
        } catch { /* stats unavailable — the service falls back to its proxy */ }
        const eligibility = computeRefundEligibility(lastPaid, license, usageStats);
        const withinPolicy = !!eligibility?.eligible;

        // Always log to audit so admin has a paper trail. Distinguishes
        // auto-processed vs queued by the action name.
        botAudit(ctx, withinPolicy ? 'user-refund-auto' : 'user-refund-queued', ctx.user, {
          payment_id: lastPaid.id,
          amount: lastPaid.amount,
          currency: lastPaid.currency,
          age_days: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
          eligibility_code: eligibility?.code || null,
          reason: reasonText,
        });

        if (!withinPolicy) {
          // Outside the published policy → queue for admin review. We
          // don't reject — refund policies have soft edges that humans
          // handle case-by-case (genuinely unhappy customer, billing
          // error, etc.). Admin sees this in the audit log and can
          // refund_payment manually (with override_reason).
          return {
            ok: true,
            queued: true,
            payment_age_days: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
            policy_window_days: 14,
            policy_reason: eligibility?.reason || null,
            message: 'Refund request filed. It falls outside the automatic window (14 days from charge with under 2 hours of use; top-ups aren\'t auto-refunded), so a human will review and respond within 24 hours.',
          };
        }

        // Within policy → process refund through the provider. Reuses
        // the same path the admin refund_payment tool uses for
        // consistency.

        let providerRefundId = null;
        try {
          if (lastPaid.provider === 'stripe') {
            const stripe = getStripe();
            if (!stripe) return { ok: false, reason: 'Stripe is not configured on this server. Filing the request for admin review instead.' };
            const refund = await stripe.refunds.create({
              payment_intent: lastPaid.provider_payment_id?.startsWith('pi_') ? lastPaid.provider_payment_id : undefined,
              charge: lastPaid.provider_payment_id?.startsWith('ch_') ? lastPaid.provider_payment_id : undefined,
              reason: 'requested_by_customer',
              metadata: { initiated_by: 'user-bot', user_reason: reasonText },
            });
            providerRefundId = refund.id;
          } else if (lastPaid.provider === 'razorpay') {
            const razorpay = getRazorpay();
            if (!razorpay) return { ok: false, reason: 'Razorpay is not configured on this server. Filing the request for admin review instead.' };
            const refund = await razorpay.payments.refund(lastPaid.provider_payment_id, {
              notes: { initiated_by: 'user-bot', user_reason: reasonText },
            });
            providerRefundId = refund.id;
          } else {
            return { ok: false, reason: `Can't auto-refund payments from provider=${lastPaid.provider}. Queued for admin review.` };
          }
        } catch (providerErr) {
          // Provider call failed (transient API outage, dispute already open, etc.).
          // Queue for admin review so the user isn't stranded.
          botAudit(ctx, 'user-refund-provider-failed', ctx.user, {
            payment_id: lastPaid.id,
            provider: lastPaid.provider,
            err: providerErr.message,
          });
          return {
            ok: true,
            queued: true,
            provider_error: providerErr.message,
            message: 'Refund couldn\'t be processed automatically — provider returned an error. We\'ve filed it for admin review and someone will follow up within 24 hours.',
          };
        }

        // Record the refund row.
        db.recordAdminRefund({
          originalPayment: lastPaid,
          refundId: providerRefundId,
          amount: lastPaid.amount,
          reason: reasonText,
          initiatedBy: `user-bot:${ctx.user.email}`,
        });

        return {
          ok: true,
          refund_processed: true,
          provider: lastPaid.provider,
          provider_refund_id: providerRefundId,
          amount_refunded: lastPaid.amount,
          currency: lastPaid.currency,
          eligibility_eligible: eligibility?.eligible,
          message: `Refund of ${lastPaid.amount} ${lastPaid.currency} processed through ${lastPaid.provider}. It usually clears within 5-10 business days.`,
        };
      } catch (e) {
        return { ok: false, reason: `Refund processing failed: ${e.message}` };
      }
    },
  },

  // ── Recommend the best plan for the user's usage pattern ──
  // Looks at sessions_used + recency to suggest a plan that fits.
  // Light "decision-support" tool — bot can call this when the user
  // asks "which plan should I get?" or "am I on the right plan?".
  {
    name: 'recommend_plan',
    description: 'Recommend a plan tier based on the caller\'s actual usage history. Returns: current_tier, recommended_tier, reasoning. Use when the user asks "which plan is right for me?" or "should I upgrade/downgrade?". No mutations — pure read-and-think.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      try {
        const license = db.getLicenseByUserId(ctx.user.id);
        const user = db.getUserById(ctx.user.id);
        if (!license || !user) return { ok: false, reason: 'No account on file.' };

        const sessionsUsed = license.sessions_used || 0;
        const sessionsLimit = license.sessions_limit;
        const currentTier = license.tier || 'free';

        // Recent payments → an indicator of how long they've been paying.
        const payments = db.getPaymentsByUser(ctx.user.id) || [];
        const paidCount = payments.filter(p => p.status === 'completed' && p.amount > 0).length;

        let recommended;
        let reasoning;

        if (currentTier === 'free') {
          if (sessionsUsed >= 4) {
            recommended = 'basic';
            reasoning = `You've used ${sessionsUsed}/5 sessions this month — you'll hit the limit soon. Basic ($25 one-time, 3 sessions over 14 days) is a low-commitment way to try the paid features without a recurring charge.`;
          } else {
            recommended = 'basic';
            reasoning = `You're on Free with ${sessionsUsed} sessions used. If you want unlimited time, premium models, and Auto-Solve, Basic is the easiest first step ($25 one-time, no auto-renewal).`;
          }
        } else if (currentTier === 'basic') {
          if (sessionsUsed >= 3) {
            recommended = 'pro';
            reasoning = `You've used all 3 Basic sessions. If you have more interviews coming up, Pro ($29/mo) unlocks unlimited sessions + all premium models except Claude.`;
          } else {
            recommended = 'basic';
            reasoning = `You still have ${sessionsLimit - sessionsUsed} Basic sessions left. Stay on Basic unless you know you'll need more sessions or Auto-Type.`;
          }
        } else if (currentTier === 'pro') {
          // Pro user → recommend Max only if they would benefit from Claude or Auto-Type.
          // We can't read their actual interview behavior so we play conservative.
          recommended = paidCount >= 3 ? 'max' : 'pro';
          reasoning = paidCount >= 3
            ? `You\'ve been on Pro for ${paidCount} cycles. If your interviews are coding-heavy or you want Claude (more thoughtful on system design) + Auto-Type, Max is worth the bump to $69/mo.`
            : `Pro covers most interview use cases well. Stay here unless you specifically want Claude (system design / hard problems) or Auto-Type (Max-only).`;
        } else {
          recommended = 'max';
          reasoning = `You're already on Max — the top tier. Stay here as long as you're actively interviewing.`;
        }

        return {
          ok: true,
          current_tier: currentTier,
          recommended_tier: recommended,
          sessions_used: sessionsUsed,
          sessions_limit: sessionsLimit,
          paid_history_count: paidCount,
          reasoning,
          no_change_needed: currentTier === recommended,
        };
      } catch (e) {
        return { ok: false, reason: `Recommendation failed: ${e.message}` };
      }
    },
  },

  // ── Submit a bug report ─────────────────────────────────────
  // Lightweight bug-report channel. Routes to the same handoff
  // destination as the existing "Talk to a human" form (Slack +
  // email) but tagged as a bug so support can triage faster. Logs
  // to audit_log too.
  {
    name: 'report_bug',
    description: 'File a bug report. Use when the user describes a malfunction, error, or unexpected behavior. Captures their description, the app version, and a snapshot of their session state for the dev team to triage. The user does not need to know technical details — they describe what went wrong in plain language.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'The user\'s description of the bug, in their own words.', maxLength: 1500 },
        confirmed: { type: 'boolean', description: 'Must be true. Bot confirms with the user before filing.' },
      },
      required: ['description', 'confirmed'],
    },
    handler: async ({ description, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm with the user before filing a bug report.' };
      const text = String(description || '').trim().slice(0, 1500);
      if (!text) return { ok: false, reason: 'A description is required for bug reports.' };
      try {
        const user = db.getUserById(ctx.user.id);
        const license = db.getLicenseByUserId(ctx.user.id);
        botAudit(ctx, 'user-bug-report', ctx.user, {
          description: text,
          tier: license?.tier || 'free',
          status: license?.status || null,
        });
        // Best-effort Slack/email notification (uses the support
        // handoff destinations already configured for /handoff). If
        // neither is configured, the audit row is the only record.
        try {
          const slackWebhook = process.env.SUPPORT_SLACK_WEBHOOK_URL;
          if (slackWebhook) {
            const payload = {
              text: `🐛 *Bug report* from ${user?.email || ctx.user.email}`,
              attachments: [{
                color: '#f59e0b',
                fields: [
                  { title: 'Tier', value: license?.tier || 'free', short: true },
                  { title: 'Description', value: text, short: false },
                ],
              }],
            };
            // Don't await — fire-and-forget. We don't want a Slack
            // outage to fail the bot tool.
            fetch(slackWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }).catch(() => { /* slack down */ });
          }
        } catch { /* fetch missing in older node */ }
        return {
          ok: true,
          message: 'Bug report filed. Someone from the dev team will follow up within 24 hours if we need more details.',
          report_id: `bug-${Date.now()}-${ctx.user.id?.slice(0, 8) || 'anon'}`,
        };
      } catch (e) {
        return { ok: false, reason: `Could not file bug report: ${e.message}` };
      }
    },
  },

  // ── DSAR-delete: user self-initiates account deletion ──
  // The admin-side dsar_export tool returns the user's data; this is
  // the user-side delete. Privacy-law-compliant: the user owns their
  // data and can remove it without contacting support. Two-step
  // confirmation because deletion is irreversible.
  {
    name: 'delete_my_account',
    description: 'PERMANENTLY delete the caller\'s account, license, devices, and conversation history (payment records are retained for financial-compliance bookkeeping, as the privacy policy states). Required by privacy law (GDPR Article 17 / CCPA right to delete) — every user must be able to self-serve this. Irreversible. Requires explicit user confirmation with the literal string "I understand this is permanent" passed as confirmation_phrase.',
    parameters: {
      type: 'object',
      properties: {
        confirmation_phrase: { type: 'string', description: 'Must be the literal string "I understand this is permanent". Anything else rejects.' },
      },
      required: ['confirmation_phrase'],
    },
    destructive: true,
    handler: async ({ confirmation_phrase }, ctx) => {
      const PHRASE = 'I understand this is permanent';
      if (String(confirmation_phrase || '').trim() !== PHRASE) {
        return {
          ok: false,
          reason: `Account deletion requires the user to type exactly: "${PHRASE}". They typed something else.`,
          required_phrase: PHRASE,
        };
      }
      try {
        const user = db.getUserById(ctx.user.id);
        if (!user) return { ok: false, reason: 'User not found.' };
        botAudit(ctx, 'user-delete-account', ctx.user, {
          tier_at_delete: db.getLicenseByUserId(ctx.user.id)?.tier || 'free',
          email: user.email,
        });
        db.deleteUser(ctx.user.id);
        return {
          ok: true,
          deleted: true,
          emit_to_client: { action: 'sign_out', args: {} },
          message: 'Your account, license, conversations, and payment history have been permanently deleted. You\'ve been signed out. Goodbye 👋',
        };
      } catch (e) {
        return { ok: false, reason: `Could not delete account: ${e.message}` };
      }
    },
  },

  // ── Talk-to-human form: bot-voice equivalent of the footer link ──
  // Useful when the user explicitly asks "I want to talk to a person" /
  // "open a support ticket". The renderer surfaces the existing handoff
  // form (Slack/email notification under the hood).
  {
    name: 'open_handoff_form',
    description: 'Open the "Talk to a human" form inside the bot panel. Use when the user says "talk to a human", "open a support ticket", "I need a person", "contact support", or when a task is beyond what the bot can do. The form pre-fills with their last question and emails/Slacks the support team.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({
      ok: true,
      emit_to_client: { action: 'open_handoff_form', args: {} },
      message: 'Opened the handoff form.',
    }),
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN_SERVER — admin reads + low-stakes writes.
//
//  Mirrors routes/admin.js endpoints that do NOT require stepUpOnly.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ADMIN_SERVER_TOOLS = [
  {
    name: 'get_admin_stats',
    description: 'Top-line counts: users, paying users, MRR, active sessions, etc.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      try {
        const stats = db.getStats();
        botAudit(ctx, 'view-stats', null);
        return { ok: true, stats };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_admin_trends',
    description: 'Daily time-series for analytics. `days` defaults to 30, clamped to 180.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 180, default: 30 },
      },
    },
    handler: async ({ days = 30 }, _ctx) => {
      try {
        const n = Math.max(1, Math.min(180, days|0));
        return { ok: true, trends: db.getTrends(n) };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_top_customers',
    description: 'Top revenue paying users. `limit` defaults to 10, clamped to 100.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
    },
    handler: async ({ limit = 10 }, _ctx) => {
      try {
        return { ok: true, customers: db.getTopCustomers(Math.max(1, Math.min(100, limit|0))) };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_suspicious_activity',
    description: 'Surface multi-country usage and brute-force candidates.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, _ctx) => {
      try {
        return { ok: true, activity: db.getSuspiciousActivity() };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'search_user',
    description: 'ADMIN-ONLY user lookup for OTHER users by their exact email. Returns the target user + their license + devices + recent payments + conversation summaries. DO NOT use this on the caller themselves — if the admin asks about THEIR OWN account, use get_my_subscription or get_my_license instead. The email parameter is REQUIRED — never call this with empty args.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string', description: 'Target user\'s email address. Required.' } },
      required: ['email'],
    },
    handler: async ({ email }, ctx) => {
      // Self-action guardrail: the smaller nano model often calls
      // search_user with no args, or with the caller's own email,
      // when the user asked about themselves. Redirect to the
      // appropriate caller-scoped tool.
      if (!email) {
        return {
          ok: false,
          reason: 'search_user needs an email. If you\'re asking about YOUR OWN account, call get_my_subscription or get_my_license instead — those are caller-scoped and need no arguments.',
          suggested_tool: 'get_my_subscription',
        };
      }
      const callerEmail = String(ctx?.user?.email || '').toLowerCase();
      if (callerEmail && callerEmail === String(email).toLowerCase()) {
        return {
          ok: false,
          reason: 'For your own account, use get_my_subscription (status + license) or get_my_license (license key). search_user is reserved for admin lookups on OTHER users.',
          suggested_tool: 'get_my_subscription',
        };
      }
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const license = db.getLicenseByUserId(user.id);
        const devices = db.getUserDevices(user.id);
        const payments = db.getPaymentsByUser(user.id);
        const conversations = db.getConversationsByUser(user.id).map(c => ({
          id: c.id, name: c.name, created_at: c.created_at, updated_at: c.updated_at,
        }));
        botAudit(ctx, 'search-user', user);
        return {
          ok: true,
          user: serializeUserForBot(user),
          license, devices, payments, conversations,
        };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'view_recent_conversations',
    description: 'Latest N conversations across every user. Powers the admin Conversations tab.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        q: { type: 'string', description: 'Optional search query.' },
      },
    },
    handler: async ({ limit = 50, q = null }, ctx) => {
      try {
        const n = Math.max(1, Math.min(500, limit|0));
        const trimmedQ = (typeof q === 'string' && q.trim()) ? q.trim() : null;
        const rows = db.getRecentConversationsAcrossUsers({ limit: n, q: trimmedQ });
        botAudit(ctx, 'view-recent-conversations', null, { limit: n, q: trimmedQ, count: rows.length });
        return { ok: true, conversations: rows };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_recent_logins',
    description: 'Most recent N login attempts (success + failure) for fraud / brute-force triage.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    },
    handler: async ({ limit = 50 }, _ctx) => {
      try {
        return { ok: true, logins: db.getRecentLogins(Math.min(200, limit|0)) };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_revoked_keys',
    description: 'List currently-revoked license keys with reason + when revoked.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, _ctx) => {
      try { return { ok: true, keys: db.getRevokedKeys() }; }
      catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_payments',
    description: 'Filtered payments list. All filters optional.',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['stripe', 'razorpay', 'admin-comp'] },
        status: { type: 'string' },
        email: { type: 'string' },
        tier: { type: 'string' },
        from: { type: 'integer', description: 'Unix ms.' },
        to: { type: 'integer', description: 'Unix ms.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
    },
    handler: async (args, _ctx) => {
      try {
        const filters = {
          provider: args.provider || null,
          status: args.status || null,
          email: args.email || null,
          tier: args.tier || null,
          from: args.from || null,
          to: args.to || null,
          limit: Math.min(1000, args.limit|0 || 100),
        };
        return { ok: true, ...db.queryPayments(filters) };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_audit_log',
    description: 'Filtered admin audit log. All filters optional. Use to investigate "who did what when".',
    parameters: {
      type: 'object',
      properties: {
        admin: { type: 'string' },
        action: { type: 'string' },
        target: { type: 'string' },
        from: { type: 'integer' },
        to: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      },
    },
    handler: async (args, _ctx) => {
      try {
        const filters = {
          admin: args.admin || null,
          action: args.action || null,
          target: args.target || null,
          from: args.from || null,
          to: args.to || null,
          limit: Math.min(2000, args.limit|0 || 200),
        };
        return { ok: true, log: db.queryAuditLog(filters) };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_audit_facets',
    description: 'Distinct admins and action names in the audit log — useful to scope the next get_audit_log call.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, _ctx) => {
      try {
        return { ok: true, actions: db.getAuditActions(), admins: db.getAuditAdmins() };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  {
    name: 'get_app_config',
    description: 'Read all runtime config knobs (min_app_version, device limits, etc.).',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, _ctx) => {
      try {
        const rows = db.getDB()
          .prepare('SELECT key, value, updated_at FROM app_config ORDER BY key').all();
        return { ok: true, config: rows };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  // Send-password-reset is not destructive — it just emails the user a
  // link; admin.js does not gate it with stepUpOnly. Keeping that policy.
  {
    name: 'send_password_reset',
    description: 'Issue a password-reset token for the named user and email them the link.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email'],
    },
    handler: async ({ email }, ctx) => {
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        if (!user.email) return { ok: false, reason: 'User has no email on file.' };
        const rawToken = db.createPasswordResetToken(user.id, user.email);
        const serverUrl = process.env.SERVER_URL || 'https://api.minicaai.com';
        const resetUrl = `${serverUrl}/api/v1/auth/reset-password?token=${rawToken}`;
        const { sendMail, renderPasswordResetEmail } = require('../email');
        const { subject, html, text } = renderPasswordResetEmail({ name: user.name, resetUrl });
        let mailResult;
        try {
          mailResult = await sendMail({ to: user.email, subject, html, text });
        } catch (err) {
          mailResult = { ok: false, reason: (err && err.message) || 'sendMail threw' };
        }
        botAudit(ctx, 'send-password-reset', user, {
          mail_ok: !!mailResult?.ok, mail_reason: mailResult?.reason || null,
        });
        return {
          ok: true,
          delivered: !!mailResult?.ok,
          message: mailResult?.ok
            ? `Sent password-reset email to ${user.email}.`
            : `Reset token generated but EMAIL FAILED (${mailResult?.reason || 'unknown'}). The URL is ${resetUrl} — copy manually if needed.`,
        };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
  // Revoke a single device — admin.js does NOT step-up gate this.
  {
    name: 'revoke_user_device',
    description: 'Revoke a single device binding for a user (e.g. lost/stolen laptop). Less destructive than reset_user_devices, no step-up needed. Identify the user by EMAIL (users table uses UUIDs, not integer ids — never call this with a numeric user_id).',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Target user\'s email.' },
        device_row_id: { type: 'integer', description: 'Row id of the device to revoke (from search_user output\'s devices array).' },
      },
      required: ['email', 'device_row_id'],
    },
    handler: async ({ email, device_row_id }, ctx) => {
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const changed = db.revokeSingleDevice(device_row_id|0, user.id);
        if (!changed) return { ok: false, reason: 'Device not found for this user.' };
        botAudit(ctx, 'revoke-device', user, { device_row_id });
        return { ok: true, message: `Revoked device ${device_row_id} for ${user.email}.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN_DESTRUCTIVE — step-up gated. Refund / ban / delete / etc.
//
//  Each handler:
//    1. checkStepUp() — return {needs_step_up, intent} if not gated.
//    2. Verifies the destructive arg `confirmed: true` (model is
//       prompted to always confirm). Belt-and-suspenders against a
//       hallucinated batch operation.
//    3. Audit-logs.
//    4. Soft-fails on anything else.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ADMIN_DESTRUCTIVE_TOOLS = [
  // Mirrors routes/admin.js handleChangeTier.
  {
    name: 'change_user_tier',
    description: 'ADMIN-ONLY: Move ANOTHER user (not yourself) to a specified plan (free/basic/pro/max). Updates that user\'s license + tier in one transaction. DO NOT use this for the caller\'s own subscription — for that, use open_manage_subscription which opens the upgrade/downgrade UI. Required args: email (the target user\'s email, NOT optional), tier (target plan), confirmed (true after explicit user yes). Calling with empty args is always wrong.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        tier: { type: 'string', enum: ['free', 'basic', 'pro', 'max'] },
        confirmed: { type: 'boolean' },
      },
      required: ['email', 'tier', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, tier, confirmed }, ctx) => {
      // Self-action guardrail: the model (especially smaller nano variants)
      // keeps grabbing change_user_tier when the admin asks about their
      // own plan. Redirect to the proper UI flow instead of running an
      // admin tier-mutation against the caller's own account.
      if (!email || !tier) {
        return {
          ok: false,
          reason: 'change_user_tier needs email + tier + confirmed. If you meant to change YOUR OWN plan, use open_manage_subscription — that opens the upgrade/downgrade UI for the caller. change_user_tier is for admins acting on OTHER users.',
          suggested_tool: 'open_manage_subscription',
        };
      }
      const callerEmail = String(ctx?.user?.email || '').toLowerCase();
      if (callerEmail && callerEmail === String(email).toLowerCase()) {
        return {
          ok: false,
          reason: 'For your own subscription, use open_manage_subscription — it opens the guided upgrade/downgrade modal. change_user_tier is reserved for admin actions on OTHER users.',
          suggested_tool: 'open_manage_subscription',
        };
      }
      if (!confirmed) return { ok: false, reason: 'Confirm the tier change with the admin first.' };
      const gate = checkStepUp(ctx, 'change_user_tier', { email, tier, confirmed });
      if (gate) return gate;
      try {
        if (!VALID_TIERS.includes(tier)) return { ok: false, reason: `Invalid tier ${tier}.` };
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const previousTier = user.tier;
        const defaults = TIER_LICENSE_DEFAULTS[tier];
        db.updateUserTier(user.id, tier);
        db.updateLicenseOnPayment(user.id, {
          tier, status: 'active',
          expires_at: defaults.expires_at(), sessions_limit: defaults.sessions_limit,
        });
        botAudit(ctx, 'change-tier', user, { from: previousTier, to: tier });
        return { ok: true, message: `${email} moved from ${previousTier} to ${tier}.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/grant-credits.
  {
    name: 'grant_credits',
    description: 'Adjust a user\'s session/credit balance. Positive grants, negative revokes.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        credits: { type: 'integer', description: 'Non-zero, may be negative.' },
        confirmed: { type: 'boolean' },
      },
      required: ['email', 'credits', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, credits, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm credit adjustment first.' };
      const gate = checkStepUp(ctx, 'grant_credits', { email, credits, confirmed });
      if (gate) return gate;
      try {
        const n = Number(credits);
        if (!Number.isFinite(n) || n === 0) return { ok: false, reason: 'Credits must be non-zero.' };
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const updated = db.grantCreditSessions(user.id, n);
        if (!updated) return { ok: false, reason: 'User has no license.' };
        botAudit(ctx, 'grant-credits', user, { credits: n, new_limit: updated.sessions_limit });
        return {
          ok: true,
          message: `${n > 0 ? 'Granted' : 'Revoked'} ${Math.abs(n)} credit(s) for ${email}. New limit: ${updated.sessions_limit}.`,
        };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/extend-expiry.
  {
    name: 'extend_user_expiry',
    description: 'Add or subtract days from a user\'s license expiry. Positive extends, negative cuts.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        days: { type: 'integer' },
        confirmed: { type: 'boolean' },
      },
      required: ['email', 'days', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, days, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm expiry change first.' };
      const gate = checkStepUp(ctx, 'extend_user_expiry', { email, days, confirmed });
      if (gate) return gate;
      try {
        const n = Number(days);
        if (!Number.isFinite(n) || n === 0) return { ok: false, reason: 'Days must be non-zero.' };
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const updated = db.extendLicenseExpiry(user.id, n);
        if (!updated) return { ok: false, reason: 'User has no license.' };
        botAudit(ctx, 'extend-expiry', user, { days: n, new_expires_at: updated.expires_at });
        return {
          ok: true,
          message: `${n > 0 ? 'Added' : 'Removed'} ${Math.abs(n)} day(s) for ${email}.`,
          new_expires_at: updated.expires_at,
        };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/:id/grant-comp.
  {
    name: 'grant_comp_subscription',
    description: 'Grant a free comp at a paid tier (basic/pro/max) — for support make-goods, influencer comps, etc.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        tier: { type: 'string', enum: ['basic', 'pro', 'max'] },
        note: { type: 'string', description: 'Internal note for the audit trail.' },
        confirmed: { type: 'boolean' },
      },
      required: ['email', 'tier', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, tier, note, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm comp grant first.' };
      const gate = checkStepUp(ctx, 'grant_comp_subscription', { email, tier, note, confirmed });
      if (gate) return gate;
      try {
        if (!['basic','pro','max'].includes(tier)) return { ok: false, reason: 'tier must be basic, pro, or max.' };
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const result = db.recordCompPayment(user.id, tier, note || null);
        botAudit(ctx, 'grant-comp', user, { tier, note: note || null, payment_id: result.payment_id });
        return { ok: true, message: `${email} granted ${tier} as a comp.`, ...result };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/reset-devices.
  {
    name: 'reset_user_devices',
    description: 'Wipe ALL device bindings for a user — kicks them off every machine. They\'ll re-bind on next launch.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm device reset first.' };
      const gate = checkStepUp(ctx, 'reset_user_devices', { email, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const changes = db.resetUserDevices(user.id);
        botAudit(ctx, 'reset-devices', user, { devices_cleared: changes });
        return { ok: true, message: `Cleared ${changes} device(s) for ${email}.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/force-logout.
  {
    name: 'force_logout_user',
    description: 'Invalidate every session for a user — they\'ll be logged out everywhere.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm force-logout first.' };
      const gate = checkStepUp(ctx, 'force_logout_user', { email, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        db.forceLogoutUser(user.id);
        botAudit(ctx, 'force-logout', user);
        return { ok: true, message: `All sessions invalidated for ${email}.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/ban.
  {
    name: 'ban_user',
    description: 'Ban a user — revokes license, force-logs them out, blocks future sign-in. Heavy-handed; confirm twice.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        reason: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, reason, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm ban first.' };
      const gate = checkStepUp(ctx, 'ban_user', { email, reason, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        db.banUser(user.id);
        db.forceLogoutUser(user.id);
        const license = db.getLicenseByUserId(user.id);
        if (license) db.revokeKey(license.key, ctx.user.email, reason || 'Banned by admin via bot');
        botAudit(ctx, 'ban', user, { reason: reason || null });
        return { ok: true, message: `${email} has been banned.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/unban.
  {
    name: 'unban_user',
    description: 'Unban a previously-banned user — restores license, allows sign-in again.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm unban first.' };
      const gate = checkStepUp(ctx, 'unban_user', { email, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        db.unbanUser(user.id);
        const license = db.getLicenseByUserId(user.id);
        if (license) db.unrevokeKey(license.key);
        botAudit(ctx, 'unban', user);
        return { ok: true, message: `${email} has been unbanned.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors DELETE /admin/users/:id.
  {
    name: 'delete_user',
    description: 'PERMANENTLY delete a user — conversations, payments, devices, license, login logs. Audit row keeps the trail. Confirm carefully.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        reason: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, reason, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm DELETE first — this is irreversible.' };
      const gate = checkStepUp(ctx, 'delete_user', { email, reason, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        if (user.id === ctx.user.id) return { ok: false, reason: 'Cannot delete your own account.' };
        if (ADMIN_EMAILS.includes((user.email || '').toLowerCase())) {
          return { ok: false, reason: 'Cannot delete another admin via the bot. Remove from ADMIN_EMAILS env first.' };
        }
        botAudit(ctx, 'delete-user', user, {
          reason: reason || null,
          conversation_count: db.getConversationsByUser(user.id).length,
          payment_count: db.getPaymentsByUser(user.id).length,
        });
        db.deleteUser(user.id);
        return { ok: true, message: `User ${email} permanently deleted.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/:id/impersonate.
  {
    name: 'impersonate_user',
    description: 'Issue a scoped 30-minute JWT logged-in AS the target user. All writes under it audit-log against the admin.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        reason: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, reason, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm impersonation first.' };
      const gate = checkStepUp(ctx, 'impersonate_user', { email, reason, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        if (user.is_banned) return { ok: false, reason: 'Cannot impersonate a banned user.' };
        const { generateToken } = require('../middleware/auth');
        const token = generateToken({
          id: user.id, email: user.email, name: user.name, tier: user.tier,
          impersonatedBy: ctx.user.email, impersonatedAt: Date.now(),
        }, '30m');
        botAudit(ctx, 'impersonate', user, { reason: reason || null });
        return {
          ok: true,
          token,
          email: user.email,
          expires_in_seconds: 30 * 60,
          message: `Impersonation token issued for ${email} (30 min). Note that all actions under this token are attributed to ${email} but audit-logged against you.`,
        };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/users/:id/cancel-subscription.
  {
    name: 'cancel_user_subscription',
    description: 'Admin-initiated subscription cancellation for a target user (at period end). Use for refund-equivalent flows.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm cancellation first.' };
      const gate = checkStepUp(ctx, 'cancel_user_subscription', { email, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const customerId = user.stripe_customer_id || '';
        if (customerId.startsWith('rzp_')) {
          const razorpay = getRazorpay();
          if (!razorpay) return { ok: false, reason: 'Razorpay not configured.' };
          const subId = db.getLatestRazorpaySubscriptionId(user.id);
          if (!subId) return { ok: false, reason: 'No Razorpay subscription found.' };
          await razorpay.subscriptions.cancel(subId, false);
          botAudit(ctx, 'cancel-subscription', user, { provider: 'razorpay', subscription_id: subId });
          return { ok: true, provider: 'razorpay', subscription_id: subId, message: `Razorpay sub for ${email} scheduled to cancel at period end.` };
        }
        const stripe = getStripe();
        if (!stripe) return { ok: false, reason: 'Stripe not configured.' };
        if (!customerId) return { ok: false, reason: 'No Stripe customer id on user.' };
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 3 });
        if (!subs.data.length) return { ok: false, reason: 'No active Stripe subscription.' };
        const results = [];
        for (const sub of subs.data) {
          const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
          results.push({ id: sub.id, cancel_at: updated.cancel_at });
        }
        botAudit(ctx, 'cancel-subscription', user, { provider: 'stripe', subscriptions: results });
        return { ok: true, provider: 'stripe', subscriptions: results, message: `${results.length} Stripe sub(s) for ${email} scheduled to cancel at period end.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors POST /admin/payments/:id/refund.
  {
    name: 'refund_payment',
    description: 'Issue a refund on a specific payment row id. Optionally partial (amount in smallest currency unit, e.g. cents). Server-checked eligibility per REFUND_POLICY — bypass requires override_reason ≥ 10 chars.',
    parameters: {
      type: 'object',
      properties: {
        payment_id: { type: 'integer' },
        amount: { type: 'integer', description: 'Optional partial amount in smallest currency unit. Defaults to full refund.' },
        reason: { type: 'string' },
        override_reason: { type: 'string', description: 'Required (min 10 chars) to bypass server-side eligibility check.' },
        confirmed: { type: 'boolean' },
      },
      required: ['payment_id', 'confirmed'],
    },
    destructive: true,
    handler: async (args, ctx) => {
      if (!args.confirmed) return { ok: false, reason: 'Confirm refund first.' };
      const gate = checkStepUp(ctx, 'refund_payment', args);
      if (gate) return gate;
      try {
        const payment = db.getPaymentById(args.payment_id|0);
        if (!payment) return { ok: false, reason: 'Payment not found.' };
        if (payment.status !== 'completed') return { ok: false, reason: `Cannot refund payment in status=${payment.status}.` };
        if (payment.amount <= 0 || payment.provider === 'admin-comp') {
          return { ok: false, reason: 'Cannot refund a zero-amount or comp payment.' };
        }
        if (db.hasPaymentBeenRefunded(payment.provider, payment.provider_payment_id)) {
          return { ok: false, reason: 'Payment already refunded.' };
        }
        if (!payment.provider_payment_id) {
          return { ok: false, reason: 'Payment has no provider_payment_id — cannot refund.' };
        }
        const { computeRefundEligibility } = require('./refundEligibility');
        const license = db.getLicenseByUserId(payment.user_id);
        const eligibility = computeRefundEligibility(payment, license);
        if (!eligibility.eligible && !args.override_reason) {
          return {
            ok: false,
            reason: `Refund ineligible: ${eligibility.reason}. Pass override_reason (min 10 chars) to bypass with audit trail.`,
            eligibility,
          };
        }
        if (!eligibility.eligible) {
          if (typeof args.override_reason !== 'string' || args.override_reason.trim().length < 10) {
            return { ok: false, reason: 'override_reason must be at least 10 characters.' };
          }
        }
        const refundAmount = args.amount !== undefined ? Number(args.amount) : payment.amount;
        if (!Number.isFinite(refundAmount) || refundAmount <= 0 || refundAmount > payment.amount) {
          return { ok: false, reason: 'Invalid refund amount.' };
        }
        let providerRefundId = null;
        if (payment.provider === 'stripe') {
          const stripe = getStripe();
          if (!stripe) return { ok: false, reason: 'Stripe not configured.' };
          const validReasons = ['duplicate', 'fraudulent', 'requested_by_customer'];
          const stripeReason = validReasons.includes(args.reason) ? args.reason : 'requested_by_customer';
          const refund = await stripe.refunds.create({
            payment_intent: payment.provider_payment_id.startsWith('pi_') ? payment.provider_payment_id : undefined,
            charge: payment.provider_payment_id.startsWith('ch_') ? payment.provider_payment_id : undefined,
            amount: refundAmount,
            reason: stripeReason,
            metadata: {
              admin_initiated: 'true',
              admin_email: ctx.user.email,
              admin_reason: args.reason || '',
              via_bot: 'true',
            },
          });
          providerRefundId = refund.id;
        } else if (payment.provider === 'razorpay') {
          const razorpay = getRazorpay();
          if (!razorpay) return { ok: false, reason: 'Razorpay not configured.' };
          const refund = await razorpay.payments.refund(payment.provider_payment_id, {
            amount: refundAmount,
            notes: {
              admin_initiated: 'true', admin_email: ctx.user.email,
              admin_reason: args.reason || '', via_bot: 'true',
            },
          });
          providerRefundId = refund.id;
        } else {
          return { ok: false, reason: `Cannot refund payments from provider=${payment.provider}.` };
        }
        const refundRow = db.recordAdminRefund({
          originalPayment: payment, refundId: providerRefundId,
          amount: refundAmount, reason: args.reason || null,
          initiatedBy: ctx.user.email,
        });
        botAudit(ctx, 'refund-payment', { id: payment.user_id, email: payment.email }, {
          payment_id: payment.id, provider: payment.provider,
          refund_amount: refundAmount, currency: payment.currency,
          provider_refund_id: providerRefundId, reason: args.reason || null,
          eligibility_eligible: eligibility.eligible,
          eligibility_code: eligibility.eligible ? null : eligibility.code,
          eligibility_reason: eligibility.eligible ? null : eligibility.reason,
          override_reason: !eligibility.eligible ? args.override_reason : null,
          via_bot: true,
        });
        return {
          ok: true,
          provider: payment.provider, provider_refund_id: providerRefundId,
          refund_row: refundRow,
          message: `Refund of ${refundAmount} ${payment.currency} issued for payment #${payment.id}.`,
        };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors GET /admin/users/:id/export — DSAR.
  {
    name: 'dsar_export',
    description: 'GDPR Article 15 data-subject-access-request — full bundle of everything we have on a user. Returns inline; do NOT paste the full bundle in chat (it can include PII).',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['email', 'confirmed'],
    },
    destructive: true,
    handler: async ({ email, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm DSAR export — handles PII.' };
      const gate = checkStepUp(ctx, 'dsar_export', { email, confirmed });
      if (gate) return gate;
      try {
        const user = db.getUserByEmail(email);
        if (!user) return { ok: false, reason: `No user with email ${email}.` };
        const bundle = db.getUserDataExport(user.id);
        if (!bundle) return { ok: false, reason: 'Export failed.' };
        botAudit(ctx, 'dsar-export', user, {
          payment_count: bundle.payments?.length || 0,
          conversation_count: bundle.conversations?.length || 0,
        });
        // Stream the bundle as a downloadable file via emit_to_client. We
        // include a small summary in the bot's response, never the full
        // bundle — bundles can be megabytes and full of PII.
        return {
          ok: true,
          summary: {
            email: bundle.user.email,
            payment_count: bundle.payments?.length || 0,
            conversation_count: bundle.conversations?.length || 0,
            device_count: bundle.devices?.length || 0,
            byteSize: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
          },
          emit_to_client: {
            action: 'download_json',
            args: {
              filename: `minicaai-dsar-${email.replace(/[^a-z0-9@._-]+/gi, '_')}.json`,
              content: JSON.stringify(bundle, null, 2),
            },
          },
          message: `DSAR for ${email} prepared. The download has been triggered in your browser.`,
        };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },

  // Mirrors PUT /admin/config/:key.
  {
    name: 'update_app_config',
    description: 'Update a runtime config key (e.g. min_app_version, device limits).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', maxLength: 64 },
        value: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['key', 'value', 'confirmed'],
    },
    destructive: true,
    handler: async ({ key, value, confirmed }, ctx) => {
      if (!confirmed) return { ok: false, reason: 'Confirm config change first.' };
      const gate = checkStepUp(ctx, 'update_app_config', { key, value, confirmed });
      if (gate) return gate;
      try {
        if (typeof key !== 'string' || !key.length || key.length > 64) return { ok: false, reason: 'Invalid config key.' };
        const prev = db.getConfig(key, null);
        db.setConfig(key, String(value));
        botAudit(ctx, 'config-update', null, { key, from: prev, to: String(value) });
        return { ok: true, message: `Config ${key}: ${prev} → ${value}.` };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
  },
];

// ─── Serialization helper ─────────────────────────────────────────
// Strip sensitive cols before returning a user record to the bot.
function serializeUserForBot(u) {
  return {
    id: u.id, email: u.email, name: u.name, tier: u.tier,
    country_code: u.country_code, created_at: u.created_at,
    updated_at: u.updated_at, last_login_at: u.last_login_at,
    is_banned: u.is_banned, oauth_provider: u.oauth_provider,
    stripe_customer_id: u.stripe_customer_id,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PUBLIC API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Build a single lookup table keyed by tool name so executeTool() is O(1).
const ALL_TOOLS = {};
function register(category, defs) {
  for (const def of defs) {
    if (ALL_TOOLS[def.name]) {
      throw new Error(`[botTools] duplicate tool name: ${def.name}`);
    }
    ALL_TOOLS[def.name] = { ...def, category };
  }
}
register('USER_CLIENT', USER_CLIENT_TOOLS);
register('USER_SERVER', USER_SERVER_TOOLS);
register('ADMIN_SERVER', ADMIN_SERVER_TOOLS);
register('ADMIN_DESTRUCTIVE', ADMIN_DESTRUCTIVE_TOOLS);

/**
 * Return the OpenAI Responses-API tool schemas the model should see for
 * the given session role. Anonymous + free → empty array (chat-only,
 * matches the product policy from the user spec).
 *
 *   role: 'anonymous' | 'free' | 'user' | 'admin'
 *
 * For 'user' (basic/pro/max), we expose USER_CLIENT + USER_SERVER.
 * For 'admin', everything.
 */
function getToolSchemasForRole(role) {
  const categories =
    role === 'admin'
      ? ['USER_CLIENT', 'USER_SERVER', 'ADMIN_SERVER', 'ADMIN_DESTRUCTIVE']
    : role === 'user'
      ? ['USER_CLIENT', 'USER_SERVER']
    : []; // anonymous / free
  return Object.values(ALL_TOOLS)
    .filter(t => categories.includes(t.category))
    .map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    }));
}

/**
 * Execute one tool call. Soft-fails: never throws. ctx must contain:
 *   - user      decoded JWT payload (may be null for anonymous)
 *   - tier      resolved license tier (string)
 *   - role      'anonymous' | 'free' | 'user' | 'admin'
 *   - ip        request IP (for audit)
 *   - userAgent request UA (for audit)
 */
async function executeTool(name, rawArgs, ctx) {
  const tool = ALL_TOOLS[name];
  if (!tool) {
    return { ok: false, reason: `Unknown tool: ${name}` };
  }

  // Authorization: enforce role for each category, regardless of what
  // the model thought it had access to. A hallucinated admin tool name
  // by a non-admin caller must hard-fail before reaching the handler.
  const role = ctx.role;
  const allowed =
    role === 'admin' ? true
    : role === 'user' ? (tool.category === 'USER_CLIENT' || tool.category === 'USER_SERVER')
    : false;
  if (!allowed) {
    return { ok: false, reason: `Tool ${name} is not available on your plan.` };
  }

  let args = rawArgs || {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); }
    catch { return { ok: false, reason: 'Tool arguments were not valid JSON.' }; }
  }

  try {
    const result = await tool.handler(args, ctx);
    return result && typeof result === 'object' ? result : { ok: false, reason: 'Tool returned no result.' };
  } catch (e) {
    // Belt-and-suspenders — handlers are supposed to soft-fail, but if
    // one accidentally throws we don't want the loop to terminate.
    console.error(`[botTools] handler ${name} threw:`, e && e.message);
    return { ok: false, reason: `${name} failed: ${e.message || 'unknown error'}` };
  }
}

/**
 * Detailed metadata for a tool (used by the system-prompt builder to
 * surface tool names + descriptions to the model). Returns null if
 * unknown.
 */
function getToolMeta(name) {
  const t = ALL_TOOLS[name];
  if (!t) return null;
  return { name: t.name, category: t.category, description: t.description, destructive: !!t.destructive };
}

/** All tool names available for a role — used by the system prompt. */
function getToolNamesForRole(role) {
  return getToolSchemasForRole(role).map(s => s.name);
}

module.exports = {
  getToolSchemasForRole,
  getToolNamesForRole,
  executeTool,
  getToolMeta,
  // Exposed for tests + the /reauth-execute endpoint which needs to
  // re-run a captured intent under a fresh step-up JWT.
  ALL_TOOLS,
};
