import { useEffect, useRef, useSyncExternalStore } from "react";
import { getGatewayAccessRevision, subscribeGatewayAccessChange } from "../api/access-scope";
/** Public drafts survive recovery; an authorization review never transfers to another caller. */
export function useAccessBoundReview(open: boolean, onClose: () => void): boolean {
  const revision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  const reviewed = useRef(revision);
  if (!open) reviewed.current = revision;
  const current = reviewed.current === revision;
  useEffect(() => {
    if (open && !current) onClose();
  }, [open, current, onClose]);
  return current;
}
