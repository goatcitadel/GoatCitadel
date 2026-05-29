import { useCallback, useEffect, useRef } from "react";

/*
 * Shared mount-guard hook (MCNEXT-006).
 *
 * Imperative mutation handlers across the native routes and workflow panels
 * `setState` after an `await`. If the surface unmounts mid-flight (route
 * change, workspace switch, parent re-render swapping a lazy route) the
 * resolving promise would call setState on an unmounted tree. Wrapping the
 * post-await setState in `if (isMounted())` no-ops those late updates.
 *
 * Returns a stable getter (NOT the ref itself) so callers read the live value
 * at call time without taking a dependency on a changing object.
 */
export function useIsMounted(): () => boolean {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return useCallback(() => mountedRef.current, []);
}
