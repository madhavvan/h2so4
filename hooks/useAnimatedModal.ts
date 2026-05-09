// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  useAnimatedModal — mount/unmount with proper enter/exit transitions.
//
//  The naive `if (!isOpen) return null` pattern can't animate exits,
//  because React unmounts the component instantly and Tailwind never
//  gets a chance to interpolate from the open state to the closed
//  state. This hook gives us two distinct flags so the consumer can
//  drive a CSS transition cleanly:
//
//    isMounted  — whether the component is in the DOM at all.
//                 Goes true the moment isOpen=true, stays true for
//                 `duration` ms after isOpen=false so the exit
//                 animation can play out before unmount.
//    isVisible  — whether the "open" classes should apply. Lags
//                 isOpen by one animation frame on enter (so the
//                 browser has painted the closed-state classes once
//                 before they swap to open-state — that's what gives
//                 the transition something to interpolate from), and
//                 leads on exit (set false synchronously when isOpen
//                 flips, so the closing transition begins immediately
//                 and only THEN do we unmount after the duration).
//
//  Usage:
//    const { isMounted, isVisible } = useAnimatedModal(isOpen);
//    if (!isMounted) return null;
//    return (
//      <div className={`fixed inset-0 transition-opacity duration-200
//        ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
//        <div className={`transition-all duration-200 transform
//          ${isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}>
//          ...content...
//        </div>
//      </div>
//    );
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { useEffect, useState } from 'react';

export function useAnimatedModal(isOpen: boolean, durationMs: number = 220) {
  const [isMounted, setIsMounted] = useState(isOpen);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // Step 1: get into the DOM in the closed state.
      setIsMounted(true);
      // Step 2: on the next animation frame, flip the visible flag.
      // Without the rAF gap, React batches both state updates into the
      // same render and the browser only ever paints the open state —
      // the transition has nothing to interpolate from and we get an
      // instant pop, defeating the whole point of this hook.
      const raf = requestAnimationFrame(() => setIsVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    // isOpen=false path — only run if we were actually mounted, otherwise
    // an initial-closed render would set up a bogus unmount timeout.
    if (isMounted) {
      // Begin exit animation immediately.
      setIsVisible(false);
      // After the transition would have completed, unmount. Any rapid
      // re-open within the duration window cancels this via the cleanup
      // and we land back on the open path above with isMounted still true.
      const t = window.setTimeout(() => setIsMounted(false), durationMs);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [isOpen, isMounted, durationMs]);

  return { isMounted, isVisible };
}
