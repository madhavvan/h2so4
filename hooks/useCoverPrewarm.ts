// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  useCoverPrewarm — write the opening line in time nobody is using
//
//  Sibling of usePrefetchContext, and deliberately the same shape: watch
//  the live transcript, wait for it to settle, fire one speculative request
//  the send path may or may not end up using.
//
//  WHY IT EXISTS. The cover used to be produced INSIDE the answer request:
//  runCover was awaited before the main provider call, so its chain budget
//  landed in front of every answer — +2,000ms on gemini deep, +4,500ms on
//  groq and xai. And when the grounding guard rejected the sentence, that
//  time bought the candidate nothing at all: no opener AND a later answer.
//  That is why the whole engine was left switched off for four releases.
//
//  The fix is not a faster model, it is a different moment. Between "the
//  speaker stopped" and "the question is sent" the app already waits
//  1,200ms for the auto-send timer. A cover takes 300-700ms. So it is
//  written there, for free, and a failed or rejected one costs nothing
//  because the question has not been asked yet.
//
//  ⚠️ IT DOES NOT KEY ON AUTO-SEND. The 1,200ms timer only exists when
//  autoSend is on, and it is OFF by default — a user who sends manually
//  would get no prewarm at all. Keying on the transcript SETTLING covers
//  both, and manual send gives a longer head start (human click time),
//  not a shorter one.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { useEffect, useRef } from 'react';
import { prewarmCover } from '../services/aiProxyService';
import type { ContextFile, Message } from '../types';

interface UseCoverPrewarmProps {
  /** Combined transcript, typically `${inputText} ${interimText}`. */
  transcript: string;

  /** The model that will ANSWER — it decides how much the cover must say. */
  provider: string;

  /** The knowledge base, for the digest and vocabulary the guard uses. */
  contextFiles: ContextFile[];

  /** Recent turns, so a follow-up is not answered by invention. */
  history?: Message[];

  /**
   * Off while the model is already generating, and off when there is no
   * live session to cover. A prewarm during an answer is answering a
   * question nobody asked yet.
   */
  enabled?: boolean;

  /**
   * How long the transcript must hold still.
   *
   * ⚠️ 350 → 150 (2026-08-20). 350ms was chosen when the cover model read a
   * ~2,800-token digest and answered in 300-700ms, leaving comfortable room
   * inside the 1,200ms auto-send timer. The cover now reads the candidate's
   * documents verbatim — measured 10,458 prompt tokens on a real upload,
   * TTFT median 889ms, p90 1,023ms — so the old debounce spends the margin
   * the cover needs. Measured live at 350ms: two of fifteen prewarms
   * returned at 1,771ms and 2,069ms, after the question had already been
   * sent, and were discarded.
   *
   * 150ms still coalesces a multi-word burst (speech finals land 200-400ms
   * apart) and hands ~1,050ms back to the model. The cost of going lower is
   * a superseded request per burst, and those are already cheap: the hook
   * aborts its own previous fetch and the server aborts the work behind it.
   */
  debounceMs?: number;

  /**
   * Below this, it is not a question. Matches the server's own floor, so a
   * request that would be refused is never sent.
   */
  minLength?: number;
}

export function useCoverPrewarm({
  transcript,
  provider,
  contextFiles,
  history,
  enabled = true,
  debounceMs = 150,
  minLength = 20,
}: UseCoverPrewarmProps) {
  const lastSentRef = useRef<string>('');
  // Read through refs so the effect depends only on the transcript. Without
  // this, a new contextFiles array identity on every render re-fires the
  // debounce forever — the speculative-work bug that pays for itself in
  // provider spend and is invisible until the bill arrives.
  const filesRef = useRef(contextFiles);
  const historyRef = useRef(history);
  const providerRef = useRef(provider);
  filesRef.current = contextFiles;
  historyRef.current = history;
  providerRef.current = provider;

  useEffect(() => {
    if (!enabled) return;
    const trimmed = (transcript || '').trim();
    if (trimmed.length < minLength) return;
    if (trimmed === lastSentRef.current) return;

    const timer = setTimeout(() => {
      lastSentRef.current = trimmed;
      // Never awaited — prewarmCover swallows everything and this must not
      // hold React's commit phase on a network call.
      void prewarmCover(trimmed, providerRef.current, filesRef.current || [], historyRef.current);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [transcript, enabled, debounceMs, minLength]);
}
