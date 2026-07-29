// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE BRIDGE — the two places the desktop UI and the phone's
//  host have to meet, kept in one small module instead of threaded
//  through props.
//
//  1. THE LIVE HOST. App.tsx owns its lifecycle, but deeply-nested
//     components (a code block, ten messages up a conversation) also
//     need to publish. Prop-drilling a socket down a memoized markdown
//     renderer would invalidate every code block on every reconnect.
//
//  2. THE AUTO-TYPE REGISTRY. This one is a deliberate design choice
//     worth the paragraph:
//
//     Auto-Type lives inside CodeBlock — permission check, editor
//     scan, countdown, the IPC to main, and the phase state that
//     drives the button's label. A phone tapping "Auto-Type" must run
//     THAT code, not a second copy of it. So each code block registers
//     its own runner here while mounted, and the phone's command
//     resolves to the same function the mouse would have called.
//
//     The consequence is the good kind: the desktop's own button
//     animates through "Typing in 3… 2… 1…" exactly as if it had been
//     clicked, because it was. There is one Auto-Type, with two ways
//     to reach it.
//
//     Keyed by the code itself. Two identical blocks collide and the
//     later one wins — which is correct, because running either types
//     the same characters.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import type { RemoteHost } from './remoteHost';

/** Set by App.tsx while the main window is hosting; null otherwise. */
export const remoteHostRef: { current: RemoteHost | null } = { current: null };

/** Publish without caring whether a phone is connected. */
export function publishRemote(type: string, data: Record<string, any> = {}) {
  remoteHostRef.current?.publish(type as any, data);
}

const autoTypeRunners = new Map<string, () => void>();

/**
 * Called by CodeBlock on mount. Returns its own unregister so the effect
 * can clean up — a runner left behind after unmount would setState on a
 * dead component and, worse, report success for a block no longer on
 * screen.
 */
export function registerAutoTypeBlock(code: string, run: () => void): () => void {
  autoTypeRunners.set(code, run);
  return () => {
    // Only delete if we are still the owner. A re-render that registers
    // an identical block before the old one unmounts would otherwise
    // have its runner removed by the outgoing cleanup.
    if (autoTypeRunners.get(code) === run) autoTypeRunners.delete(code);
  };
}

/** Fenced code blocks of a markdown answer, in the order they appear. */
export function extractCodeBlocks(markdown: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) out.push(m[1].replace(/\n$/, ''));
  return out;
}

/**
 * Run the auto-typer for a specific block of a specific answer.
 *
 * Resolution is deliberately by CONTENT, not by index into a registry:
 * the phone names a block ("the 2nd code block of the newest answer"),
 * the desktop turns that into the actual code, and only then looks for
 * the mounted block that owns it. If the conversation moved on and that
 * block is gone, this fails loudly rather than typing something else.
 */
export function runAutoTypeForCode(code: string): { ok: boolean; reason?: string } {
  const run = autoTypeRunners.get(code);
  if (!run) return { ok: false, reason: 'block_not_on_screen' };
  try { run(); return { ok: true }; }
  catch (e: any) { return { ok: false, reason: String(e?.message || e).slice(0, 120) }; }
}

/** Test/diagnostic hook — how many blocks are currently typeable. */
export function autoTypeBlockCount(): number { return autoTypeRunners.size; }
