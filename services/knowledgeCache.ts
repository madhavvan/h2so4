// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  KNOWLEDGE CACHE — one owner, one lifecycle
//
//  Before this there were six caches of the uploaded knowledge base, in
//  four files, with no shared notion of when a knowledge base stops being
//  current:
//
//    1. coverCtxFp / coverCtxValue          aiProxyService  (cover prose)
//    2. cachedFp / cachedIndex              kbRetrieval     (BM25 index)
//    3. identityCache / resolvedCards       aiProxyService  (briefing card)
//    4. claudeIdentityCache / …             claudeService   (briefing card)
//    5. uploaded / hashToText               contextStore    (offload blobs)
//    6. the server's per-user blob store    server/contextStore
//
//  Every one of them was keyed by a fingerprint of the files, so all six
//  were CORRECT when the files changed — a different fingerprint means a
//  rebuild. What none of them had was a way to be EMPTIED. Nothing in the
//  app could say "that knowledge base is finished with", so:
//
//    · deleting a file left its text in hashToText, and one server-side
//      eviction re-uploaded the deleted document (see repairContext)
//    · starting a new conversation left the previous conversation's resume
//      resident in five in-memory caches
//    · signing out left it there too
//
//  So there is now exactly one function that means "the knowledge base
//  changed" and exactly one that means "there is no knowledge base any
//  more", and they are the only things that touch those six caches.
//
//  Everything here is fire-and-forget and fails open. A cache that refuses
//  to warm costs latency; a cache that throws during an interview costs
//  the interview.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { ContextFile } from '../types';
import { Ledger, EMPTY_LEDGER, getLedgerFor, resetLedger, _ledgerBuilds } from './factLedger';
import {
  prewarmRetrieval, prewarmContext, prewarmIdentity,
  resetCoverContext, resetIdentityCache,
} from './aiProxyService';
import { resetIndex } from './kbRetrieval';
import { resetCoverSource } from './coverSource';
import { forgetAll, forgetExcept } from './contextStore';

/**
 * The fact ledger for these files. A memo hit on every call after the
 * first, so answer-time callers can treat it as free. The memo itself
 * lives in factLedger (a leaf module) to keep the import graph acyclic;
 * this module owns when it is emptied.
 */
export function getLedger(files: ContextFile[]): Ledger {
  return getLedgerFor(files);
}

/**
 * THE KNOWLEDGE BASE CHANGED — a file was added, removed, or edited.
 *
 * Rebuilds everything that can be rebuilt without a network call or a
 * paid API, right now, so that the first question after an upload pays for
 * none of it. Then hands the two things that DO cost money (the
 * context-store upload and the identity briefing card) to the existing
 * prewarm functions, which are already debounced by their caller.
 *
 * Also drops the offload blobs for documents that are no longer part of
 * the knowledge base — which is what makes "delete a file" mean it.
 */
export function syncKnowledge(files: ContextFile[]): Ledger {
  const list = files || [];
  if (list.length === 0) {
    forgetKnowledge();
    return EMPTY_LEDGER;
  }
  const ledger = getLedger(list);
  // Free, local, no quota: BM25 index + the cover's prose slice.
  try { prewarmRetrieval(list); } catch { /* fail open */ }
  // A document that is gone must not be re-uploadable.
  try {
    forgetExcept(list.filter((f) => !f.base64).map((f) => f.content || ''));
  } catch { /* fail open */ }
  return ledger;
}

/**
 * Network + paid warming. Separate from syncKnowledge because it must be
 * debounced (a five-file upload should extract one briefing card, not
 * five) while the free half above should not be.
 */
export function warmKnowledgeNetwork(files: ContextFile[]): void {
  const list = files || [];
  if (list.length === 0) return;
  try { prewarmContext(list); } catch { /* fail open */ }
  try { prewarmIdentity(list); } catch { /* fail open */ }
}

/**
 * THERE IS NO KNOWLEDGE BASE ANY MORE — new conversation, every file
 * deleted, or sign-out.
 *
 * Empties all six caches. Anything that survives this call is the previous
 * session's documents living in memory with nothing referencing them, which
 * is the state this function exists to make impossible.
 */
export function forgetKnowledge(): void {
  try { resetLedger(); } catch { /* fail open */ }
  try { resetIndex(); } catch { /* fail open */ }
  try { resetCoverContext(); } catch { /* fail open */ }
  // The verbatim cover source holds whole documents in memory and an
  // offload reference to them on the server. "New conversation" has to mean
  // both are gone, or the next interview's cover reads the last one's file.
  try { resetCoverSource(); } catch { /* fail open */ }
  try { resetIdentityCache(); } catch { /* fail open */ }
  try { forgetAll(); } catch { /* fail open */ }
  // The Claude-side briefing cache lives in claudeService, which imports
  // aiProxyService; importing it here would close a cycle
  // (knowledgeCache → claudeService → aiProxyService → …). It registers
  // itself instead. See registerForgetHook below.
  for (const hook of hooks) { try { hook(); } catch { /* fail open */ } }
}

// ── Late-bound participants ──
// A module that cannot be imported here without creating a cycle registers
// its own reset. claudeService does exactly this at load time.
type ForgetHook = () => void;
const hooks: ForgetHook[] = [];
export function registerForgetHook(fn: ForgetHook): void {
  if (typeof fn === 'function' && !hooks.includes(fn)) hooks.push(fn);
}

/** Test/diagnostic: how many times the ledger has actually been built. */
export function ledgerBuildCount(): number { return _ledgerBuilds(); }
export function _knowledgeState() {
  return { builds: _ledgerBuilds(), hooks: hooks.length };
}
