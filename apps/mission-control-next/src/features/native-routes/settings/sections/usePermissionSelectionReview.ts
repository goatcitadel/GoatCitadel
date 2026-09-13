import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PermissionProfileSelectionReview, PermissionProfileSelectionReviewRequest } from "@goatcitadel/contracts";
import { reviewPermissionProfileSelection } from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "../SettingsShared";

/** Reviews belong to one visible owner and exact draft. Late replies never restore an earlier review. */
export function usePermissionSelectionReview(key: string) {
  const owner = useRef<string | null>(key);
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; pending: boolean; review?: PermissionProfileSelectionReview; error?: string } | null>(null);
  useLayoutEffect(() => {
    owner.current = key;
    sequence.current += 1;
    setState(null);
    return () => { owner.current = null; sequence.current += 1; };
  }, [key]);
  const clear = useCallback(() => { sequence.current += 1; setState(null); }, []);
  const request = useCallback(async (input: PermissionProfileSelectionReviewRequest) => {
    const attempt = ++sequence.current;
    setState({ key, pending: true });
    try {
      const review = await reviewPermissionProfileSelection(input);
      if (owner.current === key && sequence.current === attempt) setState({ key, pending: false, review });
    } catch (error) {
      if (owner.current === key && sequence.current === attempt) setState({ key, pending: false, error: getErrorMessage(error) });
    }
  }, [key]);
  const current = state?.key === key ? state : null;
  return { review: current?.review, pending: current?.pending ?? false, error: current?.error, request, clear,
    isCurrent: () => owner.current === key };
}
