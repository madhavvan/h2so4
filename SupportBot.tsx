// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SupportBot — "Minica" public-facing support assistant
//
//  Single component, three render modes:
//   • mode="floating"  bottom-right widget on minicaai.com (default closed,
//                       opens to a phone-sized panel). Cream/ink palette
//                       to match the editorial landing aesthetic.
//   • mode="panel"     fills its parent container — used inside the
//                       Electron app's Help → Support modal. Uses the
//                       app's bg-surface/text-text tokens so it picks up
//                       the user's light/dark theme.
//   • mode="view"      full-screen takeover — used by SubscriptionGate's
//                       view === 'support' route. Cream palette.
//
//  Wires to:
//   POST /api/v1/support/chat       SSE stream — server proxies to OpenAI
//                                    Responses API with web_search tool
//   POST /api/v1/support/handoff    "Talk to a human" — Slack + email
//
//  Session (id + last ~30 turns) is persisted in sessionStorage so a tab
//  refresh doesn't wipe the conversation. Clears on tab close.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  X, Send, Headphones, MessageCircle, Mail, Loader2, AlertCircle, ChevronDown, Globe, Sparkles,
  Lock, ArrowUpRight, ChevronRight, Wand2, CheckCircle2, Smartphone, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
// Phosphor Icons — same set Linear / Cursor / Cal.com use. The "duotone"
// weight uses two-tone opacity layers (a faint full-shape backplate
// behind a crisp outline). At small UI sizes this reads dramatically
// richer than a single-stroke icon — closer to the precision-cut SF
// Symbol feel of a native macOS app than a vector library.
import { HeadsetIcon } from '@phosphor-icons/react';

type Role = 'user' | 'assistant';

interface ChatMessage {
  role: Role;
  content: string;
  time: string;
}

type Mode = 'floating' | 'panel' | 'view';
type HandoffStatus = 'idle' | 'sending' | 'sent' | 'error';

/** Action the bot can ask the renderer to execute. The bot fires these
 *  optimistically (the server has already synthesized an ok:true result
 *  to the model), so the callback is fire-and-forget. Implementers
 *  should swallow exceptions internally and surface failures via the
 *  next user-driven turn rather than throwing here. */
export interface BotAction {
  action: string;
  args?: any;
}

export interface SupportBotProps {
  mode: Mode;
  apiBase?: string;
  currentUser?: {
    email?: string | null;
    name?: string | null;
    id?: string | null;
  } | null;
  /** User's live subscription tier. Drives the scripted-vs-AI fork:
   *  null/undefined (anonymous) → scripted topic picker.
   *  'free'                     → scripted topic picker.
   *  every tier in AI_CHAT_TIERS → full AI chat.
   *  When undefined, the bot fetches /api/v1/support/tier to decide.
   *
   *  Deliberately NOT a hand-written tier list any more. This doc used to
   *  read "'basic' / 'pro' / 'max'", and that is exactly the list that
   *  went stale when Ultra shipped — the top paid tier fell through to
   *  the scripted FAQ. AI_CHAT_TIERS (below) is the one place tiers are
   *  enumerated; keep it that way. */
  tier?: string | null;
  /** Optional JWT for the tier probe + /chat auth. If omitted the bot
   *  works anonymously (and falls back to scripted). */
  authToken?: string | null;
  onClose?: () => void;
  startOpen?: boolean;
  /** Renderer-side dispatcher for bot tool_call events. Mounted by the
   *  in-app panel (App.tsx). The floating + view modes leave it
   *  undefined since those instances live outside MainApp and have no
   *  settings/license to mutate; the bot still chats (and the server
   *  pre-checks tier so it never emits a tool_call for an action the
   *  renderer can't fulfill). */
  onBotAction?: (action: BotAction) => void | Promise<void>;
}

// Must stay in sync with AI_CHAT_TIERS in server/src/routes/support.js.
// 'ultra' was absent from both, so the top paid tier saw the Free scripted
// FAQ instead of the AI chat its plan promises.
const AI_CHAT_TIERS = new Set(['basic', 'pro', 'max', 'ultra']);

type ScriptedTopic = { id: string; q: string; a: string };
type ScriptedCategory = { id: string; label: string; topics: ScriptedTopic[] };
type ScriptedBundle = {
  version: number;
  upgradeUrl: string;
  categories: ScriptedCategory[];
};

// In dev (vite serves on :3005), VITE_SERVER_URL points the bot at the
// local API server so we can test without round-tripping prod. In prod
// we IGNORE the env var even if accidentally left uncommented in
// .env.local — leaving it active during a prod build shipped a broken
// installer once (v4.0.0–v4.0.2, 2026-05-09). Mirrors the same
// defense-in-depth guard in services/licenseService.ts.
const DEFAULT_API_BASE = (() => {
  // `import.meta` is always defined in Vite-built ESM — the old typeof
  // guard was dead code. The defense that actually matters is the PROD
  // short-circuit so a stray VITE_SERVER_URL in .env.local can't ship
  // in a release build (the v4.0.0–v4.0.2 incident).
  const env = (import.meta as any).env || {};
  if (env.PROD) return 'https://api.minicaai.com';
  return env.VITE_SERVER_URL || 'https://api.minicaai.com';
})();

const STORAGE_KEY = 'minicaai-support-session-v1';
const MAX_INPUT_CHARS = 2000;
const MAX_PERSISTED_MESSAGES = 30;

const HARI_GREETING =
  "Hi, I'm Minica — minicaai's support assistant. I can help with installation, plans, refunds, privacy, troubleshooting, and most things in our docs. What's on your mind? If you'd rather talk to a person, use the Talk to a human link below.";

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function generateSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface PersistedSession {
  sessionId: string;
  messages: ChatMessage[];
}

