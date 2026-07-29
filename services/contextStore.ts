// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONTEXT OFFLOAD — upload the knowledge base once, send a hash
//
//  Before this, every question shipped the ENTIRE uploaded KB (up to
//  400K chars of resume + JD + notes) in the system prompt. Measured
//  with 100 files: ~2.4-3.2s to first paint vs ~350-700ms with none.
//  Provider prompt-caching had already removed the re-PREFILL cost, but
//  the bytes still had to be serialized, shipped and parsed on EVERY
//  request — and that all happens before the server can stream the
//  instant cover, so the user feels every one of those milliseconds.
//
//  Now: the blob is POSTed once to /api/v1/ai/context, and the prompt
//  carries a tiny ⟪CTX:<sha256>⟫ placeholder instead. The server swaps
//  the stored text back in immediately before the model call, so the
//  ASSEMBLED prompt is byte-identical to before — provider prompt caches
//  keep hitting — while the request body drops from ~400KB to ~4KB.
//
//  Self-healing: we keep hash → text in memory. If the server ever
//  reports `context_missing` (eviction, restart, a different instance
//  behind a load balancer), the transport re-uploads under the SAME hash
//  and retries the identical body — the placeholder becomes valid again
//  with no prompt rebuild. Any failure to upload simply returns the text
//  inline, i.e. exactly the pre-existing behavior.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { licenseService } from './licenseService';

// Mirrors aiProxyService's API_BASE resolution (see the comment there:
// a prod build must always point at prod regardless of .env.local).
const API_BASE = (import.meta as any).env?.PROD
  ? 'https://api.minicaai.com'
  : ((import.meta as any).env?.VITE_SERVER_URL || 'https://api.minicaai.com');

// Below this, a round-trip costs more than just inlining the text.
// A one-page resume (~4K chars) stays inline; a real multi-file KB
// (tens to hundreds of KB) gets offloaded.
const OFFLOAD_MIN_CHARS = 8_000;

// localKey (cheap non-crypto hash) → server sha256. Lets us skip
// re-uploading text we've already sent this session. We deliberately do
// NOT use crypto.subtle: it needs a secure context, and the packaged app
// renders from file://. The server computes the real sha256 and returns
// it, so integrity never depends on this local key.
const uploaded = new Map<string, string>();
// server sha256 → original text, for self-healing re-upload.
const hashToText = new Map<string, string>();

// Same djb2-style hash already used for the identity cache key.
function localKey(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  return `${text.length}:${h.toString(36)}`;
}

export function makePlaceholder(hash: string): string {
  return `⟪CTX:${hash}⟫`;
}

async function upload(text: string): Promise<string | null> {
  const token = licenseService.getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/api/v1/ai/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.hash !== 'string') return null;
    return data.hash;
  } catch {
    return null;
  }
}

// Offload `text` and return a placeholder to embed in the prompt. On any
// failure (not signed in, network down, server refuses) returns the
// ORIGINAL text so the caller's prompt is still correct — the feature can
// only ever make requests smaller, never break them.
export async function offloadContext(text: string): Promise<string> {
  if (!text || text.length < OFFLOAD_MIN_CHARS) return text;
  const key = localKey(text);
  const known = uploaded.get(key);
  if (known) {
    hashToText.set(known, text);
    return makePlaceholder(known);
  }
  const hash = await upload(text);
  if (!hash) return text;
  uploaded.set(key, hash);
  hashToText.set(hash, text);
  return makePlaceholder(hash);
}

// Re-upload every blob we've offloaded. Called by the transport when the
// server reports `context_missing`, so the very same request body can be
// retried with its placeholders intact. Returns true if anything was
// successfully restored.
export async function repairContext(): Promise<boolean> {
  if (hashToText.size === 0) return false;
  let restored = false;
  for (const [hash, text] of Array.from(hashToText.entries())) {
    const got = await upload(text);
    if (got === hash) restored = true;
    else if (got) {
      // Shouldn't happen (same bytes → same sha256) but stay consistent.
      hashToText.set(got, text);
      uploaded.set(localKey(text), got);
      restored = true;
    }
  }
  return restored;
}

// Test/diagnostic surface.
export function _contextStats() {
  return { uploadedKeys: uploaded.size, blobs: hashToText.size };
}
