import { useEffect, useState } from "react";

export function createApprovalCodeLoader<T>(load: () => Promise<T>) {
  let code: T | undefined;
  let pending: Promise<T> | undefined;
  return {
    peek: () => code,
    load: () =>
      (pending ??= load().then(
        (loaded) => (code = loaded),
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      )),
  };
}

export function useDeferredApprovalCode<T>(loader: ReturnType<typeof createApprovalCodeLoader<T>>, enabled: boolean) {
  const [loaded, setLoaded] = useState<T>();
  const [failed, setFailed] = useState(false);
  const code = loaded ?? loader.peek();
  useEffect(() => {
    if (!enabled || code) return;
    let current = true;
    setFailed(false);
    void loader.load().then(
      (value) => {
        if (current) setLoaded(() => value);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [code, enabled, loader]);
  return { code, loading: enabled && !code && !failed, unavailable: enabled && !code && failed };
}