function loadPersisted(): PersistedSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed || !parsed.sessionId || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(session: PersistedSession): void {
  try {
    const trimmed: PersistedSession = {
      sessionId: session.sessionId,
      messages: session.messages.slice(-MAX_PERSISTED_MESSAGES),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota exceeded, ignore — chat still works in-memory */
  }
}

// ─── Palette ──────────────────────────────────────────────────────
// 'landing' palette = the cream/ink/terracotta set used on
// minicaai.com's public surfaces (defined in index.html). 'app' palette
// = the Tailwind-mapped surface/text/border tokens so the in-app
// panel inherits the user's light/dark preference automatically.
interface Palette {
  bg: string;
  bgSoft: string;
  bgInput: string;
  border: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  inkFaint: string;
  accent: string;
  accentSoft: string;
  invertBg: string;
  invertText: string;
  font: string;
}

const PALETTE_LANDING: Palette = {
  bg: 'var(--cream)',
  bgSoft: 'var(--cream-soft)',
  bgInput: '#ffffff',
  border: 'var(--cream-line)',
  ink: 'var(--ink)',
  inkSoft: 'var(--ink-soft)',
  inkMuted: 'var(--ink-muted)',
  inkFaint: 'var(--ink-faint)',
  accent: 'var(--accent)',
  accentSoft: 'var(--accent-soft)',
  invertBg: 'var(--ink)',
  invertText: 'var(--cream)',
  font: 'var(--sans)',
};

// In-app panel. Every value is a theme-aware --mc-* token (defined in
// index.html for both light and dark), so the panel follows the app's
// warm cream / warm obsidian material instead of fighting it.
//
// What was wrong before: inkMuted and inkFaint were hardcoded COOL greys
// (#6b7280 / #9ca3af). They never flipped with the theme, so on the warm
// obsidian dark surface the secondary text read blue-grey against warm
// paper, and on cream it read cold against terracotta-warm neutrals —
// the single biggest reason the support panel looked like a different
// product bolted into the app. invertText was flat #ffffff, brighter than
// any real text in the product.
const PALETTE_APP: Palette = {
  bg: 'var(--mc-bg)',
  bgSoft: 'var(--mc-raise)',
  bgInput: 'var(--mc-input)',
  border: 'var(--mc-line)',
  ink: 'var(--mc-ink)',
  inkSoft: 'var(--mc-ink-soft)',
  inkMuted: 'var(--mc-ink-muted)',
  inkFaint: 'var(--mc-ink-faint)',
  accent: 'var(--mc-accent)',
  accentSoft: 'var(--mc-accent-soft)',
  invertBg: 'var(--mc-invert-bg)',
  invertText: 'var(--mc-invert-ink)',
  font: 'inherit',
};

const SupportBot: React.FC<SupportBotProps> = ({
  mode,
  apiBase,
  currentUser,
  tier: tierProp,
  authToken,
  onClose,
  startOpen = false,
  onBotAction,
}) => {
  const base = apiBase || DEFAULT_API_BASE;
  const p = mode === 'panel' ? PALETTE_APP : PALETTE_LANDING;

  // ── Tier resolution ────────────────────────────────────────────
  // The SERVER is authoritative. A `tier` prop from the parent is only an
  // optimistic seed to avoid a spinner flash — it never replaces the probe.
  //
  // It used to replace it, and that was the "please sign up" bug. Both real
  // call sites pass `tier={license?.tier ?? null}`, and `null !== undefined`,
  // so the component took the "parent owns this" branch, evaluated
  // `null || 'anonymous'`, and rendered "Sign up free to chat with Minica"
  // at a signed-in customer. It then never recovered, because that branch
  // also skipped the probe AND short-circuited the auth-change listener, so
  // nothing re-checked once the licence finished loading. Any moment the
  // parent's licence object was null — first paint, a slow or failed
  // /license/validate, a token refresh — put the panel into a stuck
  // signed-out state.
  //
  // Same root cause hid the admin inbox: isAdminRole is only ever set from
  // the probe response, so whenever the parent passed a tier the probe
  // never ran and `isAdminRole` stayed false. The in-app panel (App.tsx)
  // always passes one — which is why the inbox appeared in the floating bot
  // (no tier prop → probe ran) but not in the panel.
  //
  // Now: seed from the prop when it carries a real tier, then always probe
  // and let the server correct it. The probe is anonymous-friendly — no
  // token → tier='anonymous'.
  //
  // The bot is reactive to auth state changes:
  //   • Reads the JWT directly from localStorage at fetch time (not just
  //     at mount), so an authToken prop passed by a parent that itself
  //     doesn't re-render on login (e.g. the floating bot mounted in the
  //     SubscriptionGate export wrapper) still picks up the new token.
  //   • Listens for the 'minicaai-auth-changed' custom event dispatched
  //     by licenseService.saveAuth/clearAuth and re-runs the tier probe.
  //   • Also listens for cross-tab 'storage' events for parity.
  // A falsy prop means "the parent does not know yet", NOT "anonymous".
  // Seeding null keeps the panel in its resolving state until the server
  // answers, instead of asserting signed-out at a signed-in user.
  const initialResolved = tierProp || null;
  const [resolvedTier, setResolvedTier] = useState<string | null>(initialResolved);
  const [isAdminRole, setIsAdminRole] = useState<boolean>(false);
  const [tierProbeNonce, setTierProbeNonce] = useState(0);
  const canUseAi = resolvedTier !== null && AI_CHAT_TIERS.has(resolvedTier);
  const isResolving = resolvedTier === null;

  // Read the freshest token at call time. authToken prop is the seed
  // (helpful in panel mode where the parent knows the current user);
  // localStorage is the live source of truth. We trust localStorage when
  // it has a value because login writes there before re-render fires.
  const readLiveToken = useCallback((): string | null => {
    if (typeof window !== 'undefined') {
      try {
        const fromStorage = window.localStorage.getItem('minicaai_token');
        if (fromStorage) return fromStorage;
      } catch { /* private mode / disabled */ }
    }
    return authToken || null;
  }, [authToken]);

  useEffect(() => {
    // Optimistic seed only — no early return. The probe below is what
    // decides, because it is the only thing that sees the JWT, the real
    // licence row, and admin status.
    if (tierProp) setResolvedTier(tierProp);
    let cancelled = false;
    (async () => {
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        const liveToken = readLiveToken();
        if (liveToken) headers.Authorization = `Bearer ${liveToken}`;
        const r = await fetch(`${base}/api/v1/support/tier`, { headers });
        const data = await r.json().catch(() => ({}));
        // Server says the token we sent failed signature/expiry. Clear
        // it from localStorage — but ONLY if localStorage STILL contains
        // the exact token we sent. Otherwise a sign-in landed mid-flight
        // and the localStorage now holds a fresh valid token; clearing
        // it here would put the user back to anonymous. Race-window
        // mattered in practice: the SubscriptionGate's floating bot
        // probes /tier with a stale token during the brief moment the
        // sign-in modal is closing.
        if (data?.authError === 'invalid_token' && liveToken) {
          try {
            const stillSame = window.localStorage.getItem('minicaai_token') === liveToken;
            if (stillSame) {
              window.localStorage.removeItem('minicaai_token');
              window.dispatchEvent(new CustomEvent('minicaai-auth-changed', { detail: { reason: 'invalid_token_cleanup' } }));
            }
          } catch { /* localStorage disabled */ }
        }
        if (!cancelled) {
          setResolvedTier(String(data?.tier || 'anonymous'));
          setIsAdminRole(!!data?.isAdmin);
          // ── Defensive sync: propagate server-confirmed admin flag
          // back into the saved user object if it's stale. Belt-and-
          // suspenders for App.tsx's auth listener — covers the case
          // where /license/validate hasn't run yet (e.g. license check
          // failed at boot but tier probe succeeded). Without this,
          // the renderer can sit in a state where /tier says admin but
          // the saved user doesn't carry is_admin, and any gated hook
          // (notably the support-agent WebSocket) stays dormant.
          try {
            const raw = window.localStorage.getItem('minicaai_auth');
            if (raw && typeof data?.isAdmin === 'boolean') {
              const u = JSON.parse(raw);
              if (u && typeof u === 'object' && !!u.is_admin !== !!data.isAdmin) {
                const merged = { ...u, is_admin: !!data.isAdmin };
                window.localStorage.setItem('minicaai_auth', JSON.stringify(merged));
                window.dispatchEvent(new CustomEvent('minicaai-auth-changed', { detail: { reason: 'tier-probe-admin-sync' } }));
              }
            }
          } catch { /* localStorage disabled or malformed JSON */ }
        }
      } catch {
        if (!cancelled) setResolvedTier('anonymous');
      }
    })();
    return () => { cancelled = true; };
  }, [tierProp, authToken, base, readLiveToken, tierProbeNonce]);

  // Re-run the tier probe whenever auth state changes mid-session.
  // licenseService dispatches 'minicaai-auth-changed' on saveAuth/clearAuth;
  // 'storage' fires for cross-tab logins. Both bump the nonce, which is
  // in the dep array of the tier-probe effect → re-runs the fetch.
  useEffect(() => {
    // Runs regardless of the tier prop. Sign-in, sign-out and cross-tab
    // auth changes must always re-probe — when this returned early for a
    // parent-supplied tier, a user who signed in while the panel was open
    // stayed stuck on whatever the prop said at mount.
    if (typeof window === 'undefined') return;
    const refresh = () => {
      // Reset resolution to 'loading' state so UI shows spinner during refetch.
      setResolvedTier(null);
      setScripted(null);
      setTierProbeNonce(n => n + 1);
    };
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === 'minicaai_token' || e.key === 'minicaai_auth' || e.key === 'minicaai_license') {
        refresh();
      }
    };
    window.addEventListener('minicaai-auth-changed', refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('minicaai-auth-changed', refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [tierProp]);

  // ── Scripted topics (lazy-fetched only when needed) ────────────
  const [scripted, setScripted] = useState<ScriptedBundle | null>(null);
  const [scriptedError, setScriptedError] = useState<string | null>(null);
  const [expandedTopic, setExpandedTopic] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  useEffect(() => {
    if (canUseAi || isResolving) return;
    if (scripted) return;
    let cancelled = false;
    fetch(`${base}/api/v1/support/scripted-topics`)
      .then(async (r) => {
        // Server can 404 (route not deployed yet) or 5xx; both return a
        // small error JSON that isn't a ScriptedBundle. Treat as failure
        // rather than letting a malformed payload reach render, where
        // .categories.map would throw.
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!data || !Array.isArray(data.categories)) {
          throw new Error('malformed bundle');
        }
        return data as ScriptedBundle;
      })
      .then((data) => {
        if (cancelled) return;
        setScripted(data);
        if (data.categories[0]) setExpandedCategory(data.categories[0].id);
      })
      .catch(() => {
        if (!cancelled) setScriptedError("Couldn't load topics. Try Talk to a human below.");
      });
    return () => { cancelled = true; };
  }, [canUseAi, isResolving, scripted, base]);

  // ── Session boot ───────────────────────────────────────────────
  const initial = useMemo(() => {
    const loaded = loadPersisted();
    if (loaded && loaded.messages.length > 0) return loaded;
    return {
      sessionId: generateSessionId(),
      messages: [{ role: 'assistant' as Role, content: HARI_GREETING, time: nowTime() }],
    };
  }, []);

  const [sessionId] = useState<string>(initial.sessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusPhase, setStatusPhase] = useState<'' | 'searching' | 'searched'>('');
  const [isOpen, setIsOpen] = useState<boolean>(mode !== 'floating' || startOpen);

  // ── Step-up reauth inline ──────────────────────────────────────
  // When the chat stream emits step_up_required (admin destructive
  // tool needs password reverify), we surface a single password input
  // as a chat bubble. After the admin submits, we POST the captured
  // intent + password to /api/v1/support/reauth-execute; on success
  // we swap the JWT in localStorage (licenseService.saveAuth path)
  // and render the result.message as the next assistant turn.
  interface PendingStepUp {
    reason: string;
    intent: { tool: string; args: any };
  }
  const [pendingStepUp, setPendingStepUp] = useState<PendingStepUp | null>(null);
  const [stepUpPassword, setStepUpPassword] = useState('');
  const [stepUpStatus, setStepUpStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  // ── Handoff form ───────────────────────────────────────────────
  const [showHandoff, setShowHandoff] = useState(false);
  const [handoffEmail, setHandoffEmail] = useState(currentUser?.email || '');
  const [handoffName, setHandoffName] = useState(currentUser?.name || '');
  const [handoffQuestion, setHandoffQuestion] = useState('');
  const [handoffStatus, setHandoffStatus] = useState<HandoffStatus>('idle');
  const [handoffError, setHandoffError] = useState<string | null>(null);

  // ── Live agent chat (WebSocket) ────────────────────────────────
  // When the user clicks "Talk to a human", we no longer just send an
  // email — we open a WS to /ws/support and try to put them in a live
  // conversation with a connected admin. Falls back to the email form
  // if no agent comes online within FALLBACK_TIMEOUT_MS.
  type LiveStatus = 'idle' | 'connecting' | 'waiting' | 'connected' | 'closed';
  const [liveMode, setLiveMode] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle');
  const [liveAgentName, setLiveAgentName] = useState<string | null>(null);
  const liveWsRef = useRef<WebSocket | null>(null);
  const liveFallbackTimerRef = useRef<number | null>(null);
  // Mirror liveStatus into a ref so async WS handlers + the fallback
  // timer (both set up inside enterLiveMode's closure) read the latest
  // value instead of the stale snapshot from when enterLiveMode ran.
  const liveStatusRef = useRef<LiveStatus>('idle');
  useEffect(() => { liveStatusRef.current = liveStatus; }, [liveStatus]);
  // Tracks which agent we've already shown the "X is here" system line
  // for in THIS bot session. Lets us suppress duplicates across the
  // customer's WS reconnects without losing the genuine signal when a
  // different agent takes over the thread mid-conversation.
  const liveAgentAnnouncedRef = useRef<string | null>(null);

  // ── Customer-side CSAT prompt ──
  // When the agent resolves the thread, the server sends a
  // 'csat_request' WS frame with { threadId }. We render a 5-star
  // widget above the input bar; on submit, we POST to /csat and
  // clear the widget. csatThreadId is null when no prompt is pending.
  const [csatThreadId, setCsatThreadId] = useState<string | null>(null);
  const [csatRating, setCsatRating] = useState<number>(0);
  const [csatHoverRating, setCsatHoverRating] = useState<number>(0);
  const [csatComment, setCsatComment] = useState<string>('');
  const [csatSubmitting, setCsatSubmitting] = useState<boolean>(false);
  const [csatThanks, setCsatThanks] = useState<boolean>(false);
  const submitCsat = useCallback(async () => {
    if (!csatThreadId || csatRating < 1) return;
    setCsatSubmitting(true);
    try {
      const token = readLiveToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch(`${base}/api/v1/support/inbox/threads/${csatThreadId}/csat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ rating: csatRating, comment: csatComment.trim() || undefined }),
      });
      if (r.ok) {
        setCsatThanks(true);
        // Brief thanks state, then clear the widget entirely.
        window.setTimeout(() => {
          setCsatThreadId(null);
          setCsatRating(0);
          setCsatComment('');
          setCsatThanks(false);
        }, 2500);
      }
    } catch { /* network blip — widget stays so user can retry */ }
    finally { setCsatSubmitting(false); }
  }, [base, csatThreadId, csatRating, csatComment, readLiveToken]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Persist conversation ────────────────────────────────────────
  useEffect(() => {
    savePersisted({ sessionId, messages });
  }, [sessionId, messages]);

  // ── Autoscroll on message change ───────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isStreaming, statusPhase]);

  // ── Esc closes floating/view ───────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showHandoff) setShowHandoff(false);
        else if (mode === 'floating') setIsOpen(false);
        else if (mode === 'view') onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, mode, onClose, showHandoff]);

  // ── Cancel any in-flight stream on unmount ──────────────────────
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── Send a message ─────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // Live-agent mode: messages flow over the WebSocket to the connected
    // admin, NOT through the AI /chat endpoint. The bot UI shows the
    // user message immediately; agent replies arrive via the ws.onmessage
    // handler set up in enterLiveMode().
    if (liveMode) {
      const ws = liveWsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Lost the socket — re-attempt connection silently.
        setMessages(prev => [
          ...prev,
          { role: 'user', content: text, time: nowTime() },
          { role: 'assistant', content: '_Couldn\'t reach the live agent — try again or click End live chat to switch back to Minica._', time: nowTime() },
        ]);
        setInput('');
        return;
      }
      try { ws.send(JSON.stringify({ type: 'message', text })); }
      catch { /* socket died between readyState check and send */ }
      setMessages(prev => [
        ...prev,
        { role: 'user', content: text, time: nowTime() },
      ]);
      setInput('');
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text, time: nowTime() };
    const placeholder: ChatMessage = { role: 'assistant', content: '', time: nowTime() };

    setMessages(prev => [...prev, userMsg, placeholder]);
    setInput('');
    setIsStreaming(true);
    setStatusPhase('');

    const controller = new AbortController();
    abortRef.current = controller;

    // Build the API-shaped messages (omit the empty placeholder we just added
    // and the synthetic greeting if it's the first turn).
    const apiMessages = [...messages, userMsg]
      .filter(m => m.content && (m !== messages[0] || m.role !== 'assistant' || m.content !== HARI_GREETING))
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const liveToken = readLiveToken();
      if (liveToken) headers.Authorization = `Bearer ${liveToken}`;
      const res = await fetch(`${base}/api/v1/support/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: apiMessages, sessionId }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        let parsed: any = null;
        try { parsed = JSON.parse(errText); } catch { /* not json */ }
        // Tier dropped mid-session (refund, downgrade, sign-out) — server
        // returns 403 with code 'free_tier_no_bot'. Swap to scripted view
        // instead of leaving the user stuck on the chat UI.
        if (res.status === 403 && parsed?.code === 'free_tier_no_bot') {
          setResolvedTier(String(parsed?.tier || 'free'));
          throw new Error(parsed?.error || 'Switched to scripted topics — your plan does not include AI chat.');
        }
        // Stored JWT failed signature/expiry. Without this branch the user
        // looks anonymous to the bot forever even after a re-login attempt
        // unless the page reloads. Surface a clear re-auth prompt instead.
        if (res.status === 401 && parsed?.code === 'invalid_token') {
          throw new Error(parsed?.error || 'Your sign-in expired — sign out and back in.');
        }
        const msg = parsed?.error || `Server returned ${res.status}`;
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotAny = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';

        for (const frame of frames) {
          if (!frame.trim()) continue;
          let eventName = 'message';
          let dataStr = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          let payload: any = null;
          try { payload = JSON.parse(dataStr); } catch { continue; }

          // (Removed: a rollout-era console.log of every non-delta SSE
          // event. It printed whole payloads, and the admin role's
          // tool_call events carry account lookups and billing actions —
          // not something to leave writing into anyone's DevTools once
          // the flow was confirmed working.)

          if (eventName === 'delta' && typeof payload.text === 'string') {
            gotAny = true;
            setMessages(prev => {
              const copy = prev.slice();
              const last = copy[copy.length - 1];
              if (last && last.role === 'assistant') {
                copy[copy.length - 1] = { ...last, content: last.content + payload.text };
              }
              return copy;
            });
          } else if (eventName === 'status' && (payload.phase === 'searching' || payload.phase === 'searched')) {
            setStatusPhase(payload.phase);
            if (payload.phase === 'searched') {
              window.setTimeout(() => setStatusPhase(''), 600);
            }
          } else if (eventName === 'tool_call' && payload?.payload?.action) {
            // Renderer-side tool. Fire-and-forget — server has already
            // synthesized the result back into the model loop. Mark
            // gotAny so the no-response fallback doesn't fire on
            // tool-only turns.
            gotAny = true;
            try {
              const action = String(payload.payload.action);
              const args = payload.payload.args || {};
              // SupportBot-local actions: only make sense inside the bot
              // panel (e.g. opening the handoff form). Dispatched via a
              // window event so SupportBot's own useEffect listener can
              // call openHandoff — keeps the send useCallback decoupled
              // from openHandoff's deps.
              if (action === 'open_handoff_form') {
                try { window.dispatchEvent(new CustomEvent('minicaai-bot-open-handoff')); }
                catch { /* SSR / window stripped */ }
              } else {
                const maybePromise = onBotAction?.({ action, args });
                if (maybePromise && typeof (maybePromise as any).then === 'function') {
                  (maybePromise as Promise<void>).catch(() => { /* never bubble */ });
                }
              }
            } catch { /* dispatcher threw; user re-asks on next turn */ }
          } else if (eventName === 'tool_result') {
            // Telemetry only — used during dev to verify wiring. We
            // intentionally do NOT render a "Tool X ran" line into the
            // chat thread; the bot's own next text turn confirms what
            // happened. Keeping this branch present so future debug
            // builds can opt in via a flag without re-touching the
            // SSE parser.
            gotAny = true;
          } else if (eventName === 'step_up_required') {
            // Destructive admin tool was attempted without a fresh
            // stepUp claim. Pop the inline password prompt; the user's
            // submit handler posts {password, intent} to /reauth-execute.
            if (payload?.intent && payload?.intent?.tool) {
              setPendingStepUp({
                reason: String(payload.reason || 'This action needs your password.'),
                intent: payload.intent,
              });
              setStepUpStatus('idle');
              setStepUpError(null);
              gotAny = true;
            }
          } else if (eventName === 'error') {
            // The server's never-show-errors rule means tool failures
            // never reach us as `error` events — only transport-level
            // catastrophes. Even then the server now also emits a
            // friendly `delta` before the `error`, so the user already
            // sees a graceful message. Swallow the technical error
            // payload silently rather than rendering a red banner.
            console.warn('[support] server emitted error event:', payload?.message);
          } else if (eventName === 'done') {
            /* graceful end — loop will exit on next reader.read() */
          }
        }
      }

      if (!gotAny) {
        setMessages(prev => {
          const copy = prev.slice();
          const last = copy[copy.length - 1];
          if (last && last.role === 'assistant' && !last.content) {
            copy[copy.length - 1] = { ...last, content: "Hmm — I didn't catch that. Could you rephrase, or use Talk to a human?" };
          }
          return copy;
        });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        /* user navigated away; leave the partial response as-is */
      } else {
        // Never-show-errors rule: replace the empty assistant placeholder
        // with a graceful in-stream message rather than a red banner.
        // Specific actionable error messages (sign-in expired, plan
        // dropped, etc.) preserve their original text — burying them
        // under a generic "hiccup" defeats the entire point of throwing
        // them. Only unknown/transport errors fall back to "hiccup".
        console.warn('[support] chat stream failed:', err?.message);
        const rawMsg: string = String(err?.message || '');
        const actionablePatterns = [
          'sign-in expired', 'sign in expired', 'Sign out and sign back',
          'plan does not include', 'Switched to scripted',
        ];
        const isActionable = actionablePatterns.some(p => rawMsg.includes(p));
        const renderMsg = isActionable
          ? rawMsg
          : 'I had a hiccup reaching the model. Try sending that again, or use Talk to a human below.';
        setMessages(prev => {
          const copy = prev.slice();
          const last = copy[copy.length - 1];
          if (last && last.role === 'assistant' && !last.content) {
            copy[copy.length - 1] = { ...last, content: renderMsg };
          }
          return copy;
        });
      }
    } finally {
      setIsStreaming(false);
      setStatusPhase('');
      abortRef.current = null;
    }
  }, [base, input, isStreaming, messages, sessionId, readLiveToken, liveMode]);

  // ── Handoff form ──────────────────────────────────────────────
  const openHandoff = useCallback(() => {
    setShowHandoff(true);
    setHandoffStatus('idle');
    setHandoffError(null);
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!handoffQuestion && lastUser) setHandoffQuestion(lastUser.content);
  }, [messages, handoffQuestion]);

  // Listen for the open_handoff_form bot tool call. Dispatched as a
  // window event from inside `send` so we don't have to thread the
  // (changes-every-render) openHandoff identity through send's deps.
  // A ref keeps the listener pointed at the latest openHandoff.
  const openHandoffRef = useRef(openHandoff);
  useEffect(() => { openHandoffRef.current = openHandoff; }, [openHandoff]);
  useEffect(() => {
    const onOpen = () => openHandoffRef.current?.();
    window.addEventListener('minicaai-bot-open-handoff', onOpen as EventListener);
    return () => window.removeEventListener('minicaai-bot-open-handoff', onOpen as EventListener);
  }, []);

  // ── Live agent chat lifecycle ─────────────────────────────────
  // enterLiveMode opens a WebSocket to /ws/support and joins as a
  // customer. The server already routes customer → all-online-agents
  // and agent → specific-customer (server/src/index.js:608+). We:
  //   1. show "connecting" then "waiting for an agent" status
  //   2. show "connected" + greet once an agent message arrives
  //   3. fall back to the email handoff after FALLBACK_TIMEOUT_MS if
  //      no agent connects (don't strand a user staring at a spinner)
  // The chat-bubble UI is reused for live messages — they get a
  // visual marker (different bubble color + agent name) so the user
  // can tell who's typing.
  const LIVE_FALLBACK_MS = 30_000;
  const buildWsUrl = useCallback(() => {
    try {
      const httpBase = base.replace(/\/$/, '');
      const wsBase = httpBase.replace(/^http/, 'ws');
      return `${wsBase}/ws/support`;
    } catch {
      return 'wss://api.minicaai.com/ws/support';
    }
  }, [base]);

  // Reconnect state. liveDesiredRef stays true for the entire span
  // the customer wants to be in live chat — flipped to false only by
  // exitLiveMode. liveReconnectTimerRef holds the pending reconnect
  // setTimeout so exit can cancel it. liveAttemptRef tracks backoff
  // attempt count; reset on a successful socket OPEN.
  const liveDesiredRef = useRef<boolean>(false);
  const liveReconnectTimerRef = useRef<number | null>(null);
  const liveAttemptRef = useRef<number>(0);
  const liveHeartbeatRef = useRef<number | null>(null);

  const closeLiveSocket = useCallback((reason?: string) => {
    if (liveFallbackTimerRef.current) {
      window.clearTimeout(liveFallbackTimerRef.current);
      liveFallbackTimerRef.current = null;
    }
    if (liveReconnectTimerRef.current !== null) {
      window.clearTimeout(liveReconnectTimerRef.current);
      liveReconnectTimerRef.current = null;
    }
    if (liveHeartbeatRef.current !== null) {
      window.clearInterval(liveHeartbeatRef.current);
      liveHeartbeatRef.current = null;
    }
    const ws = liveWsRef.current;
    if (ws) {
      try { ws.close(1000, reason || 'client closed'); } catch { /* socket already dead */ }
      liveWsRef.current = null;
    }
  }, []);

  const exitLiveMode = useCallback(() => {
    liveDesiredRef.current = false;       // stop the auto-reconnect loop
    liveAgentAnnouncedRef.current = null; // next live session re-announces
    closeLiveSocket('user exited live');
    setLiveMode(false);
    setLiveStatus('idle');
    setLiveAgentName(null);
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: '_Live agent chat ended — you\'re back with Minica._',
        time: nowTime(),
      },
    ]);
  }, [closeLiveSocket]);

  // Internal: open a single WebSocket and wire up handlers. enterLiveMode
  // is the public entry that flips state + greets; reconnects re-call
  // this without re-greeting or resetting the fallback timer (so a
  // mid-conversation network blip is invisible to the user — they just
  // see a brief "Reconnecting…" hint instead of starting over).
  const connectLiveSocket = useCallback((opts: { email: string; name: string; isReconnect: boolean }) => {
    // Bail if user already exited or socket is already up.
    if (!liveDesiredRef.current) return;
    if (liveWsRef.current && liveWsRef.current.readyState <= 1) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWsUrl());
    } catch {
      // Construction itself failed — schedule retry below.
      scheduleLiveReconnect(opts);
      return;
    }
    liveWsRef.current = ws;

    ws.onopen = () => {
      liveAttemptRef.current = 0;
      try {
        // Carry the JWT so the server binds this chat to the verified
        // account (and replays prior history) instead of treating it as an
        // anonymous, history-less session.
        ws.send(JSON.stringify({ type: 'join', role: 'customer', user: opts.email, name: opts.name, token: readLiveToken() || undefined }));
      } catch { /* socket died between open and send */ }
      // Promote 'connecting' → 'waiting' on first open. On reconnect
      // we only change status if we were in a clearly-disconnected
      // state, so a mid-conversation reconnect stays 'connected'.
      if (!opts.isReconnect) {
        setLiveStatus('waiting');
      } else if (liveStatusRef.current === 'connecting' || liveStatusRef.current === 'closed') {
        setLiveStatus('waiting');
      }
      // Heartbeat every 30s so the server's idle sweeper doesn't
      // evict us during long quiet stretches AND any tab-throttle
      // path becomes visible (no heartbeat ack → server idle close →
      // we reconnect via onclose).
      if (liveHeartbeatRef.current !== null) {
        window.clearInterval(liveHeartbeatRef.current);
      }
      liveHeartbeatRef.current = window.setInterval(() => {
        const w = liveWsRef.current;
        if (w && w.readyState === WebSocket.OPEN) {
          try { w.send(JSON.stringify({ type: 'heartbeat' })); } catch {}
        }
      }, 30_000);
      // Initial-connect-only: schedule the 30s "no agent" hint.
      // Reconnects don't reset this — if the customer was already
      // mid-chat, they don't need a "no agent picked up" toast.
      if (!opts.isReconnect && liveFallbackTimerRef.current === null) {
        liveFallbackTimerRef.current = window.setTimeout(() => {
          if (liveStatusRef.current !== 'connected') {
            setMessages(prev => [
              ...prev,
              {
                role: 'assistant',
                content: 'No live agent picked up yet. Leave a message via **Leave a message** below and we\'ll get back to you within a few hours.',
                time: nowTime(),
              },
            ]);
            // Don't drop the socket — agent might connect any second.
            // Just downgrade status so the user sees the fallback path.
            setLiveStatus('closed');
          }
        }, LIVE_FALLBACK_MS);
      }
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(String(evt.data));
        console.info('[support-customer-ws] ← frame', data.type, data);
        // Persistence resume: server sends prior thread history on join
        // so the customer sees their previous conversation immediately
        // instead of a blank panel. We replace local messages with the
        // historical set, then keep appending live messages on top.
        // (Server only sends 'history' for customers, not agents.)
        if (data.type === 'history' && Array.isArray(data.messages)) {
          const restored = data.messages.map((m: any) => ({
            role: (m.role === 'agent' || m.role === 'bot' || m.role === 'system') ? 'assistant' : 'user',
            content: String(m.text || ''),
            // Format timestamp into the same HH:MM the live path uses
            time: m.at ? new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : nowTime(),
          }));
          if (restored.length > 0) {
            setMessages(restored);
          }
          return;
        }
        if (data.type === 'message') {
          // First message from an agent flips status to 'connected'.
          if (liveStatusRef.current !== 'connected') {
            setLiveStatus('connected');
            if (data.name) setLiveAgentName(String(data.name));
          } else if (data.name && !liveAgentName) {
            setLiveAgentName(String(data.name));
          }
          setMessages(prev => [
            ...prev,
            {
              role: 'assistant',
              content: String(data.text || ''),
              time: nowTime(),
            },
          ]);
        } else if (data.type === 'agent_joined' && data.name) {
          const incoming = String(data.name);
          setLiveStatus('connected');
          setLiveAgentName(incoming);
          // Append the "is here" line ONLY when this is the first
          // time we've ever announced THIS agent in this bot session.
          // Reads from a ref so reconnects (status briefly flips back
          // to 'waiting' before bouncing to 'connected') don't restack
          // the same line. A different agent name resets the gate so
          // a real handoff is still visible.
          if (liveAgentAnnouncedRef.current !== incoming) {
            liveAgentAnnouncedRef.current = incoming;
            setMessages(prev => [
              ...prev,
              {
                role: 'assistant',
                content: `_${incoming} from the team is here. Say hi._`,
                time: nowTime(),
              },
            ]);
          }
        } else if (data.type === 'typing') {
          // Customer-side "agent is typing" hint: the server relays
          // these but we no longer render an indicator on the customer
          // side (the live chat panel is compact; a typing dot would
          // compete with the small read/sent receipts). The frame is
          // still emitted by server-side typing handlers, so accepting
          // it here without action keeps the protocol forwards-compat
          // if a future UI wants to surface it.
        } else if (data.type === 'csat_request') {
          // Agent resolved the thread. Three things happen here:
          //
          //   1. Show the 5-star CSAT widget for this threadId. Only
          //      set if not already showing (a re-resolve shouldn't
          //      reset the user's mid-input rating).
          //   2. Tear down the live socket cleanly. We set
          //      liveDesiredRef=false BEFORE closing so the auto-
          //      reconnect loop doesn't immediately re-open against
          //      the resolved thread — that would create a phantom
          //      reconnect storm and a confusing UX where the
          //      customer sees themselves wired up to a resolved
          //      session that the agent already closed.
          //   3. Flip liveMode/liveStatus back to bot mode so the
          //      next click on "Talk to a human" creates a FRESH
          //      thread (findResumableSupportThread correctly skips
          //      resolved threads). Without this, enterLiveMode's
          //      first-line guard `if (liveMode) return` bails on
          //      the second click and the admin never sees the
          //      new request — the exact bug reported on 2026-05-13.
          const tid = String(data.threadId || '');
          if (tid) setCsatThreadId(prev => prev || tid);
          liveDesiredRef.current = false;
          liveAgentAnnouncedRef.current = null;
          closeLiveSocket('thread resolved');
          setLiveMode(false);
          setLiveStatus('idle');
          setLiveAgentName(null);
          setMessages(prev => [
            ...prev,
            {
              role: 'assistant',
              content: '_The agent marked this conversation as resolved. Rate the chat below, or click **Talk to a human** anytime to start a fresh session._',
              time: nowTime(),
            },
          ]);
        } else if (data.type === 'agent_left') {
          setLiveStatus('closed');
          setLiveAgentName(null);
          setMessages(prev => [
            ...prev,
            {
              role: 'assistant',
              content: '_Live agent left the chat. You can keep talking to Minica or send a message via Talk to a human._',
              time: nowTime(),
            },
          ]);
        }
      } catch { /* malformed frame — ignore */ }
    };

    ws.onerror = () => {
      // Transport-level error. Don't close yet — onclose will follow
      // and schedule the reconnect. We don't surface a noisy banner
      // here anymore — short blips reconnect transparently. A
      // sustained failure surfaces via the fallback timer above.
    };

    ws.onclose = (evt) => {
      liveWsRef.current = null;
      if (liveHeartbeatRef.current !== null) {
        window.clearInterval(liveHeartbeatRef.current);
        liveHeartbeatRef.current = null;
      }
      // ── Stop reconnecting on intentional close codes ──
      // 4000 = server cap-evicted us because a NEWER tab/connection
      // for this same customer email is now the active one. Without
      // this guard the OLDER tab keeps reconnecting in a 1s loop,
      // and the two tabs ping-pong forever (server keeps cap-evicting
      // whichever one was the previous "newer"). Symptom on the
      // server log: `Support chat: <email> connected as customer`
      // repeated dozens of times per minute. Symptom in the app:
      // admin's reply never lands because the customer's WS is in a
      // half-open state when the broadcast fires.
      // 1000 = clean close (we initiated). Don't reconnect — the
      // close came from us (exit/csat/unmount).
      const code = evt?.code;
      if (code === 4000) {
        console.info('[support-customer-ws] cap-evicted by newer tab — stopping reconnect');
        liveDesiredRef.current = false;
        // Best-effort UX: tell the customer their other tab won.
        // Renders one assistant line; safe to no-op if state has
        // already transitioned (e.g., bot panel closed).
        try {
          setLiveStatus('closed');
          setMessages(prev => [
            ...prev,
            {
              role: 'assistant',
              content: '_Switched to your other open chat. Close the other tab/window to continue here._',
              time: nowTime(),
            },
          ]);
        } catch { /* component already unmounted */ }
        return;
      }
      if (code === 1000) {
        // Clean close — we requested it (exit live, csat, unmount).
        return;
      }
      // Anything else (server idle timeout 4001, network blip, server
      // restart, NAT) — reconnect transparently. Server resends the
      // thread history and any new messages on the new socket so the
      // conversation appears uninterrupted.
      if (liveDesiredRef.current) {
        scheduleLiveReconnect(opts);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildWsUrl]);

  // Reconnect with exponential backoff + jitter. Cap at 30s; otherwise
  // a 6-attempt failure could sleep for ~4 minutes before retrying,
  // which feels broken on a flaky home wifi. After 30s we keep
  // retrying forever at 30s intervals — the customer wants to talk,
  // so we keep trying.
  const scheduleLiveReconnect = useCallback((opts: { email: string; name: string; isReconnect: boolean }) => {
    if (!liveDesiredRef.current) return;
    if (liveReconnectTimerRef.current !== null) return;   // already scheduled
    const attempt = liveAttemptRef.current;
    liveAttemptRef.current = attempt + 1;
    const base = Math.min(30_000, 1000 * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 500);
    const delay = base + jitter;
    liveReconnectTimerRef.current = window.setTimeout(() => {
      liveReconnectTimerRef.current = null;
      connectLiveSocket({ ...opts, isReconnect: true });
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enterLiveMode = useCallback(() => {
    if (liveMode) return;  // already in live mode
    if (liveWsRef.current) return;  // socket already open
    const email = currentUser?.email || handoffEmail || `anon_${Date.now()}@minicaai`;
    const name = currentUser?.name || handoffName || 'User';

    liveDesiredRef.current = true;
    liveAttemptRef.current = 0;
    setLiveMode(true);
    setLiveStatus('connecting');
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: '_Connecting you to a live human agent… one moment._',
        time: nowTime(),
      },
    ]);
    connectLiveSocket({ email, name, isReconnect: false });
  }, [buildWsUrl, connectLiveSocket, currentUser, handoffEmail, handoffName, liveMode]);

  // Cleanup live socket on unmount so a closed bot panel doesn't leave
  // a zombie connection on the server.
  useEffect(() => {
    return () => {
      closeLiveSocket('unmount');
    };
  }, [closeLiveSocket]);

  // ── Admin live inbox ──────────────────────────────────────────
  // For admin users: a separate view inside the bot panel that shows
  // connected customers + lets the admin reply to each. The admin
  // joins the same /ws/support WS as role='agent'; server already
  // routes customer→all-agents and agent→specific-customer (see
  // server/src/index.js:608+). We:
  //   - keep a per-customer message history in a Map
  //   - play a chime + browser-notification on new customer join
  //     and on new customer messages while the inbox tab is closed
  //   - persist nothing client-side (admin reopening means they only
  //     see customers currently online; server-side history is the
  //     follow-up task in #28's persistence phase)
  interface InboxCustomer {
    email: string;
    name: string;
    lastSeenAt: number;
    unread: number;
    // ── Thread metadata (added 2026-05-13 for inbox polish) ──
    // Populated from /inbox/threads on enterInboxMode + kept in sync
    // by WS event handlers. threadId is the DB UUID; status is the
    // current state of the thread (open/assigned/resolved); sla is
    // the green/yellow/red/gray classification the server computes
    // per-row in listOpenSupportThreads.
    threadId?: string;
    status?: 'open' | 'assigned' | 'resolved' | 'spam';
    sla?: 'green' | 'yellow' | 'red' | 'gray';
    tier?: string | null;
    initialQuestion?: string | null;
    // Live WS state. `online` flips to false on `customer_left` and
    // back to true on `customer_joined` — so the inbox can show a
    // gray "offline" dot during a transient disconnect without
    // dropping the customer from the list. Undefined = treat as
    // online (back-compat for entries seeded from REST snapshot
    // before this field existed).
    online?: boolean;
  }
  interface InboxMsg { from: 'agent' | 'customer'; text: string; time: string; }
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxCustomers, setInboxCustomers] = useState<Map<string, InboxCustomer>>(new Map());
  const [inboxActiveEmail, setInboxActiveEmail] = useState<string | null>(null);
  const [inboxMessages, setInboxMessages] = useState<Map<string, InboxMsg[]>>(new Map());
  const [inboxInput, setInboxInput] = useState('');
  const [inboxConnected, setInboxConnected] = useState(false);
  // Email of the customer the admin is actively viewing whose `typing`
  // event is currently true. Single-string (not Map) because the admin
  // can only be in ONE active conversation; typing events for other
  // threads are ignored to keep the indicator unambiguous.
  const [inboxTypingEmail, setInboxTypingEmail] = useState<string | null>(null);
  // Live status of the root agent WebSocket. App.tsx dispatches
  // 'minicaai-support-status' on open/close so the inbox header can
  // show a green/red dot tied to the ACTUAL socket, not just the REST
  // snapshot success.
  const [inboxWsStatus, setInboxWsStatus] = useState<'online' | 'offline' | 'connecting'>('connecting');
  // Per-agent presence row from GET /inbox/presence. Carries the
  // ntfy.sh topic + a ready-to-paste subscribe URL so the admin can
  // wire up phone push without leaving the inbox. ntfy_verified_at +
  // ntfy_last_alert_at drive the "✓ Push active · last alert Nm ago"
  // status pill (server marks verified_at on /test-alert success and
  // last_alert_at on every production push, so a re-installed app
  // doesn't lose the verification state).
  const [inboxPresence, setInboxPresence] = useState<{
    ntfy_topic: string | null;
    ntfy_subscribe_url: string | null;
    notification_prefs: Record<string, unknown>;
    ntfy_verified_at: number | null;
    ntfy_last_alert_at: number | null;
  } | null>(null);
  // Test-alert status — drives the "Send test" button's transient
  // confirmation state. 'sending' shows a spinner, 'sent' shows a
  // green check for 2s, 'failed' shows a red x for 4s.
  const [testAlertStatus, setTestAlertStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [topicCopied, setTopicCopied] = useState(false);
  // Push-setup card collapse — persisted so a setup-complete admin
  // doesn't see the expanded card every time they open the inbox.
  // First-open default: expanded (so they actually configure it).
  const [pushCardCollapsed, setPushCardCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('minicaai-push-card-collapsed') === '1'; }
    catch { return false; }
  });
  // Inbox sidebar collapse — gives the admin a full-width chat surface
  // when they're focused on one conversation. Mirrors the main app's
  // conversation-sidebar pattern (3-line hamburger top-left toggles a
  // 240px panel). Persisted so the layout sticks across sessions; the
  // default is EXPANDED on first run so the customer list is discoverable.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('minicaai-inbox-sidebar-collapsed') === '1'; }
    catch { return false; }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('minicaai-inbox-sidebar-collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);
  const inboxActiveRef = useRef<string | null>(null);
  useEffect(() => { inboxActiveRef.current = inboxActiveEmail; }, [inboxActiveEmail]);
  // Scrolling container for the active thread's messages. We
  // auto-stick to the bottom on every new message — but only when
  // the admin is already near the bottom, so a manual scroll-up
  // to read history isn't yanked back.
  const inboxScrollRef = useRef<HTMLDivElement | null>(null);
  // Latest snapshot of the customers Map, kept in a ref so effects
  // that need to look up threadId/etc don't have to depend on the
  // Map itself (which would cause them to re-fire on every customer
  // join, message, and SLA recompute — the historical bug that wiped
  // optimistic message appends every few seconds).
  const inboxCustomersRef = useRef<Map<string, InboxCustomer>>(new Map());
  useEffect(() => { inboxCustomersRef.current = inboxCustomers; }, [inboxCustomers]);

  // Total unread across all customers — drives the header badge.
  const inboxUnreadTotal = useMemo(() => {
    let n = 0;
    for (const c of inboxCustomers.values()) n += c.unread;
    return n;
  }, [inboxCustomers]);

  // Chime audio for admin alerts. Synthesized via WebAudio so we don't
  // ship an asset. Two-tone, ~280ms, kept quiet so it isn't startling.
  const playInboxChime = useCallback(() => {
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext);
      if (!AC) return;
      const ctx = new AC();
      const playTone = (freq: number, startAt: number, durMs: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, ctx.currentTime + startAt);
        gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startAt + durMs / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + startAt);
        osc.stop(ctx.currentTime + startAt + durMs / 1000 + 0.05);
      };
      playTone(880, 0, 140);
      playTone(1320, 0.10, 180);
      window.setTimeout(() => { try { ctx.close(); } catch { /* already closed */ } }, 500);
    } catch { /* WebAudio blocked or unsupported */ }
  }, []);

  // ── Inbox enter/exit ──
  // The Inbox no longer owns its own WebSocket. App.tsx's root-level
  // background hook is the SOLE agent WS for the whole app session
  // (so a flapping connection-eviction loop between the panel-WS and
  // root-WS can't happen — server enforces SUPPORT_MAX_PER_USER=1).
  // The Inbox now:
  //   • subscribes to the root WS's broadcasts via the DOM CustomEvent
  //     'minicaai-support-event' (see useEffect below);
  //   • loads its initial state from the REST endpoint
  //     /api/v1/support/inbox/threads (which is DB-backed, so the
  //     queue survives server restarts);
  //   • sends outbound messages via a 'minicaai-support-send' DOM
  //     event that the root hook forwards to the open socket.
  // exitInboxMode is now a pure state-clear; the root WS stays alive
  // (we still want native alerts when the panel is closed).
  const exitInboxMode = useCallback(() => {
    setInboxOpen(false);
    setInboxActiveEmail(null);
  }, []);

  const enterInboxMode = useCallback(() => {
    setInboxOpen(true);
    // Tell Electron main to clear the tray badge + dock counter
    // — admin is looking at the inbox right now.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI?.send?.('support:clear-unread');
    } catch { /* not in Electron — fine */ }

    // Fetch the persisted inbox snapshot. Even if the root WS is
    // mid-reconnect, the REST endpoint reflects the DB truth.
    (async () => {
      try {
        const token = readLiveToken();
        if (!token) return;
        const r = await fetch(`${base}/api/v1/support/inbox/threads?limit=100`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const data = await r.json();
        const threads: Array<{
          id: string; customer_email: string; customer_name: string | null;
          customer_tier: string | null;
          status: 'open' | 'assigned' | 'resolved' | 'spam';
          assigned_agent_email: string | null;
          last_message_text: string | null; last_message_role: string | null;
          last_customer_message_at: number | null;
          unread_from_customer: number;
          sla: 'green' | 'yellow' | 'red' | 'gray';
          initial_question: string | null;
        }> = data.threads || [];
        // SYNC the REST snapshot — it's authoritative for "what
        // threads currently exist". Add new entries from the server,
        // refresh existing entries with the latest persisted state,
        // and DROP local entries the server no longer has (e.g., a
        // thread that was deleted out-of-band). Without the drop step,
        // stale entries linger and clicking one 404s every per-thread
        // REST call (history fetch, claim, resolve, ai-assist).
        //
        // The one carve-out: keep entries whose `lastSeenAt` was
        // updated within the last 30s. Those are likely from a
        // customer_joined / message frame that arrived AFTER the
        // server returned this snapshot — dropping them would re-create
        // the "lag to see customer" symptom for a customer who joined
        // mid-fetch.
        setInboxCustomers(prev => {
          const restEmails = new Set(threads.map(t => t.customer_email));
          const next = new Map<string, InboxCustomer>();
          // Carry forward live-only entries that arrived in the last
          // 30s — they're real, just newer than the snapshot.
          const recencyCutoff = Date.now() - 30_000;
          for (const [em, c] of prev) {
            if (!restEmails.has(em) && c.lastSeenAt > recencyCutoff) {
              next.set(em, c);
            }
          }
          // Apply REST snapshot — authoritative for everything in it.
          for (const t of threads) {
            const e = t.customer_email;
            const existing = prev.get(e);
            next.set(e, {
              email: e,
              // Keep a richer existing name if one was already captured
              // from a live frame (the WS payload often carries the
              // customer's full name; REST has only the persisted one).
              name: existing?.name && existing.name !== existing.email ? existing.name : (t.customer_name || e),
              lastSeenAt: t.last_customer_message_at || existing?.lastSeenAt || Date.now(),
              unread: t.unread_from_customer || 0,
              threadId: t.id,
              status: t.status,
              sla: t.sla,
              tier: t.customer_tier,
              initialQuestion: t.initial_question,
              online: existing?.online ?? true,
            });
          }
          return next;
        });
        // Drop messages for any customer that's no longer in the inbox.
        // Otherwise, reopening the panel after a thread is deleted
        // would still hold the message history in memory forever.
        setInboxMessages(prev => {
          const restEmails = new Set(threads.map(t => t.customer_email));
          const next = new Map(prev);
          for (const em of next.keys()) {
            if (!restEmails.has(em)) {
              // Same recency carve-out: keep messages for live-only
              // customers added after the snapshot.
              const cust = inboxCustomersRef.current.get(em);
              if (!cust || cust.lastSeenAt < Date.now() - 30_000) {
                next.delete(em);
              }
            }
          }
          return next;
        });
        // If the admin's currently-selected thread is no longer in the
        // server snapshot, clear the selection so they're not staring
        // at a dead thread that 404s every action.
        if (inboxActiveRef.current && !threads.some(t => t.customer_email === inboxActiveRef.current)) {
          setInboxActiveEmail(null);
        }
        setInboxMessages(prev => {
          const next = new Map(prev);
          for (const t of threads) {
            const e = t.customer_email;
            // Only seed if we have NO local messages for this customer.
            // Otherwise the per-thread GET (fired on thread-click) will
            // load the full history; the one-line seed here would
            // otherwise replace richer state and cause flicker.
            if (!next.has(e) && t.last_message_text) {
              next.set(e, [{
                from: t.last_message_role === 'agent' ? 'agent' : 'customer',
                text: t.last_message_text,
                time: t.last_customer_message_at
                  ? new Date(t.last_customer_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : nowTime(),
              }]);
            }
          }
          return next;
        });
        setInboxConnected(true);
      } catch { /* offline — root WS will refill state when it reconnects */ }
    })();

    // Also fetch the admin's own presence row so the phone-push
    // setup card can render the ntfy topic. Lazily created server-
    // side on first call, so even brand-new admins get a topic.
    (async () => {
      try {
        const token = readLiveToken();
        if (!token) return;
        const r = await fetch(`${base}/api/v1/support/inbox/presence`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        setInboxPresence({
          ntfy_topic: d.ntfy_topic || null,
          ntfy_subscribe_url: d.ntfy_subscribe_url || null,
          notification_prefs: d.notification_prefs || {},
          ntfy_verified_at: d.ntfy_verified_at ?? null,
          ntfy_last_alert_at: d.ntfy_last_alert_at ?? null,
        });
      } catch { /* presence is non-critical — inbox still works without it */ }
    })();
  }, [base, readLiveToken]);

  // ── Phone-push helpers ──
  // Copies the TOPIC NAME (just the slug, e.g. "minicaai-abc123") —
  // NOT the full URL. ntfy's mobile Subscribe input only accepts the
  // topic name; pasting the full URL leaves the Subscribe button
  // disabled because the URL fails their `[A-Za-z0-9_\-]+` regex.
  // The publish URL is shown separately below for reference.
  const copyTopicUrl = useCallback(async () => {
    const topic = inboxPresence?.ntfy_topic;
    if (!topic) return;
    try {
      await navigator.clipboard.writeText(String(topic));
      setTopicCopied(true);
      window.setTimeout(() => setTopicCopied(false), 1800);
    } catch {
      // Clipboard API blocked (e.g. non-HTTPS browser context). Fall
      // back to selecting an off-screen <input> and document.execCommand.
      try {
        const el = document.createElement('input');
        el.value = String(topic);
        el.style.position = 'fixed';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setTopicCopied(true);
        window.setTimeout(() => setTopicCopied(false), 1800);
      } catch { /* clipboard genuinely unavailable — UX hint will tell the admin */ }
    }
  }, [inboxPresence]);

  const sendTestAlert = useCallback(async () => {
    setTestAlertStatus('sending');
    try {
      const token = readLiveToken();
      if (!token) { setTestAlertStatus('failed'); return; }
      const r = await fetch(`${base}/api/v1/support/inbox/test-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        setTestAlertStatus('sent');
        // Optimistically update presence so the card flips from
        // "Not yet verified" → "✓ Push active" without a refetch.
        // Server has marked verified_at to the same timestamp.
        setInboxPresence(prev => prev ? {
          ...prev,
          ntfy_verified_at: d.verified_at || Date.now(),
          ntfy_last_alert_at: d.verified_at || Date.now(),
        } : prev);
        // Collapse the setup card once verified — admin doesn't need
        // to see the install/subscribe steps after they're done. They
        // can still expand it via the chevron to re-test.
        try { localStorage.setItem('minicaai-push-card-collapsed', '1'); } catch {}
        setPushCardCollapsed(true);
        window.setTimeout(() => setTestAlertStatus('idle'), 2200);
      } else {
        setTestAlertStatus('failed');
        window.setTimeout(() => setTestAlertStatus('idle'), 4000);
      }
    } catch {
      setTestAlertStatus('failed');
      window.setTimeout(() => setTestAlertStatus('idle'), 4000);
    }
  }, [base, readLiveToken]);

  // Format "last alert N ago" — small helper so the card stays clean.
  const formatRelativeTime = useCallback((ts: number | null | undefined): string => {
    if (!ts) return '';
    const diffMs = Date.now() - ts;
    if (diffMs < 60_000) return 'just now';
    const min = Math.floor(diffMs / 60_000);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }, []);

  // ── AI-assist (GPT-5.6) — draft + polish for the agent ──
  // Streams from POST /inbox/threads/:id/ai-assist. assistMode is
  // null when idle; 'draft' or 'polish' while streaming or
  // displaying a suggestion. assistText accumulates the SSE deltas.
  // assistError holds a short message for the UI to display below
  // the suggestion box on failure.
  const [assistMode, setAssistMode] = useState<'draft' | 'polish' | null>(null);
  const [assistText, setAssistText] = useState<string>('');
  const [assistStreaming, setAssistStreaming] = useState<boolean>(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const assistAbortRef = useRef<AbortController | null>(null);

  const discardAssistSuggestion = useCallback(() => {
    if (assistAbortRef.current) {
      try { assistAbortRef.current.abort(); } catch {}
      assistAbortRef.current = null;
    }
    setAssistMode(null);
    setAssistText('');
    setAssistStreaming(false);
    setAssistError(null);
  }, []);

  const useAssistSuggestion = useCallback(() => {
    if (!assistText) return;
    setInboxInput(assistText.trim());
    discardAssistSuggestion();
  }, [assistText, discardAssistSuggestion]);

  const requestAssist = useCallback(async (mode: 'draft' | 'polish') => {
    const cust = inboxActiveEmail ? inboxCustomers.get(inboxActiveEmail) : null;
    if (!cust?.threadId) return;
    if (mode === 'polish' && !inboxInput.trim()) return;
    // Cancel any in-flight stream before starting a new one.
    if (assistAbortRef.current) {
      try { assistAbortRef.current.abort(); } catch {}
    }
    const controller = new AbortController();
    assistAbortRef.current = controller;
    setAssistMode(mode);
    setAssistText('');
    setAssistStreaming(true);
    setAssistError(null);

    try {
      const token = readLiveToken();
      if (!token) {
        setAssistError('Sign in required.');
        setAssistStreaming(false);
        return;
      }
      const resp = await fetch(`${base}/api/v1/support/inbox/threads/${cust.threadId}/ai-assist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          mode,
          draftText: mode === 'polish' ? inboxInput : undefined,
        }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        let msg = 'AI assist is unavailable right now.';
        // 404 → the thread is gone from the server (deleted, purged,
        // or it was a stale local entry). Self-heal: drop the entry,
        // surface a clear inline message.
        if (resp.status === 404) {
          msg = 'This conversation no longer exists. Pick another customer from the sidebar.';
          const dead = inboxActiveEmail;
          if (dead) {
            setInboxCustomers(prev => {
              if (!prev.has(dead)) return prev;
              const next = new Map(prev);
              next.delete(dead);
              return next;
            });
            setInboxMessages(prev => {
              if (!prev.has(dead)) return prev;
              const next = new Map(prev);
              next.delete(dead);
              return next;
            });
            if (inboxActiveRef.current === dead) setInboxActiveEmail(null);
          }
        } else {
          try {
            const j = await resp.json();
            if (j?.error) msg = j.error;
          } catch { /* not JSON */ }
        }
        setAssistError(msg);
        setAssistStreaming(false);
        return;
      }

      // Parse SSE manually (small reader; the openai SDK adds heavy
      // deps for browser use and we only need text/event-stream's
      // `data:` lines). Each event is `data: {...}\n\n`; split on
      // double newline, take the JSON payload.
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let saw = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const json = line.slice(5).trim();
            if (!json) continue;
            try {
              const obj = JSON.parse(json);
              if (typeof obj.delta === 'string') {
                saw = true;
                setAssistText(prev => prev + obj.delta);
              }
              if (obj.error) {
                setAssistError(String(obj.error));
              }
              if (obj.done) {
                setAssistStreaming(false);
              }
            } catch { /* malformed frame — keep going */ }
          }
        }
      }
      // Stream ended without explicit done — flip streaming off
      // so the UI shows Use/Discard buttons.
      setAssistStreaming(false);
      if (!saw && !assistError) {
        setAssistError('The model returned an empty reply. Try again, or write the message yourself.');
      }
    } catch (err) {
      const ae = err as { name?: string };
      if (ae?.name === 'AbortError') {
        // Caller-initiated abort (new stream or discard) — clean exit.
        return;
      }
      setAssistError('Network blip — try again.');
      setAssistStreaming(false);
    }
  }, [assistError, base, inboxActiveEmail, inboxCustomers, inboxInput, readLiveToken]);

  // If the admin switches threads OR closes the inbox, discard any
  // in-flight suggestion so it doesn't appear under the new thread.
  useEffect(() => {
    return () => {
      if (assistAbortRef.current) {
        try { assistAbortRef.current.abort(); } catch {}
        assistAbortRef.current = null;
      }
    };
  }, [inboxActiveEmail, inboxOpen]);

  const togglePushCard = useCallback(() => {
    setPushCardCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('minicaai-push-card-collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  // ── Live updates from the root agent WebSocket ──
  // The root hook (in App.tsx) dispatches 'minicaai-support-event'
  // CustomEvents for every WS frame. We subscribe at all times (not
  // only while the inbox is open) so that customer_joined / message
  // events that arrive while the panel is closed still update state
  // — otherwise opening the inbox shows a blank panel until the REST
  // fetch completes, which feels like "lag". The chime + animations
  // stay gated on inboxOpen so we don't make noise while hidden.
  //
  // Outbound-fanout (other admin tabs' replies): server now sends an
  // outbound:true frame to every agent socket EXCEPT the sender. We
  // render those as 'agent' messages in the inbox so two admin tabs
  // viewing the same thread stay in sync without a refetch.
  useEffect(() => {
    if (!isAdminRole) return;
    const onSupportEvent = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'customer_joined') {
        const em = String(data.email || '').toLowerCase();
        if (!em) return;
        const n = String(data.name || em || 'Customer');
        setInboxCustomers(prev => {
          const next = new Map(prev);
          const existing = next.get(em);
          next.set(em, {
            email: em,
            name: existing?.name && existing.name !== existing.email ? existing.name : n,
            lastSeenAt: Date.now(),
            unread: existing?.unread || 0,
            threadId: data.threadId || existing?.threadId,
            // Preserve assigned/resolved; otherwise this is open.
            status: existing?.status === 'assigned' ? 'assigned'
                  : existing?.status === 'resolved' ? 'resolved'
                  : 'open',
            sla: existing?.sla || 'green',
            tier: existing?.tier ?? null,
            initialQuestion: existing?.initialQuestion ?? null,
          });
          return next;
        });
      } else if (data.type === 'message') {
        // For inbound (customer→agent) the server puts the customer's
        // email in `from`. For outbound fanout (co-admin's reply that
        // this socket should mirror) `from` is the customer email AND
        // `outbound:true` is set.
        const em = String(data.from || '').toLowerCase();
        if (!em) return;
        const text = String(data.text || '');
        const isOutbound = data.outbound === true;
        setInboxMessages(prev => {
          const next = new Map(prev);
          const arr = next.get(em) ? next.get(em)!.slice() : [];
          arr.push({
            from: isOutbound ? 'agent' : 'customer',
            text,
            time: data.at ? new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : nowTime(),
          });
          next.set(em, arr);
          return next;
        });
        // Don't bump unread on outbound — it's the agent's own (or
        // a co-admin's) reply, not new customer activity.
        if (!isOutbound) {
          setInboxCustomers(prev => {
            const next = new Map(prev);
            const existing = next.get(em);
            if (existing) {
              next.set(em, {
                ...existing,
                lastSeenAt: Date.now(),
                unread: (inboxActiveRef.current === em && inboxOpen) ? 0 : existing.unread + 1,
              });
            } else {
              next.set(em, { email: em, name: data.name || em, lastSeenAt: Date.now(), unread: 1 });
            }
            return next;
          });
        }
        // Chime fires only when the inbox panel is OPEN and the admin
        // isn't viewing this thread. Native OS notification + tray
        // badge are handled by the root WS hook in App.tsx regardless.
        if (!isOutbound && inboxOpen && inboxActiveRef.current !== em) {
          playInboxChime();
        }
      } else if (data.type === 'customer_left') {
        // The thread is alive in the DB; the customer just dropped
        // their socket (tab background, WiFi blip). Don't delete —
        // mark offline and keep the admin's active selection so a
        // brief disconnect doesn't yank focus off the conversation.
        const em = String(data.email || '').toLowerCase();
        if (!em) return;
        setInboxCustomers(prev => {
          const existing = prev.get(em);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(em, { ...existing, online: false });
          return next;
        });
      } else if (data.type === 'typing') {
        const em = String(data.from || '').toLowerCase();
        if (!em) return;
        if (inboxActiveRef.current !== em) return;
        setInboxTypingEmail(data.isTyping ? em : null);
      }
    };
    window.addEventListener('minicaai-support-event', onSupportEvent as EventListener);
    return () => window.removeEventListener('minicaai-support-event', onSupportEvent as EventListener);
  }, [isAdminRole, inboxOpen, playInboxChime]);

  // Mirror the root WS status (open/closed) into our local indicator
  // so the inbox header dot reflects reality, not just the last REST
  // snapshot result. Defaults to 'connecting' until the first frame.
  useEffect(() => {
    if (!isAdminRole) return;
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const s = detail?.status;
      if (s === 'online' || s === 'offline' || s === 'connecting') {
        setInboxWsStatus(s);
      }
    };
    window.addEventListener('minicaai-support-status', onStatus as EventListener);
    return () => window.removeEventListener('minicaai-support-status', onStatus as EventListener);
  }, [isAdminRole]);

  // Clear typing indicator if the admin switches threads or the
  // customer goes idle. (The server only sends typing:false on a
  // proper stop; this guard catches the case where the customer
  // navigates away without sending a stop.)
  useEffect(() => {
    if (!inboxTypingEmail) return;
    const t = window.setTimeout(() => setInboxTypingEmail(null), 4_000);
    return () => window.clearTimeout(t);
  }, [inboxTypingEmail]);

  // Auto-scroll the active thread to the bottom on new messages.
  // We only stick to the bottom if the admin is already within
  // ~80px of the bottom — that way a deliberate scroll-up to read
  // earlier context isn't fought every time a new message lands.
  useEffect(() => {
    if (!inboxOpen || !inboxActiveEmail) return;
    const el = inboxScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      // Defer a tick so the new message has rendered into the DOM.
      window.requestAnimationFrame(() => {
        if (inboxScrollRef.current) {
          inboxScrollRef.current.scrollTop = inboxScrollRef.current.scrollHeight;
        }
      });
    }
  }, [inboxMessages, inboxActiveEmail, inboxOpen]);

  // Reset typing indicator + scroll on thread switch so a stale
  // "typing…" line from a previous customer doesn't bleed over,
  // and the new thread opens at the bottom (most recent message).
  useEffect(() => {
    setInboxTypingEmail(null);
    window.requestAnimationFrame(() => {
      if (inboxScrollRef.current) {
        inboxScrollRef.current.scrollTop = inboxScrollRef.current.scrollHeight;
      }
    });
  }, [inboxActiveEmail]);

  // Re-classify SLA color for every customer every 5s while the inbox
  // is open. SLA is a function of time-since-last-customer-message —
  // it stays cheap (Map.size operations, no fetch). The server's
  // classification is authoritative on hard refresh; this tick is the
  // smooth in-between so a row doesn't sit "green" for 10 minutes
  // while time actually passed.
  useEffect(() => {
    if (!inboxOpen) return;
    const recompute = () => {
      setInboxCustomers(prev => {
        const next = new Map(prev);
        let changed = false;
        for (const [em, c] of next) {
          if (c.status === 'resolved') {
            if (c.sla !== 'gray') { next.set(em, { ...c, sla: 'gray' }); changed = true; }
            continue;
          }
          // Agent-replied state — last activity in messages array is
          // an agent message → SLA is gray (ball is in customer's court).
          const msgs = inboxMessages.get(em) || [];
          const last = msgs[msgs.length - 1];
          if (last && last.from === 'agent') {
            if (c.sla !== 'gray') { next.set(em, { ...c, sla: 'gray' }); changed = true; }
            continue;
          }
          const waitMs = Date.now() - (c.lastSeenAt || 0);
          let newSla: InboxCustomer['sla'] = 'green';
          if (waitMs >= 120_000) newSla = 'red';
          else if (waitMs >= 30_000) newSla = 'yellow';
          if (c.sla !== newSla) {
            next.set(em, { ...c, sla: newSla });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    recompute();
    const id = window.setInterval(recompute, 5_000);
    return () => window.clearInterval(id);
  }, [inboxOpen, inboxMessages]);

  // Claim a thread — marks it 'assigned' on the server, optimistic
  // UI update so the admin sees the chip flip immediately. The
  // server's auto-claim on first reply also handles this, but the
  // explicit button lets an admin say "I'll take this one" without
  // sending a reply yet (prevents another admin from racing in).
  const claimThread = useCallback(async (customerEmail: string) => {
    const cust = inboxCustomers.get(customerEmail);
    if (!cust?.threadId) return;
    setInboxCustomers(prev => {
      const c = prev.get(customerEmail);
      if (!c) return prev;
      const next = new Map(prev);
      next.set(customerEmail, { ...c, status: 'assigned' });
      return next;
    });
    try {
      const token = readLiveToken();
      if (!token) return;
      const r = await fetch(`${base}/api/v1/support/inbox/threads/${cust.threadId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (r.status === 404) {
        // Stale local entry — server has no such thread. Drop it so
        // every subsequent action stops 404-ing.
        console.warn(`[inbox] claim 404 — dropping stale entry for ${customerEmail}`);
        setInboxCustomers(prev => {
          if (!prev.has(customerEmail)) return prev;
          const next = new Map(prev);
          next.delete(customerEmail);
          return next;
        });
        setInboxMessages(prev => {
          if (!prev.has(customerEmail)) return prev;
          const next = new Map(prev);
          next.delete(customerEmail);
          return next;
        });
        if (inboxActiveRef.current === customerEmail) setInboxActiveEmail(null);
        return;
      }
      if (r.status === 409) {
        // Someone else got there first. Reload from server so the UI
        // shows the truth (which admin owns the thread now).
        const j = await r.json().catch(() => ({}));
        console.warn('[inbox] claim 409:', j.currentAgent);
        // Revert optimistic update to whatever server says — easiest
        // path is to re-fetch the inbox.
        enterInboxMode();
      }
    } catch (e) {
      console.warn('[inbox] claim failed:', (e as Error).message);
    }
  }, [base, inboxCustomers, readLiveToken, enterInboxMode]);

  // Resolve a thread — closes it out. Server fires a 'csat_request'
  // event to the customer (if connected) so they can rate the
  // resolution; the customer's bot panel renders the 5-star widget
  // and POSTs to /inbox/threads/:id/csat on submit.
  const resolveThread = useCallback(async (customerEmail: string) => {
    const cust = inboxCustomers.get(customerEmail);
    if (!cust?.threadId) return;
    setInboxCustomers(prev => {
      const c = prev.get(customerEmail);
      if (!c) return prev;
      const next = new Map(prev);
      next.set(customerEmail, { ...c, status: 'resolved', sla: 'gray' });
      return next;
    });
    try {
      const token = readLiveToken();
      if (!token) return;
      const r = await fetch(`${base}/api/v1/support/inbox/threads/${cust.threadId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (r.status === 404) {
        // Stale local entry — server has no such thread. Drop it.
        console.warn(`[inbox] resolve 404 — dropping stale entry for ${customerEmail}`);
        setInboxCustomers(prev => {
          if (!prev.has(customerEmail)) return prev;
          const next = new Map(prev);
          next.delete(customerEmail);
          return next;
        });
        setInboxMessages(prev => {
          if (!prev.has(customerEmail)) return prev;
          const next = new Map(prev);
          next.delete(customerEmail);
          return next;
        });
        if (inboxActiveRef.current === customerEmail) setInboxActiveEmail(null);
      }
    } catch (e) {
      console.warn('[inbox] resolve failed:', (e as Error).message);
    }
  }, [base, inboxCustomers, readLiveToken]);

  // Listen for native-notification deeplinks from Electron main. When
  // admin clicks an OS notification, we open the inbox AND switch to
  // the specific customer's thread automatically.
  useEffect(() => {
    const onDeeplink = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      setInboxOpen(true);
      if (detail.customerEmail) {
        setInboxActiveEmail(String(detail.customerEmail));
      }
    };
    window.addEventListener('minicaai-support-deeplink', onDeeplink as EventListener);
    return () => window.removeEventListener('minicaai-support-deeplink', onDeeplink as EventListener);
  }, []);

  // Notify Electron main when the admin focuses a specific thread —
  // clears the per-thread debounce so the NEXT alert from that
  // customer (after they re-engage) fires immediately rather than
  // waiting out the suppression window.
  useEffect(() => {
    if (!inboxActiveEmail) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI?.send?.('support:thread-viewed', { threadId: inboxActiveEmail });
    } catch { /* not in Electron */ }
  }, [inboxActiveEmail]);

  // Fetch the FULL thread message history when admin SWITCHES to a
  // different customer. This fires ONCE per thread-switch, not on
  // every customer-Map mutation — the prior version had
  // `inboxCustomers` in the dep array, which made this effect re-run
  // (and OVERWRITE inboxMessages) every time another customer joined,
  // sent a message, or the 5s SLA recompute flipped a color. That
  // wiped optimistic agent appends and any live message that arrived
  // between the WS event and the GET completing — the symptom
  // reported as "messages not reflecting after claim".
  //
  // Lookup of threadId is via the ref so the effect doesn't subscribe
  // to inboxCustomers changes. The MERGE policy below preserves any
  // live append that arrived after the fetch started.
  const activeThreadIdForFetch = useMemo(() => {
    if (!inboxActiveEmail) return null;
    return inboxCustomersRef.current.get(inboxActiveEmail)?.threadId || null;
  // We intentionally include inboxCustomers in the dep so the memo
  // recomputes when the customer's threadId becomes known (e.g. REST
  // snapshot landed after click). The effect below does NOT depend
  // on inboxCustomers — it depends on this primitive string.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxActiveEmail, inboxCustomers]);

  useEffect(() => {
    if (!inboxActiveEmail || !activeThreadIdForFetch) return;
    const threadId = activeThreadIdForFetch;
    const activeEmail = inboxActiveEmail;
    let cancelled = false;
    (async () => {
      try {
        const token = readLiveToken();
        if (!token) return;
        const r = await fetch(`${base}/api/v1/support/inbox/threads/${threadId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        // Self-heal a stale local entry: if the server says this
        // thread doesn't exist, drop it from our inbox so the admin
        // doesn't keep clicking it and 404-ing every action (claim,
        // resolve, ai-assist all key on the same id). Common after
        // out-of-band thread cleanup (probe runs, manual DB cleanup,
        // resolved-then-purged threads).
        if (r.status === 404) {
          console.warn(`[inbox] thread ${threadId} returned 404 — dropping stale local entry for ${activeEmail}`);
          setInboxCustomers(prev => {
            if (!prev.has(activeEmail)) return prev;
            const next = new Map(prev);
            next.delete(activeEmail);
            return next;
          });
          setInboxMessages(prev => {
            if (!prev.has(activeEmail)) return prev;
            const next = new Map(prev);
            next.delete(activeEmail);
            return next;
          });
          if (inboxActiveRef.current === activeEmail) setInboxActiveEmail(null);
          return;
        }
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const msgs: Array<{ role: string; text: string; at: number }> = data.messages || [];
        // Only render messages from customer/agent — system + bot
        // messages clutter the chat panel and aren't part of the
        // back-and-forth conversation.
        const fromServer: InboxMsg[] = msgs
          .filter(m => m.role === 'customer' || m.role === 'agent')
          .map(m => ({
            from: m.role === 'agent' ? 'agent' : 'customer',
            text: String(m.text || ''),
            time: m.at ? new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : nowTime(),
          }));
        // MERGE: trust the server's history as the base, then append
        // any message currently in local state whose text+from combo
        // isn't already in the server list. This keeps optimistic
        // sends and live frames that arrived during the round-trip.
        setInboxMessages(prev => {
          const local = prev.get(activeEmail) || [];
          const serverKeys = new Set(fromServer.map(m => `${m.from}::${m.text}`));
          const extras = local.filter(m => !serverKeys.has(`${m.from}::${m.text}`));
          const merged = [...fromServer, ...extras];
          const next = new Map(prev);
          next.set(activeEmail, merged);
          return next;
        });
        // Also tell the server "I just looked at this thread" so the
        // unread badge on the customer's side flips to "read".
        try {
          fetch(`${base}/api/v1/support/inbox/threads/${threadId}/mark-read`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch { /* non-critical */ }
      } catch { /* offline; live events will repopulate */ }
    })();
    return () => { cancelled = true; };
  }, [base, inboxActiveEmail, activeThreadIdForFetch, readLiveToken]);

  const sendInboxMessage = useCallback(() => {
    const text = inboxInput.trim();
    if (!text || !inboxActiveEmail) {
      console.info('[support-inbox-send] BAILED', { hasText: !!text, inboxActiveEmail });
      return;
    }
    console.info('[support-inbox-send] dispatching', { to: inboxActiveEmail, textPreview: text.slice(0, 40) });
    // Route through the root WebSocket via the event-bus bridge in
    // App.tsx — see the `onSendRequest` listener inside the
    // SUPPORT AGENT BACKGROUND CHANNEL useEffect. If the socket is
    // not connected, the bridge silently drops; the optimistic UI
    // append below will still show the agent's message, but the
    // customer won't receive it. We rely on the heartbeat + reconnect
    // logic to recover the socket within a few seconds at worst.
    try {
      window.dispatchEvent(new CustomEvent('minicaai-support-send', {
        detail: { type: 'message', to: inboxActiveEmail, text },
      }));
    } catch { return; }
    setInboxMessages(prev => {
      const next = new Map(prev);
      const arr = next.get(inboxActiveEmail) ? next.get(inboxActiveEmail)!.slice() : [];
      arr.push({ from: 'agent', text, time: nowTime() });
      next.set(inboxActiveEmail, arr);
      return next;
    });
    setInboxInput('');
  }, [inboxActiveEmail, inboxInput]);

  // Clear unread count when admin opens a customer thread.
  useEffect(() => {
    if (!inboxActiveEmail) return;
    setInboxCustomers(prev => {
      const existing = prev.get(inboxActiveEmail);
      if (!existing || existing.unread === 0) return prev;
      const next = new Map(prev);
      next.set(inboxActiveEmail, { ...existing, unread: 0 });
      return next;
    });
  }, [inboxActiveEmail, inboxMessages]);

  // ── Step-up reauth submit ────────────────────────────────────
  // POSTs {password, intent} to /api/v1/support/reauth-execute. On
  // success: swap the JWT in localStorage, fire the auth-changed
  // event so tier probes re-run, append the result's friendly message
  // as the next assistant turn, clear pendingStepUp. On failure:
  // surface the reason inline next to the password field (this is
  // ONE of two places we DO show an error string to the admin — a
  // wrong-password attempt is a legitimate user action that needs
  // explicit feedback, not a tool failure).
  const submitStepUp = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingStepUp || stepUpStatus === 'submitting') return;
    const pwd = stepUpPassword;
    if (!pwd) { setStepUpError('Enter your password.'); return; }
    setStepUpStatus('submitting');
    setStepUpError(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const liveToken = readLiveToken();
      if (liveToken) headers.Authorization = `Bearer ${liveToken}`;
      const res = await fetch(`${base}/api/v1/support/reauth-execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: pwd, intent: pendingStepUp.intent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 401 = bad password (only field the admin can fix here). All
        // other server-side problems (500, etc.) are surfaced as
        // generic so we don't leak server internals to chat.
        const msg = res.status === 401
          ? (data?.error || 'Incorrect password — try again.')
          : 'Reauth couldn\'t complete. Please try the action again.';
        setStepUpStatus('error');
        setStepUpError(msg);
        return;
      }
      // Swap the JWT in localStorage so the next tier probe + chat
      // POST sees stepUp=true. licenseService's own emitAuthChange
      // path isn't reachable from here (no DI), so we do the side-
      // effects inline.
      if (data?.token) {
        try {
          window.localStorage.setItem('minicaai_token', String(data.token));
        } catch { /* private mode / quota */ }
        try {
          window.dispatchEvent(new CustomEvent('minicaai-auth-changed', { detail: { reason: 'stepup' } }));
        } catch { /* CustomEvent unavailable in older runtimes */ }
      }
      // Render result.message as the next assistant turn. Server
      // soft-fails the tool (data.ok=false with a friendly reason),
      // so the message is always something we can show verbatim.
      const text = String(
        data?.message
        || (data?.ok ? 'Done.' : 'That didn\'t go through. Try rephrasing the request.'),
      );
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: text, time: nowTime() },
      ]);
      setPendingStepUp(null);
      setStepUpPassword('');
      setStepUpStatus('idle');
      setStepUpError(null);
    } catch (err: any) {
      console.warn('[support] step-up POST failed:', err?.message);
      setStepUpStatus('error');
      setStepUpError('Network hiccup — try again.');
    }
  }, [base, pendingStepUp, stepUpPassword, stepUpStatus, readLiveToken]);

  const cancelStepUp = useCallback(() => {
    setPendingStepUp(null);
    setStepUpPassword('');
    setStepUpStatus('idle');
    setStepUpError(null);
    // Drop a soft "cancelled" note into the chat so the admin sees
    // why the action didn't run. Avoids leaving a half-finished
    // confirmation visible without context.
    setMessages(prev => [
      ...prev,
      { role: 'assistant', content: 'Cancelled — that action didn\'t run. Let me know if you want to try again.', time: nowTime() },
    ]);
  }, []);

  const submitHandoff = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (handoffStatus === 'sending') return;
    setHandoffStatus('sending');
    setHandoffError(null);
    try {
      const transcript = messages.map(m => ({ role: m.role, content: m.content }));
      const res = await fetch(`${base}/api/v1/support/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: handoffEmail.trim(),
          name: handoffName.trim(),
          question: handoffQuestion.trim(),
          transcript,
          sessionId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Server returned ${res.status}`);
      setHandoffStatus('sent');
      window.setTimeout(() => {
        setShowHandoff(false);
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: `Got it — I've passed your question to the team. They'll reply to ${handoffEmail.trim()} within one business day. In the meantime I can keep helping if you have other questions.`,
            time: nowTime(),
          },
        ]);
        setHandoffStatus('idle');
      }, 1500);
    } catch (err: any) {
      setHandoffStatus('error');
      setHandoffError(err?.message || 'Could not deliver your message. Please email support@minicaai.com directly.');
    }
  }, [base, handoffEmail, handoffName, handoffQuestion, handoffStatus, messages, sessionId]);

  // ── Render: floating closed bubble ───────────────────────────
  // Editorial: ink-black pill button with a terracotta accent dot.
  // z-[60] sits above page chrome but below z-[100] full-screen takeovers.
  if (mode === 'floating' && !isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="Open support chat"
        className="fixed bottom-6 right-6 z-[60] flex items-center gap-2 pl-4 pr-5 py-3 rounded-full shadow-lg hover:shadow-xl transition-all hover:-translate-y-0.5 active:translate-y-0"
        style={{
          background: p.invertBg,
          color: p.invertText,
          fontFamily: p.font,
          boxShadow: '0 8px 24px rgba(20,20,19,0.18)',
        }}
      >
        <span
          className="relative inline-flex w-2 h-2 rounded-full"
          style={{ background: p.accent }}
        >
          <span
            className="absolute inset-0 rounded-full animate-ping"
            style={{ background: p.accent, opacity: 0.55 }}
          />
        </span>
        <MessageCircle size={16} />
        <span className="text-[13px] font-medium tracking-[-0.005em]">Ask Minica</span>
      </button>
    );
  }

  // ── Shell wrapper (mode-specific positioning) ────────────────
  const shellClass =
    mode === 'view'
      ? 'fixed inset-0 z-[100] flex items-center justify-center p-6 overflow-y-auto'
      : mode === 'floating'
      ? 'fixed bottom-6 right-6 z-[60] w-[400px] max-w-[calc(100vw-2rem)] h-[620px] max-h-[calc(100vh-3rem)]'
      // panel: the PARENT owns the height (App.tsx pins the support modal
      // body to min(70vh,720px)), so this must be able to shrink to it.
      // It used to carry min-h-[500px], which on any window shorter than
      // ~715px exceeded the height the modal was giving it — the panel
      // refused to shrink, so the MODAL BODY scrolled instead of the chat
      // list, and the "Talk to a human" row sat 2px past the modal edge
      // looking chopped off. Measured on a 687px-tall window: parent gave
      // 481px, this demanded 500px. min-h-0 lets the internal
      // flex-1 overflow-y-auto transcript be the only thing that scrolls,
      // which is what the modal comment upstream always intended.
      : 'w-full h-full min-h-0';

  const innerClass =
    mode === 'view'
      ? 'relative w-full max-w-lg h-[640px] max-h-[88vh] flex flex-col'
      : 'w-full h-full flex flex-col';

  const handleClose = () => {
    if (mode === 'floating') setIsOpen(false);
    else onClose?.();
  };

  // Outer wrapper sets the page-level background only for 'view' mode
  // (full-screen takeover). 'floating' has no outer backdrop — it sits
  // directly on the page. 'panel' fills its parent.
  const outerStyle: React.CSSProperties =
    mode === 'view' ? { background: p.bg, fontFamily: p.font, color: p.ink } : { fontFamily: p.font };

  return (
    <div className={shellClass} style={outerStyle}>
      <div className={innerClass}>
        <div
          className="rounded-2xl flex flex-col h-full overflow-hidden"
          style={{
            background: p.bg,
            border: `1px solid ${p.border}`,
            boxShadow:
              mode === 'floating'
                ? '0 20px 50px -10px rgba(20,20,19,0.18), 0 8px 20px -8px rgba(20,20,19,0.12)'
                : '0 24px 60px -16px rgba(20,20,19,0.22)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: `1px solid ${p.border}` }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: p.invertBg,
                  color: p.invertText,
                  boxShadow: '0 1px 0 rgba(255,255,255,0.10) inset, 0 2px 6px rgba(20,20,19,0.18)',
                }}
              >
                <HeadsetIcon size={18} weight="duotone" />
              </div>
              <div className="min-w-0">
                <h3
                  className="text-[14px] font-semibold tracking-[-0.005em] truncate"
                  style={{ color: p.ink }}
                >
                  Minica
                </h3>
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: p.accent }}
                  />
                  <span
                    className="text-[10px] font-medium tracking-[0.04em]"
                    style={{ color: p.inkMuted }}
                  >
                    Support · usually instant
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {isAdminRole && (
                <button
                  onClick={() => (inboxOpen ? exitInboxMode() : enterInboxMode())}
                  aria-label={inboxOpen ? 'Close live inbox' : 'Open live inbox'}
                  className="h-8 px-2.5 rounded-full flex items-center gap-1.5 transition-colors flex-shrink-0 text-[11px] font-medium relative"
                  style={{
                    color: inboxOpen ? p.invertText : p.ink,
                    background: inboxOpen ? p.invertBg : p.bgSoft,
                    border: `1px solid ${inboxOpen ? p.invertBg : p.border}`,
                  }}
                  title={inboxConnected ? 'Connected to live queue' : 'Click to connect as agent'}
                >
                  <MessageCircle size={11} />
                  Inbox
                  {inboxUnreadTotal > 0 && (
                    <span
                      className="ml-0.5 inline-flex items-center justify-center text-[9px] font-bold rounded-full px-1.5 min-w-[16px] h-[16px]"
                      style={{ background: 'var(--mc-danger)', color: '#fff' }}
                    >
                      {inboxUnreadTotal > 99 ? '99+' : inboxUnreadTotal}
                    </span>
                  )}
                </button>
              )}
              <button
                onClick={handleClose}
                aria-label="Close support chat"
                className="w-8 h-8 rounded-full flex items-center justify-center transition-colors flex-shrink-0"
                style={{ color: p.inkMuted, background: 'transparent' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = p.bgSoft;
                  e.currentTarget.style.color = p.ink;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = p.inkMuted;
                }}
              >
                {mode === 'floating' ? <ChevronDown size={16} /> : <X size={16} />}
              </button>
            </div>
          </div>

          {/* Admin live inbox (overlays everything when open) */}
          {inboxOpen && isAdminRole ? (
            <div className="flex-1 flex min-h-0" style={{ background: p.bg }}>
              {/* Sidebar: connected customers. Width animates between
                  collapsed (0) and expanded (240px) so the active chat
                  gets the full surface when the admin doesn't need the
                  list. Overflow-hidden on the rail prevents content from
                  bleeding through while the transition is mid-flight. */}
              <div
                className="flex-shrink-0 overflow-hidden flex flex-col"
                style={{
                  width: sidebarCollapsed ? 0 : 240,
                  borderRight: sidebarCollapsed ? 'none' : `1px solid ${p.border}`,
                  transition: 'width 220ms cubic-bezier(0.32, 0.72, 0, 1), border-color 220ms ease-out',
                  willChange: 'width',
                }}
                aria-hidden={sidebarCollapsed}
              >
                <div className="w-[240px] flex-1 overflow-y-auto flex flex-col min-h-0">
                {/* Sidebar header — gives the close affordance a home
                    visually inside the rail it controls, instead of
                    fighting Claim/Resolve in the chat header. Same
                    height as the chat-header so the two top rails line
                    up cleanly when the sidebar is open. */}
                <div
                  className="flex items-center justify-between px-3 py-2.5 flex-shrink-0"
                  style={{ borderBottom: `1px solid ${p.border}` }}
                >
                  <span
                    className="text-[10.5px] font-semibold uppercase"
                    style={{ color: p.inkFaint, letterSpacing: '0.06em' }}
                  >
                    Customers
                  </span>
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    aria-label="Hide customer list"
                    title="Hide customer list"
                    className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
                    style={{ color: p.inkMuted, background: 'transparent' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = p.bgSoft; e.currentTarget.style.color = p.ink; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = p.inkMuted; }}
                  >
                    <PanelLeftClose size={14} strokeWidth={1.75} />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                {/* ── Phone-push setup card ──
                    First-time admins see this expanded; once collapsed
                    (persisted via localStorage) it stays out of the way.
                    Copy + Send-test let the admin verify their phone is
                    subscribed without leaving the inbox. */}
                {inboxPresence?.ntfy_subscribe_url && (() => {
                  const isVerified = !!inboxPresence.ntfy_verified_at;
                  return (
                  <div
                    className="mx-2 my-2 rounded-xl overflow-hidden"
                    style={{
                      background: p.bgSoft,
                      border: `0.5px solid ${isVerified ? 'var(--mc-ok)' : p.border}`,
                      boxShadow: '0 1px 2px rgba(20,20,19,0.04)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={togglePushCard}
                      className="w-full px-2.5 py-2 text-left flex items-center gap-2 transition-colors"
                      style={{ color: p.ink }}
                      title={pushCardCollapsed ? 'Expand phone push setup' : 'Collapse'}
                    >
                      {isVerified
                        ? <CheckCircle2 size={13} strokeWidth={2} style={{ color: 'var(--mc-ok)', flexShrink: 0 }} />
                        : <Smartphone size={13} strokeWidth={1.75} style={{ color: p.accent, flexShrink: 0 }} />}
                      <span
                        className="text-[10.5px] font-semibold uppercase flex-1 truncate"
                        style={{ letterSpacing: '0.06em' }}
                      >
                        {isVerified ? 'Phone push · active' : 'Phone push · setup'}
                      </span>
                      {pushCardCollapsed
                        ? <ChevronRight size={12} strokeWidth={2} style={{ color: p.inkMuted, flexShrink: 0 }} />
                        : <ChevronDown size={12} strokeWidth={2} style={{ color: p.inkMuted, flexShrink: 0 }} />}
                    </button>
                    {/* Compact status line shown when COLLAPSED + verified —
                        gives an at-a-glance confirmation without expanding. */}
                    {pushCardCollapsed && isVerified && (
                      <div
                        className="px-2.5 pb-2 text-[10px] leading-snug"
                        style={{ color: p.inkMuted }}
                      >
                        Subscribed once · auto-alerts active
                        {inboxPresence.ntfy_last_alert_at ? ` · last alert ${formatRelativeTime(inboxPresence.ntfy_last_alert_at)}` : ''}
                      </div>
                    )}
                    {!pushCardCollapsed && (
                      <div className="px-2.5 pb-2.5 space-y-2">
                        {isVerified ? (
                          <p className="text-[10.5px] leading-relaxed flex items-start gap-1.5" style={{ color: p.ink }}>
                            <span style={{ color: 'var(--mc-ok)' }}>✓</span>
                            <span>
                              <strong>Already set up.</strong> You subscribed once; your phone will buzz every time a customer needs help — no need to re-paste anything. Last alert: <strong>{inboxPresence.ntfy_last_alert_at ? formatRelativeTime(inboxPresence.ntfy_last_alert_at) : 'never'}</strong>.
                            </span>
                          </p>
                        ) : (
                          <p className="text-[10.5px] leading-relaxed" style={{ color: p.inkMuted }}>
                            One-time setup. Install the free <strong>ntfy</strong> app and subscribe to your private topic <strong>once</strong> — after that, every customer alert lands on your phone automatically (no need to re-paste).
                          </p>
                        )}
                        {/* TOPIC NAME — this is what the ntfy mobile app
                            wants in its Subscribe input. Pasting the
                            full URL there leaves the Subscribe button
                            disabled because ntfy's input regex rejects
                            the colon + slashes. */}
                        <div className="space-y-1">
                          <div className="text-[9.5px] uppercase tracking-wider font-bold" style={{ color: p.inkFaint }}>
                            Topic name (paste in ntfy app)
                          </div>
                          <div
                            className="text-[11px] rounded px-2 py-1.5 font-mono break-all select-all"
                            style={{ background: p.bg, border: `1px solid ${p.border}`, color: p.ink }}
                            // Mobile/keyboard users can tap-and-hold this
                            // block to select all + system-copy without
                            // routing through our clipboard button.
                          >
                            {inboxPresence.ntfy_topic}
                          </div>
                        </div>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={copyTopicUrl}
                            className="flex-1 text-[10px] font-semibold py-1 rounded transition-colors"
                            style={{
                              background: topicCopied ? 'var(--mc-ok)' : p.bg,
                              color: topicCopied ? '#fff' : p.ink,
                              border: `1px solid ${topicCopied ? 'var(--mc-ok)' : p.border}`,
                            }}
                          >
                            {topicCopied ? '✓ Copied' : 'Copy topic'}
                          </button>
                          <button
                            type="button"
                            onClick={sendTestAlert}
                            disabled={testAlertStatus === 'sending'}
                            className="flex-1 text-[10px] font-semibold py-1 rounded transition-colors disabled:opacity-60"
                            style={{
                              background:
                                testAlertStatus === 'sent' ? 'var(--mc-ok)' :
                                testAlertStatus === 'failed' ? 'var(--mc-danger)' :
                                p.accent,
                              color: '#fff',
                              border: 'none',
                            }}
                          >
                            {testAlertStatus === 'sending' ? 'Sending…'
                              : testAlertStatus === 'sent' ? '✓ Sent'
                              : testAlertStatus === 'failed' ? 'Failed'
                              : 'Send test'}
                          </button>
                        </div>
                        <ol className="text-[10px] leading-snug space-y-0.5 pl-3.5 list-decimal" style={{ color: p.inkMuted }}>
                          <li>Install <strong>ntfy</strong> on your phone (free, no signup)</li>
                          <li>Tap <strong>+</strong> → paste the topic name above (not the URL) → Subscribe</li>
                          <li>Hit <strong>Send test</strong> — your phone should buzz</li>
                        </ol>
                        {/* Publish URL — kept for power users who want
                            to POST manually (curl + a deploy script,
                            self-hosted ntfy server pointing at a
                            different host, etc.). Not what the mobile
                            app needs. */}
                        <details className="text-[10px]" style={{ color: p.inkFaint }}>
                          <summary className="cursor-pointer select-none">Publish URL (for API / self-host)</summary>
                          <div
                            className="mt-1 px-2 py-1 rounded font-mono break-all select-all"
                            style={{ background: p.bg, border: `1px solid ${p.border}`, color: p.inkMuted, fontSize: 9.5 }}
                          >
                            {inboxPresence.ntfy_subscribe_url}
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                  );
                })()}

                <div
                  className="px-3 py-2 text-[10px] uppercase tracking-wider font-bold flex items-center justify-between gap-2"
                  style={{ color: p.inkFaint, borderBottom: `1px solid ${p.border}` }}
                >
                  <span>Customers · {inboxCustomers.size}</span>
                  {/* Live WS-status dot. Reflects the actual agent
                      WebSocket state from App.tsx, not just the REST
                      snapshot success — so a flapping connection is
                      visible instead of a stale "connected" lie. */}
                  <span
                    className="inline-flex items-center gap-1.5"
                    title={
                      inboxWsStatus === 'online' ? 'Live channel connected'
                      : inboxWsStatus === 'offline' ? 'Reconnecting to live channel…'
                      : 'Connecting…'
                    }
                  >
                    <span
                      className={inboxWsStatus === 'offline' ? 'animate-pulse' : ''}
                      style={{
                        display: 'inline-block',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background:
                          inboxWsStatus === 'online' ? 'var(--mc-ok)'
                          : inboxWsStatus === 'offline' ? 'var(--mc-danger)'
                          : 'var(--mc-warn)',
                      }}
                      aria-label={`ws ${inboxWsStatus}`}
                    />
                    <span className="text-[9px] normal-case tracking-normal font-medium" style={{ color: p.inkMuted }}>
                      {inboxWsStatus === 'online' ? 'live' : inboxWsStatus === 'offline' ? 'reconnecting' : 'connecting'}
                    </span>
                  </span>
                </div>
                {inboxCustomers.size === 0 ? (
                  <div className="px-3 py-6 text-[11px] text-center" style={{ color: p.inkFaint }}>
                    {inboxConnected ? 'No customers waiting. Sit tight — a chime + notification will fire when one connects.' : 'Connecting to the live queue…'}
                  </div>
                ) : (
                  Array.from(inboxCustomers.values())
                    // Sort: 'red' SLA first (most urgent), then yellow,
                    // then green, then gray. Within a tier, most-recent
                    // last_message_at first. This is what an admin
                    // actually wants to scan in a busy inbox.
                    .sort((a, b) => {
                      const slaWeight = { red: 0, yellow: 1, green: 2, gray: 3 } as const;
                      const aw = slaWeight[a.sla || 'gray'];
                      const bw = slaWeight[b.sla || 'gray'];
                      if (aw !== bw) return aw - bw;
                      return b.lastSeenAt - a.lastSeenAt;
                    })
                    .map(cust => {
                      const isActive = inboxActiveEmail === cust.email;
                      // SLA dot color — server returns these classifications,
                      // and we re-tick them client-side every 5s while
                      // the inbox is open so they stay accurate.
                      const slaColor =
                        cust.sla === 'red'    ? 'var(--mc-danger)' :   // tailwind red-500
                        cust.sla === 'yellow' ? 'var(--mc-warn)' :   // amber-500
                        cust.sla === 'green'  ? 'var(--mc-ok)' :   // emerald-500
                        'var(--mc-ink-faint)';                            // gray-400
                      const statusLabel =
                        cust.status === 'resolved' ? 'RESOLVED' :
                        cust.status === 'assigned' ? 'ASSIGNED' :
                        cust.status === 'spam'     ? 'SPAM' :
                        'OPEN';
                      const statusColor =
                        cust.status === 'resolved' ? p.inkFaint :
                        cust.status === 'assigned' ? 'var(--mc-accent)' :
                        cust.status === 'spam'     ? 'var(--mc-danger)' :
                        'var(--mc-ok)';
                      return (
                        <button
                          key={cust.email}
                          type="button"
                          onClick={() => setInboxActiveEmail(cust.email)}
                          className="w-full text-left px-3 py-2.5 transition-colors flex items-start gap-2"
                          style={{
                            background: isActive ? p.bgSoft : 'transparent',
                            borderBottom: `1px solid ${p.border}`,
                            color: p.ink,
                          }}
                          title={`${statusLabel} · SLA ${(cust.sla || 'gray').toUpperCase()}${cust.tier ? ' · ' + cust.tier.toUpperCase() : ''}`}
                        >
                          {/* SLA color dot — the at-a-glance urgency cue.
                              Pulses when red so the eye catches it even
                              in a long scrollable list. A small ring
                              around the dot signals customer offline
                              (transient WS disconnect; thread stays
                              alive in the DB). */}
                          <span
                            className={`relative inline-block rounded-full mt-1 flex-shrink-0${cust.sla === 'red' ? ' animate-pulse' : ''}`}
                            style={{
                              width: 8,
                              height: 8,
                              background: slaColor,
                              boxShadow: cust.online === false ? `0 0 0 2px ${p.border}` : undefined,
                              opacity: cust.online === false ? 0.5 : 1,
                            }}
                            aria-label={`sla ${cust.sla || 'gray'}${cust.online === false ? ' offline' : ''}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <div
                                className="text-[12px] font-semibold truncate"
                                style={{ opacity: cust.online === false ? 0.65 : 1 }}
                              >
                                {cust.name}
                              </div>
                              {cust.tier && (
                                <span
                                  className="text-[8.5px] font-bold uppercase tracking-wider px-1 py-px rounded flex-shrink-0"
                                  style={{ background: p.accentSoft, color: p.accent }}
                                >
                                  {cust.tier}
                                </span>
                              )}
                              {cust.online === false && (
                                <span
                                  className="text-[8.5px] font-bold uppercase tracking-wider px-1 py-px rounded flex-shrink-0"
                                  style={{ background: p.bgSoft, color: p.inkMuted, border: `1px solid ${p.border}` }}
                                  title="Customer's socket dropped — thread is still alive, they may reconnect any moment."
                                >
                                  Offline
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] truncate" style={{ color: p.inkMuted }}>{cust.email}</div>
                            <div className="text-[9px] font-bold tracking-wider mt-0.5" style={{ color: statusColor }}>
                              {statusLabel}
                            </div>
                          </div>
                          {cust.unread > 0 && (
                            <span
                              className="inline-flex items-center justify-center text-[9px] font-bold rounded-full px-1.5 min-w-[16px] h-[16px] flex-shrink-0 mt-1"
                              style={{ background: 'var(--mc-danger)', color: '#fff' }}
                            >
                              {cust.unread}
                            </span>
                          )}
                        </button>
                      );
                    })
                )}
                </div>
                </div>
              </div>

              {/* Active conversation */}
              <div className="flex-1 flex flex-col min-w-0 relative">
                {!inboxActiveEmail ? (
                  <div className="flex-1 flex flex-col items-center justify-center min-w-0 px-6 gap-3">
                    <div className="text-center text-[12px]" style={{ color: p.inkFaint }}>
                      {inboxCustomers.size === 0
                        ? 'Waiting for a customer to start a chat. The sidebar will populate live.'
                        : 'Select a customer on the left to start chatting.'}
                    </div>
                    {/* If the admin previously hid the customer list and
                        is now staring at an empty chat, give them one
                        clean inline button to bring the sidebar back —
                        no floating affordance, no overlap surface. */}
                    {sidebarCollapsed && (
                      <button
                        type="button"
                        onClick={toggleSidebar}
                        className="inline-flex items-center gap-1.5 px-3 py-[7px] rounded-full transition-all"
                        style={{
                          background: p.bgSoft,
                          color: p.ink,
                          border: `0.5px solid ${p.border}`,
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: '-0.005em',
                          boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(20,20,19,0.04)',
                        }}
                        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)'; }}
                        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                      >
                        <PanelLeftOpen size={12} strokeWidth={1.75} />
                        <span>Show customer list</span>
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div
                      className="px-4 py-2.5 text-[12px] flex items-center justify-between gap-3 flex-shrink-0"
                      style={{ borderBottom: `1px solid ${p.border}` }}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {/* Show-sidebar toggle — only visible when the
                            customer list is hidden. When the sidebar is
                            OPEN the close affordance lives inside the
                            sidebar header itself, so this row stays free
                            of a redundant icon that would otherwise
                            shove into Claim/Resolve at narrow widths. */}
                        {sidebarCollapsed && (
                          <button
                            type="button"
                            onClick={toggleSidebar}
                            aria-label="Show customer list"
                            title="Show customer list"
                            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors flex-shrink-0"
                            style={{
                              color: p.inkMuted,
                              background: 'transparent',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = p.bgSoft;
                              e.currentTarget.style.color = p.ink;
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'transparent';
                              e.currentTarget.style.color = p.inkMuted;
                            }}
                          >
                            <PanelLeftOpen size={14} strokeWidth={1.75} />
                          </button>
                        )}
                        {/* SLA dot in the header too — gives the admin
                            urgency-context while they type the reply. */}
                        {(() => {
                          const cust = inboxCustomers.get(inboxActiveEmail);
                          const slaColor =
                            cust?.sla === 'red'    ? 'var(--mc-danger)' :
                            cust?.sla === 'yellow' ? 'var(--mc-warn)' :
                            cust?.sla === 'green'  ? 'var(--mc-ok)' :
                            'var(--mc-ink-faint)';
                          return (
                            <span
                              className={`inline-block rounded-full flex-shrink-0${cust?.sla === 'red' ? ' animate-pulse' : ''}`}
                              style={{ width: 8, height: 8, background: slaColor }}
                              aria-label={`sla ${cust?.sla || 'gray'}`}
                            />
                          );
                        })()}
                        <div className="min-w-0">
                          <div className="font-semibold truncate flex items-center gap-1.5" style={{ color: p.ink }}>
                            <span className="truncate">{inboxCustomers.get(inboxActiveEmail)?.name || inboxActiveEmail}</span>
                            {inboxCustomers.get(inboxActiveEmail)?.online === false && (
                              <span
                                className="text-[8.5px] font-bold uppercase tracking-wider px-1 py-px rounded flex-shrink-0"
                                style={{ background: p.bgSoft, color: p.inkMuted, border: `1px solid ${p.border}` }}
                                title="Customer's socket is down — your reply will land when they reconnect."
                              >
                                Offline
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] truncate flex items-center gap-1.5" style={{ color: p.inkMuted }}>
                            <span className="truncate">{inboxActiveEmail}</span>
                            {/* Typing indicator — server relays the
                                customer's typing:true frames; we clear
                                it on a 4s safety timeout if no stop
                                arrives, so a customer who navigates
                                away can't leave it stuck. */}
                            {inboxTypingEmail === inboxActiveEmail && (
                              <span className="flex items-center gap-0.5" style={{ color: p.accent }}>
                                <span className="text-[9px] font-medium">typing</span>
                                <span className="inline-flex gap-0.5">
                                  <span className="inline-block w-1 h-1 rounded-full" style={{ background: p.accent, animation: 'pulse 1.2s ease-in-out infinite' }} />
                                  <span className="inline-block w-1 h-1 rounded-full" style={{ background: p.accent, animation: 'pulse 1.2s ease-in-out 0.2s infinite' }} />
                                  <span className="inline-block w-1 h-1 rounded-full" style={{ background: p.accent, animation: 'pulse 1.2s ease-in-out 0.4s infinite' }} />
                                </span>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {/* Claim / Resolve actions. Buttons only render when
                          the action is actually useful: Claim disappears
                          once the thread is assigned to ANY agent;
                          Resolve replaces Reopen once the thread is
                          marked resolved. */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {(() => {
                          const cust = inboxCustomers.get(inboxActiveEmail);
                          if (!cust) return null;
                          if (cust.status === 'resolved') {
                            return (
                              <span
                                className="text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded"
                                style={{ background: p.bgSoft, color: p.inkMuted, border: `1px solid ${p.border}` }}
                              >
                                Resolved
                              </span>
                            );
                          }
                          return (
                            <>
                              {cust.status !== 'assigned' && (
                                <button
                                  type="button"
                                  onClick={() => claimThread(inboxActiveEmail)}
                                  className="text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded transition-colors"
                                  style={{
                                    background: 'transparent',
                                    // Was hardcoded #d3ac63 — the dark-theme
                                    // gold, which on the light cream surface
                                    // sat at roughly 2:1 against the panel.
                                    // p.accent resolves to the deepened gold
                                    // in light and the bright one in dark.
                                    color: p.accent,
                                    border: `1px solid ${p.accent}`,
                                  }}
                                  title="Mark this conversation as assigned to you"
                                >
                                  Claim
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => resolveThread(inboxActiveEmail)}
                                className="text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded transition-colors"
                                style={{
                                  background: 'var(--mc-ok)',
                                  color: '#fff',
                                  border: 'none',
                                }}
                                title="Close this thread and ask the customer to rate the chat"
                              >
                                Resolve
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    {/* Initial question pin — surfaces the customer's
                        opening line above the scrolling chat so the
                        admin can keep context while reading the rest.
                        Hidden if there's no initial_question (older
                        threads, /handoff path without one). */}
                    {(() => {
                      const cust = inboxCustomers.get(inboxActiveEmail);
                      if (!cust?.initialQuestion) return null;
                      return (
                        <div
                          className="mx-3 mt-2 mb-1 px-3 py-2 rounded-xl text-[11.5px] leading-[1.45]"
                          style={{
                            background: p.bgSoft,
                            border: `1px solid ${p.border}`,
                            color: p.ink,
                          }}
                        >
                          <div className="text-[9px] uppercase tracking-wider font-bold mb-0.5" style={{ color: p.inkFaint }}>
                            Initial question
                          </div>
                          {cust.initialQuestion}
                        </div>
                      );
                    })()}
                    <div ref={inboxScrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
                      {(inboxMessages.get(inboxActiveEmail) || []).map((m, i) => {
                        const isAgent = m.from === 'agent';
                        return (
                          <div key={i} className={`flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
                            <div
                              className="max-w-[85%] px-3 py-2 rounded-2xl text-[13px] leading-[1.5] break-words"
                              style={{
                                background: isAgent ? p.invertBg : p.bgSoft,
                                color: isAgent ? p.invertText : p.ink,
                                border: isAgent ? 'none' : `1px solid ${p.border}`,
                                borderBottomRightRadius: isAgent ? '6px' : undefined,
                                borderBottomLeftRadius: isAgent ? undefined : '6px',
                              }}
                            >
                              {m.text}
                              <span
                                className="block text-[10px] mt-1"
                                style={{ color: isAgent ? 'rgba(250,247,240,0.55)' : p.inkFaint }}
                              >
                                {m.time}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                      {(!inboxMessages.get(inboxActiveEmail) || inboxMessages.get(inboxActiveEmail)!.length === 0) && (
                        <div className="text-center text-[11px] py-4" style={{ color: p.inkFaint }}>
                          No messages yet. Say hello to {inboxCustomers.get(inboxActiveEmail)?.name || 'them'}.
                        </div>
                      )}
                    </div>
                    {/* AI-assist suggestion preview — appears between
                        the messages and the composer while a draft or
                        polish is streaming, with Use / Discard buttons
                        once it lands. */}
                    {assistMode && (
                      <div
                        className="mx-3 mt-2 mb-1 rounded-xl px-3 py-2.5"
                        style={{
                          background: p.accentSoft,
                          border: `1px solid ${p.accent}`,
                          color: p.ink,
                        }}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span
                            className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase"
                            style={{ color: p.accent, letterSpacing: '0.06em' }}
                          >
                            {assistMode === 'polish'
                              ? <Sparkles size={11} strokeWidth={2} />
                              : <Wand2 size={11} strokeWidth={2} />}
                            <span>{assistMode === 'polish' ? 'Polished draft' : 'Suggested reply'}</span>
                            <span
                              className="text-[9px] font-medium normal-case"
                              style={{ color: p.inkMuted, letterSpacing: '-0.005em' }}
                            >
                              · {assistMode === 'polish' ? 'GPT-5.6' : 'Claude'}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={discardAssistSuggestion}
                            className="inline-flex items-center justify-center w-6 h-6 rounded-full transition-colors"
                            style={{ background: 'transparent', color: p.inkMuted, border: 'none' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = p.bg; e.currentTarget.style.color = p.ink; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = p.inkMuted; }}
                            aria-label="Discard suggestion"
                            title="Discard"
                          >
                            <X size={12} strokeWidth={2} />
                          </button>
                        </div>
                        <div className="text-[12.5px] leading-[1.5] whitespace-pre-wrap break-words" style={{ color: p.ink }}>
                          {assistText}
                          {assistStreaming && (
                            <span
                              className="inline-block align-baseline ml-0.5"
                              style={{
                                width: 2,
                                height: '1em',
                                background: p.ink,
                                opacity: 0.7,
                                animation: 'pulse 1.05s steps(2, start) infinite',
                              }}
                            />
                          )}
                          {!assistText && !assistStreaming && !assistError && (
                            <span style={{ color: p.inkMuted }}>(empty)</span>
                          )}
                        </div>
                        {assistError && (
                          <div className="text-[10.5px] mt-1.5" style={{ color: 'var(--mc-danger)' }}>
                            {assistError}
                          </div>
                        )}
                        {!assistStreaming && assistText && !assistError && (
                          <div className="flex items-center justify-end gap-1.5 mt-2">
                            <button
                              type="button"
                              onClick={() => requestAssist(assistMode)}
                              className="text-[10.5px] font-semibold px-2.5 py-1 rounded"
                              style={{ background: 'transparent', color: p.inkMuted, border: `1px solid ${p.border}` }}
                              title="Regenerate"
                            >
                              Regenerate
                            </button>
                            <button
                              type="button"
                              onClick={useAssistSuggestion}
                              className="text-[10.5px] font-semibold px-3 py-1 rounded"
                              style={{ background: p.invertBg, color: p.invertText, border: 'none' }}
                            >
                              Use this
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    <form
                      onSubmit={(e) => { e.preventDefault(); sendInboxMessage(); }}
                      className="flex flex-col gap-2 p-3 flex-shrink-0"
                      style={{ borderTop: `1px solid ${p.border}` }}
                    >
                      {/* Suggest + Polish action row. iOS-style pills:
                          tinted-glass primary, ghost secondary. Layered
                          shadow (1px hairline + 2px ambient + inset
                          highlight) keeps weight in dark/light theme.
                          Active state uses scale(0.97) — same haptic feel
                          as SF Symbols controls. */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => requestAssist('draft')}
                          disabled={assistStreaming}
                          className="group inline-flex items-center gap-1.5 px-3 py-[7px] rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                          style={{
                            background: `linear-gradient(180deg, ${p.accent} 0%, color-mix(in srgb, ${p.accent} 86%, #000) 100%)`,
                            color: p.invertText,
                            border: 'none',
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: '-0.005em',
                            boxShadow: `0 1px 0 rgba(255,255,255,0.18) inset, 0 1px 2px rgba(20,20,19,0.10), 0 2px 6px ${p.accent}33`,
                          }}
                          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)'; }}
                          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                          title="Draft a reply with Claude based on the conversation"
                        >
                          <Wand2 size={12} strokeWidth={2} />
                          <span>Suggest reply</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => requestAssist('polish')}
                          disabled={assistStreaming || !inboxInput.trim()}
                          className="inline-flex items-center gap-1.5 px-3 py-[7px] rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{
                            background: p.bgSoft,
                            color: p.ink,
                            border: `0.5px solid ${p.border}`,
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: '-0.005em',
                            boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(20,20,19,0.04)',
                          }}
                          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)'; }}
                          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                          title="Fix grammar + clarity of your draft without changing what you said"
                        >
                          <Sparkles size={12} strokeWidth={2} />
                          <span>Polish</span>
                        </button>
                        {assistStreaming && (
                          <span
                            className="ml-auto inline-flex items-center gap-1.5 text-[10px]"
                            style={{ color: p.accent, fontWeight: 500, letterSpacing: '-0.005em' }}
                          >
                            <Loader2 size={10} className="animate-spin" strokeWidth={2.25} />
                            {assistMode === 'polish' ? 'GPT-5.6' : 'Claude'} is thinking…
                          </span>
                        )}
                      </div>

                      <div className="flex gap-2">
                        <textarea
                          value={inboxInput}
                          onChange={(e) => setInboxInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              sendInboxMessage();
                            }
                          }}
                          rows={1}
                          placeholder="Reply to customer…"
                          className="flex-1 px-3 py-2 rounded-xl text-[13px] focus:outline-none resize-none"
                          style={{
                            background: p.bgInput,
                            border: `1px solid ${p.border}`,
                            color: p.ink,
                            minHeight: 38,
                            maxHeight: 100,
                          }}
                        />
                        <button
                          type="submit"
                          disabled={!inboxInput.trim()}
                          aria-label="Send reply"
                          className="w-[38px] h-[38px] rounded-full flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                          style={{
                            background: `linear-gradient(180deg, ${p.accent} 0%, color-mix(in srgb, ${p.accent} 86%, #000) 100%)`,
                            color: p.invertText,
                            border: 'none',
                            boxShadow: `0 1px 0 rgba(255,255,255,0.18) inset, 0 1px 2px rgba(20,20,19,0.10), 0 4px 10px ${p.accent}33`,
                          }}
                          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.94)'; }}
                          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                        >
                          <Send size={14} strokeWidth={2} />
                        </button>
                      </div>
                    </form>
                  </>
                )}
              </div>
            </div>
          ) : showHandoff ? (
            <form onSubmit={submitHandoff} className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
              <div className="flex items-start gap-3">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: p.accentSoft, color: p.accent }}
                >
                  <Mail size={15} />
                </div>
                <div>
                  <h4 className="text-[14px] font-semibold tracking-[-0.005em]" style={{ color: p.ink }}>
                    Talk to a human
                  </h4>
                  <p className="text-[12px] leading-relaxed mt-0.5" style={{ color: p.inkMuted }}>
                    Leave your email and we'll reply within one business day. Your conversation with Minica is included.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.08em] font-semibold" style={{ color: p.inkMuted }}>
                    Your email
                  </span>
                  <input
                    type="email"
                    required
                    value={handoffEmail}
                    onChange={(e) => setHandoffEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="mt-1 w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none transition-colors"
                    style={{
                      background: p.bgInput,
                      border: `1px solid ${p.border}`,
                      color: p.ink,
                      fontFamily: p.font,
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = p.ink; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = p.border; }}
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.08em] font-semibold" style={{ color: p.inkMuted }}>
                    Name (optional)
                  </span>
                  <input
                    type="text"
                    value={handoffName}
                    onChange={(e) => setHandoffName(e.target.value)}
                    placeholder="Your name"
                    className="mt-1 w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none transition-colors"
                    style={{
                      background: p.bgInput,
                      border: `1px solid ${p.border}`,
                      color: p.ink,
                      fontFamily: p.font,
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = p.ink; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = p.border; }}
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.08em] font-semibold" style={{ color: p.inkMuted }}>
                    What do you need help with?
                  </span>
                  <textarea
                    required
                    rows={4}
                    maxLength={5000}
                    value={handoffQuestion}
                    onChange={(e) => setHandoffQuestion(e.target.value)}
                    placeholder="Describe the issue in your own words..."
                    className="mt-1 w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none transition-colors resize-none"
                    style={{
                      background: p.bgInput,
                      border: `1px solid ${p.border}`,
                      color: p.ink,
                      fontFamily: p.font,
                      lineHeight: 1.5,
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = p.ink; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = p.border; }}
                  />
                  <span className="text-[10px] mt-1 block" style={{ color: p.inkFaint }}>
                    {handoffQuestion.length}/5000
                  </span>
                </label>
              </div>

              {handoffError && (
                <div
                  className="flex items-start gap-2 px-3 py-2 rounded-lg text-[12px]"
                  style={{ background: 'rgba(201,99,66,0.08)', border: '1px solid rgba(201,99,66,0.25)', color: p.accent }}
                >
                  <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                  <span>{handoffError}</span>
                </div>
              )}

              {handoffStatus === 'sent' && (
                <div
                  className="px-3 py-2 rounded-lg text-[12px]"
                  style={{ background: p.accentSoft, color: p.accent }}
                >
                  Sent — the team will reply by email.
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowHandoff(false)}
                  className="flex-1 px-4 py-2.5 rounded-full text-[13px] font-medium transition-colors"
                  style={{
                    background: 'transparent',
                    border: `1px solid ${p.border}`,
                    color: p.ink,
                    fontFamily: p.font,
                  }}
                >
                  Back to chat
                </button>
                <button
                  type="submit"
                  disabled={handoffStatus === 'sending' || handoffStatus === 'sent'}
                  className="flex-1 px-4 py-2.5 rounded-full text-[13px] font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  style={{
                    background: p.invertBg,
                    color: p.invertText,
                    fontFamily: p.font,
                  }}
                >
                  {handoffStatus === 'sending' ? (
                    <>
                      <Loader2 size={13} className="animate-spin" /> Sending
                    </>
                  ) : handoffStatus === 'sent' ? (
                    'Sent'
                  ) : (
                    'Send to team'
                  )}
                </button>
              </div>
            </form>
          ) : isResolving ? (
            <div
              className="flex-1 flex items-center justify-center"
              style={{ background: p.bg, color: p.inkMuted }}
            >
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : !canUseAi ? (
            <ScriptedTopicsView
              palette={p}
              scripted={scripted}
              scriptedError={scriptedError}
              expandedCategory={expandedCategory}
              setExpandedCategory={setExpandedCategory}
              expandedTopic={expandedTopic}
              setExpandedTopic={setExpandedTopic}
              tier={resolvedTier}
              onOpenHandoff={openHandoff}
            />
          ) : (
            <>
              {/* Message stream */}
              <div
                className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
                style={{ background: p.bg }}
              >
                {messages.map((msg, i) => {
                  const isUser = msg.role === 'user';
                  const isLast = i === messages.length - 1;
                  const showThinking = isStreaming && isLast && !msg.content;
                  return (
                    <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[13.5px] leading-[1.55] break-words ${isUser ? 'whitespace-pre-wrap' : 'minica-md'}`}
                        style={{
                          background: isUser ? p.invertBg : p.bgSoft,
                          color: isUser ? p.invertText : p.inkSoft,
                          border: isUser ? 'none' : `1px solid ${p.border}`,
                          borderBottomRightRadius: isUser ? '6px' : undefined,
                          borderBottomLeftRadius: isUser ? undefined : '6px',
                          fontFamily: p.font,
                        }}
                      >
                        {/* User messages stay as plain text (preserves their
                            exact input). Assistant messages render through
                            ReactMarkdown so **bold**, lists, code blocks,
                            headings show as formatted text instead of raw
                            asterisks. The .minica-md class hooks the inline
                            stylesheet below for tight spacing inside chat
                            bubbles (default prose padding looks oversized
                            against a 13.5px message). */}
                        {isUser ? (
                          msg.content || null
                        ) : msg.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                          </ReactMarkdown>
                        ) : showThinking ? (
                          <span className="inline-flex items-center gap-1.5" style={{ color: p.inkMuted }}>
                            <Loader2 size={12} className="animate-spin" />
                            <span className="text-[12px]">Thinking…</span>
                          </span>
                        ) : null}
                        {msg.time && msg.content && (
                          <span
                            className="block text-[10px] mt-1"
                            style={{
                              color: isUser ? 'rgba(250,247,240,0.55)' : p.inkFaint,
                              letterSpacing: '0.02em',
                            }}
                          >
                            {msg.time}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}

                {statusPhase === 'searching' && (
                  <div className="flex justify-start">
                    <div
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px]"
                      style={{
                        background: p.accentSoft,
                        color: p.accent,
                        border: `1px solid ${p.border}`,
                      }}
                    >
                      <Globe size={11} className="animate-pulse" />
                      <span>Checking the web…</span>
                    </div>
                  </div>
                )}

                {/* Inline step-up password prompt (admin destructive
                    actions). Rendered as an assistant-style chat
                    bubble so it visually flows with the conversation;
                    submitting posts {password, intent} to
                    /api/v1/support/reauth-execute. On success the
                    new stepUp JWT replaces the old one in localStorage
                    and the deferred tool runs immediately. */}
                {pendingStepUp && (
                  <div className="flex justify-start">
                    <form
                      onSubmit={submitStepUp}
                      className="max-w-[90%] px-3.5 py-3 rounded-2xl space-y-2.5"
                      style={{
                        background: p.bgSoft,
                        color: p.inkSoft,
                        border: `1px solid ${p.border}`,
                        borderBottomLeftRadius: '6px',
                        fontFamily: p.font,
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <Lock size={13} className="flex-shrink-0 mt-0.5" style={{ color: p.accent }} />
                        <div className="text-[12.5px] leading-relaxed">
                          {pendingStepUp.reason}
                        </div>
                      </div>
                      <input
                        type="password"
                        autoFocus
                        value={stepUpPassword}
                        onChange={(e) => setStepUpPassword(e.target.value)}
                        placeholder="Your password"
                        autoComplete="current-password"
                        disabled={stepUpStatus === 'submitting'}
                        className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none transition-colors disabled:opacity-60"
                        style={{
                          background: p.bgInput,
                          border: `1px solid ${p.border}`,
                          color: p.ink,
                          fontFamily: p.font,
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = p.ink; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = p.border; }}
                      />
                      {stepUpError && (
                        <div className="flex items-start gap-1.5 text-[11px]" style={{ color: p.accent }}>
                          <AlertCircle size={11} className="flex-shrink-0 mt-0.5" />
                          <span>{stepUpError}</span>
                        </div>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={cancelStepUp}
                          disabled={stepUpStatus === 'submitting'}
                          className="flex-1 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors disabled:opacity-60"
                          style={{
                            background: 'transparent',
                            border: `1px solid ${p.border}`,
                            color: p.inkSoft,
                            fontFamily: p.font,
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!stepUpPassword || stepUpStatus === 'submitting'}
                          className="flex-1 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                          style={{
                            background: p.invertBg,
                            color: p.invertText,
                            fontFamily: p.font,
                          }}
                        >
                          {stepUpStatus === 'submitting' ? (
                            <>
                              <Loader2 size={11} className="animate-spin" /> Verifying
                            </>
                          ) : (
                            'Confirm'
                          )}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* CSAT prompt — appears inline above the composer after
                  the agent marks the thread resolved. Only renders for
                  the customer (csatThreadId is set via the WS frame),
                  and once submitted shows a brief thanks before
                  disappearing entirely. Tap a star to set the rating;
                  the comment field is optional. */}
              {csatThreadId && (
                <div
                  className="mx-4 mt-3 mb-1 rounded-xl px-4 py-3 space-y-2.5"
                  style={{
                    background: p.bgSoft,
                    border: `1px solid ${p.border}`,
                  }}
                >
                  {csatThanks ? (
                    <div className="text-center text-[13px] py-1" style={{ color: p.ink }}>
                      <span className="text-[18px] mr-1.5">✨</span>
                      Thanks — appreciated.
                    </div>
                  ) : (
                    <>
                      <div className="text-[12.5px] font-semibold" style={{ color: p.ink }}>
                        How was the chat?
                      </div>
                      <div className="text-[11px]" style={{ color: p.inkMuted }}>
                        Tap a star — your rating helps us improve.
                      </div>
                      <div className="flex items-center gap-1.5 py-1">
                        {[1, 2, 3, 4, 5].map((n) => {
                          const active = n <= (csatHoverRating || csatRating);
                          return (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setCsatRating(n)}
                              onMouseEnter={() => setCsatHoverRating(n)}
                              onMouseLeave={() => setCsatHoverRating(0)}
                              className="text-[22px] leading-none transition-transform hover:scale-110"
                              style={{
                                color: active ? 'var(--mc-warn)' : p.inkFaint,
                                background: 'transparent',
                                border: 'none',
                                padding: '2px 4px',
                                cursor: 'pointer',
                              }}
                              aria-label={`${n} star${n > 1 ? 's' : ''}`}
                            >
                              {active ? '★' : '☆'}
                            </button>
                          );
                        })}
                      </div>
                      {csatRating > 0 && (
                        <>
                          <textarea
                            value={csatComment}
                            onChange={(e) => setCsatComment(e.target.value.slice(0, 500))}
                            placeholder={csatRating >= 4 ? "What worked well? (optional)" : "What could we do better? (optional)"}
                            rows={2}
                            className="w-full px-3 py-2 rounded-lg text-[12.5px] focus:outline-none resize-none"
                            style={{
                              background: p.bgInput,
                              border: `1px solid ${p.border}`,
                              color: p.ink,
                              fontFamily: p.font,
                              minHeight: 50,
                              maxHeight: 90,
                            }}
                          />
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setCsatThreadId(null);
                                setCsatRating(0);
                                setCsatComment('');
                              }}
                              className="text-[11.5px] font-medium px-2.5 py-1 rounded"
                              style={{ background: 'transparent', color: p.inkMuted, border: 'none' }}
                            >
                              Skip
                            </button>
                            <button
                              type="button"
                              onClick={submitCsat}
                              disabled={csatSubmitting || csatRating < 1}
                              className="text-[11.5px] font-semibold px-3 py-1 rounded disabled:opacity-50"
                              style={{
                                background: p.invertBg,
                                color: p.invertText,
                                border: 'none',
                              }}
                            >
                              {csatSubmitting ? 'Sending…' : 'Submit'}
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Composer */}
              <div
                className="px-4 pt-3 pb-4 space-y-2.5"
                style={{ background: p.bg, borderTop: `1px solid ${p.border}` }}
              >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendMessage();
                  }}
                  className="flex items-end gap-2"
                >
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value.slice(0, MAX_INPUT_CHARS))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    rows={1}
                    placeholder={isStreaming ? 'Minica is typing…' : 'Ask Minica anything…'}
                    disabled={isStreaming}
                    className="flex-1 px-3.5 py-2.5 rounded-xl text-[13.5px] focus:outline-none transition-colors resize-none disabled:opacity-60"
                    style={{
                      background: p.bgInput,
                      border: `1px solid ${p.border}`,
                      color: p.ink,
                      fontFamily: p.font,
                      minHeight: 42,
                      maxHeight: 120,
                      lineHeight: 1.4,
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = p.ink; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = p.border; }}
                    autoFocus={mode !== 'floating'}
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || isStreaming}
                    aria-label="Send message"
                    className="w-[42px] h-[42px] rounded-xl flex items-center justify-center transition-opacity flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
                    style={{
                      background: p.invertBg,
                      color: p.invertText,
                    }}
                  >
                    {isStreaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  </button>
                </form>

                <div className="flex items-center justify-between gap-2 px-1">
                  {liveMode ? (
                    <button
                      type="button"
                      onClick={exitLiveMode}
                      className="text-[11px] transition-colors flex items-center gap-1 hover:underline"
                      style={{ color: p.accent }}
                    >
                      <X size={10} /> End live chat
                    </button>
                  ) : (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={enterLiveMode}
                        disabled={isStreaming}
                        className="text-[11px] transition-colors flex items-center gap-1 disabled:opacity-50 hover:underline"
                        style={{ color: p.accent }}
                      >
                        <Headphones size={10} /> Talk to a human
                      </button>
                      <button
                        type="button"
                        onClick={openHandoff}
                        disabled={isStreaming}
                        className="text-[10px] transition-colors flex items-center gap-1 disabled:opacity-50 hover:underline"
                        style={{ color: p.inkFaint }}
                      >
                        <Mail size={9} /> Leave a message
                      </button>
                    </div>
                  )}
                  <span
                    className="text-[10px] flex items-center gap-1"
                    style={{ color: p.inkFaint, letterSpacing: '0.02em' }}
                  >
                    {liveMode ? (
                      liveStatus === 'connected' && liveAgentName
                        ? <><Headphones size={9} /> {liveAgentName} · live</>
                        : liveStatus === 'waiting'
                        ? <><Loader2 size={9} className="animate-spin" /> finding agent…</>
                        : liveStatus === 'connecting'
                        ? <><Loader2 size={9} className="animate-spin" /> connecting…</>
                        : liveStatus === 'closed'
                        ? <>no agent · falling back</>
                        : <>live mode</>
                    ) : (
                      <><Sparkles size={9} /> AI · may make mistakes</>
                    )}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Scripted topics view ────────────────────────────────────────
// Shown to Free + anonymous users (the AI bot is gated on Basic+).
// Accordion-style category list, click a topic to expand its answer.
// Always-visible "Talk to a human" footer + upgrade CTA tuned to tier
// (anonymous → "Sign up free", free → "Upgrade to Basic").

interface ScriptedTopicsViewProps {
  palette: Palette;
  scripted: ScriptedBundle | null;
  scriptedError: string | null;
  expandedCategory: string | null;
  setExpandedCategory: (id: string | null) => void;
  expandedTopic: string | null;
  setExpandedTopic: (id: string | null) => void;
  tier: string | null;
  onOpenHandoff: () => void;
}

const ScriptedTopicsView: React.FC<ScriptedTopicsViewProps> = ({
  palette: p, scripted, scriptedError, expandedCategory, setExpandedCategory,
  expandedTopic, setExpandedTopic, tier, onOpenHandoff,
}) => {
  if (scriptedError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3" style={{ background: p.bg }}>
        <AlertCircle size={24} style={{ color: p.accent }} />
        <p className="text-[13px]" style={{ color: p.ink }}>{scriptedError}</p>
        <button
          onClick={onOpenHandoff}
          className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-medium"
          style={{ background: p.invertBg, color: p.invertText }}
        >
          <Mail size={13} /> Talk to a human
        </button>
      </div>
    );
  }
  if (!scripted) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: p.bg, color: p.inkMuted }}>
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const upgradeUrl = scripted.upgradeUrl || 'https://minicaai.com/#pricing';
  const upgradeLabel =
    tier === 'free'
      ? 'Upgrade to Basic to chat freely with Minica'
      : 'Sign up free to chat with Minica';

  return (
    <>
      {/* Header banner: explain scripted mode + nudge upgrade */}
      <div
        className="px-5 py-3 flex items-start gap-2.5"
        style={{ background: p.bgSoft, borderBottom: `1px solid ${p.border}` }}
      >
        <Lock size={14} style={{ color: p.inkMuted, marginTop: 2 }} className="flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-[12px] leading-relaxed" style={{ color: p.inkSoft }}>
            Pick a topic for a quick answer. Free plan and prospects get the topic picker — Basic, Pro, and Max chat freely with Minica.
          </p>
          <a
            href={upgradeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-medium hover:underline"
            style={{ color: p.accent }}
          >
            {upgradeLabel} <ArrowUpRight size={11} />
          </a>
        </div>
      </div>

      {/* Topic list */}
      <div className="flex-1 overflow-y-auto" style={{ background: p.bg }}>
        {scripted.categories.map((cat) => {
          const isCatOpen = expandedCategory === cat.id;
          return (
            <div key={cat.id} style={{ borderBottom: `1px solid ${p.border}` }}>
              <button
                type="button"
                onClick={() => {
                  setExpandedCategory(isCatOpen ? null : cat.id);
                  setExpandedTopic(null);
                }}
                className="w-full flex items-center justify-between px-5 py-3 text-left transition-colors"
                style={{
                  background: isCatOpen ? p.bgSoft : 'transparent',
                  color: p.ink,
                }}
              >
                <span className="text-[13px] font-semibold tracking-[-0.005em]">{cat.label}</span>
                <ChevronDown
                  size={15}
                  style={{
                    color: p.inkMuted,
                    transform: isCatOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 180ms ease',
                  }}
                />
              </button>
              {isCatOpen && (
                <div className="px-3 pb-3" style={{ background: p.bg }}>
                  {cat.topics.map((topic) => {
                    const isOpen = expandedTopic === topic.id;
                    return (
                      <div key={topic.id} className="mb-1.5">
                        <button
                          type="button"
                          onClick={() => setExpandedTopic(isOpen ? null : topic.id)}
                          className="w-full flex items-start justify-between gap-2 px-3 py-2.5 rounded-lg text-left transition-colors"
                          style={{
                            background: isOpen ? p.bgSoft : 'transparent',
                            color: p.inkSoft,
                            border: `1px solid ${isOpen ? p.border : 'transparent'}`,
                          }}
                        >
                          <span className="text-[12.5px] leading-snug">{topic.q}</span>
                          <ChevronRight
                            size={13}
                            style={{
                              color: p.inkMuted,
                              marginTop: 2,
                              transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                              transition: 'transform 180ms ease',
                              flexShrink: 0,
                            }}
                          />
                        </button>
                        {isOpen && (
                          <div
                            className="px-3 py-3 mt-1 rounded-lg text-[12.5px] leading-relaxed whitespace-pre-line"
                            style={{
                              background: p.bgSoft,
                              color: p.inkSoft,
                              border: `1px solid ${p.border}`,
                            }}
                          >
                            {topic.a}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <div className="h-2" />
      </div>

      {/* Footer: Talk to a human is always available */}
      <div
        className="px-4 py-3 flex items-center justify-between gap-2"
        style={{ background: p.bg, borderTop: `1px solid ${p.border}` }}
      >
        <button
          type="button"
          onClick={onOpenHandoff}
          className="flex-1 px-4 py-2.5 rounded-full text-[13px] font-medium flex items-center justify-center gap-2 transition-opacity hover:opacity-90"
          style={{ background: p.invertBg, color: p.invertText }}
        >
          <Mail size={13} /> Talk to a human
        </button>
      </div>
    </>
  );
};

export default SupportBot;
