import { useCallback, useLayoutEffect, useRef } from "react";

type WaveModule = typeof import("distortion-wave");
type WaveTransition = ReturnType<WaveModule["distortionWave"]>;
type ControlWaveOptions = { preserveText?: boolean; stopOnContentChange?: boolean };
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
let waveModule: Promise<WaveModule | undefined> | undefined;

const motionAllowed = () => typeof window.matchMedia === "function" && !window.matchMedia(REDUCED_MOTION).matches;

function loadControlWave() {
  return (waveModule ??= import("distortion-wave")
    .then((kit) => (kit.warmupWave() ? kit : undefined))
    .catch(() => undefined));
}

export function warmControlWave() {
  if (motionAllowed()) void loadControlWave();
}

export function useControlWave() {
  const cancel = useRef<(() => void) | undefined>(undefined);
  const stop = useCallback(() => {
    cancel.current?.();
    cancel.current = undefined;
  }, []);
  useLayoutEffect(() => stop, [stop]);

  // Action handlers stay synchronous. The wave reads the committed control in the next frame and
  // has no update callback. The caller retains authority over saves, state and keyboard focus.
  const play = useCallback(
    (target: HTMLElement, source: HTMLElement, focus?: MouseEvent, options?: ControlWaveOptions) => {
      stop();
      if (!motionAllowed()) return;

      let cancelled = false;
      let frame: number | undefined;
      let transition: WaveTransition | undefined;
      let changes: MutationObserver | undefined;
      cancel.current = () => {
        cancelled = true;
        if (frame !== undefined) cancelAnimationFrame(frame);
        changes?.disconnect();
        transition?.skip();
      };
      void loadControlWave().then((kit) => {
        if (!kit || cancelled) return;
        frame = requestAnimationFrame(() => {
          if (cancelled || !target.isConnected || !source.isConnected || !motionAllowed()) return;
          try {
            transition = kit.distortionWave(target, undefined, {
              source,
              focus,
              preserveFocus: false,
              ...(options?.preserveText ? { intensity: 0, blur: 0, blurNear: 0, blurAhead: 0, blurBehind: 0 } : {}),
            });
            // A live action can be relabelled again while its snapshot is on screen.
            if (options?.stopOnContentChange) {
              changes = new MutationObserver(() => {
                changes?.disconnect();
                transition?.skip();
              });
              changes.observe(target, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["disabled", "title", "class"],
              });
            }
            void Promise.allSettled([
              transition.ready,
              transition.covered,
              transition.updateCallbackDone,
              transition.finished,
            ]).then(() => changes?.disconnect());
          } catch {
            // The control has already applied the action and remains usable.
          }
        });
      });
    },
    [stop],
  );
  return { play, stop };
}
