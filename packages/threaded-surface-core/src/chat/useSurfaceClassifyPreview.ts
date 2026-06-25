import { useEffect, useRef, useState } from "react";
import type { SurfaceClassifyResponse } from "@goatcitadel/contracts";
import { classifySurfaceMode } from "@goatcitadel/mission-control-shared/api/chat";

/** Debounce delay in milliseconds before issuing a classify request. */
const CLASSIFY_DEBOUNCE_MS = 350;

/** Minimum draft length (chars, trimmed) before classify is attempted. */
const MIN_DRAFT_LENGTH = 3;

export interface SurfaceClassifyPreviewInput {
  /** The current composer draft text. */
  draft: string;
  /**
   * Whether classify-preview is active. Should be `true` only for new threads
   * where no surface mode has been resolved/locked yet. Set to `false` for
   * existing sessions or when the mode has already been determined.
   */
  enabled: boolean;
  workspaceId?: string;
  citadelId?: string;
  hasBoundProject: boolean;
}

/**
 * Debounced, fail-open hook that previews which surface mode a new thread will
 * be routed to based on the current composer draft.
 *
 * - Never throws — classify errors silently yield `undefined`.
 * - When `enabled` is false or the draft is too short, returns `undefined`
 *   immediately without issuing any network request.
 * - Results are cleared whenever `enabled` toggles to false or the draft
 *   shrinks below the minimum length threshold.
 */
export function useSurfaceClassifyPreview(
  input: SurfaceClassifyPreviewInput,
): SurfaceClassifyResponse | undefined {
  const [preview, setPreview] = useState<SurfaceClassifyResponse | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!input.enabled || input.draft.trim().length < MIN_DRAFT_LENGTH) {
      setPreview(undefined);
      return;
    }

    if (timer.current) {
      clearTimeout(timer.current);
    }

    let cancelled = false;

    timer.current = setTimeout(() => {
      classifySurfaceMode({
        prompt: input.draft,
        workspaceId: input.workspaceId,
        citadelId: input.citadelId,
        hasBoundProject: input.hasBoundProject,
      })
        .then((r) => {
          if (!cancelled) setPreview(r);
        })
        .catch(() => {
          // Fail-open: any classify error is silently ignored.
          if (!cancelled) setPreview(undefined);
        });
    }, CLASSIFY_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [input.draft, input.enabled, input.workspaceId, input.citadelId, input.hasBoundProject]);

  return preview;
}
