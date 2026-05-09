// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  usePrefetchContext — speculative cache warming during transcription
//
//  Mounted alongside the speech recognition / chat input. Watches the
//  live transcript (inputText + interimText) and fires the server's
//  /prefetch-context endpoint after a debounce, so the eventual
//  /chat/* or /stream/* call hits warm Brave + page-content caches
//  instead of paying the full ~1500ms cold retrieval cost.
//
//  Two layers of protection against wasted work:
//    1. Client-side debounce (default 500ms) — only fire after the
//       transcript stabilizes (user paused speaking or typing)
//    2. Client-side dedup — track the last-sent transcript via ref
//       and skip if unchanged. The 30s server-side dedup (separate
//       in-memory map keyed by lowercased query) catches anything
//       that slips through.
//
//  Server-side classifier filters further:
//    - Only fires Brave for tool+specificity questions OR strong
//      update signals ("what's new in", "deprecated in")
//    - Generic conceptual questions ("what is recursion") return null
//      from the prefetch — the endpoint still 202s but does no work
//
//  Fires from BOTH main and popout windows. Server dedup catches the
//  duplicate when both windows have synced state for the same
//  transcript.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { useEffect, useRef } from 'react';
import { prefetchContext } from '../services/aiProxyService';

interface UsePrefetchContextProps {
  // Combined transcript (typically `${inputText} ${interimText}`).
  // Empty string is fine — hook short-circuits below minLength.
  transcript: string;

  // Disable in contexts where prefetch would be wasteful or wrong.
  // Default true. Caller passes false during e.g. processing states
  // where the input is locked.
  enabled?: boolean;

  // Debounce after the last transcript change. 500ms is the sweet
  // spot — long enough that one prefetch covers a multi-word burst,
  // short enough that prefetch finishes before the user clicks Send.
  debounceMs?: number;

  // Don't fire on tiny transcripts. "what" or "ok" wouldn't get
  // useful Brave results and just burn quota.
  minLength?: number;
}

export function usePrefetchContext({
  transcript,
  enabled = true,
  debounceMs = 500,
  minLength = 10,
}: UsePrefetchContextProps) {
  const lastSentRef = useRef<string>('');

  useEffect(() => {
    if (!enabled) return;
    const trimmed = (transcript || '').trim();
    if (trimmed.length < minLength) return;
    if (trimmed === lastSentRef.current) return;

    const timer = setTimeout(() => {
      lastSentRef.current = trimmed;
      // Fire-and-forget — prefetchContext already swallows all errors.
      // Note: this is intentionally NOT awaited. The hook should never
      // block React's commit phase on a network call.
      void prefetchContext(trimmed);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [transcript, enabled, debounceMs, minLength]);
}
