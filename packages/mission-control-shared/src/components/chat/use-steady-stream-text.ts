// Adapted from hob's useSteadyText (https://github.com/FrigadeHQ/hob, MIT, Copyright (c) 2026 Frigade).
import { useEffect, useRef, useState } from "react";

/** How often the shown text grows while it catches up. */
export const STEADY_STREAM_TICK_MS = 16;
/** Each tick shows this share of what is still hidden, so a big burst is caught up within a few frames. */
const STEADY_STREAM_CATCH_UP_SHARE = 6;
const STEADY_STREAM_MIN_STEP = 2;

/**
 * Streamed text arrives in bursts; show it at a steady pace instead. It catches up within a few frames, so it never
 * lags far behind, and text that is not paced (a settled answer, Instant mode) shows in full at once. The result is
 * always a prefix of `target`. A timer rather than animation frames: those stop in a hidden window, and the text
 * would freeze there.
 */
export function useSteadyStreamText(target: string, paced: boolean): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    if (!paced) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    // A replaced text (a reset) starts over instead of slicing the old position into it.
    let at = target.startsWith(shownRef.current) ? shownRef.current.length : 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (at >= target.length) return;
      at = Math.min(
        target.length,
        at + Math.max(STEADY_STREAM_MIN_STEP, Math.ceil((target.length - at) / STEADY_STREAM_CATCH_UP_SHARE)),
      );
      shownRef.current = target.slice(0, at);
      setShown(shownRef.current);
      timer = setTimeout(tick, STEADY_STREAM_TICK_MS);
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [target, paced]);
  if (!paced) return target;
  return target.startsWith(shown) ? shown : "";
}
