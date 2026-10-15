import type { Worker } from "node:worker_threads";

/** Observe immediately so a failed proof or cleanup cannot create an unhandled worker rejection. */
export function observeProofWorkerCompletion<T>(operation: Promise<T>) {
  let failure: { reason: unknown } | undefined;
  const completion = operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => {
      failure = { reason };
      return { status: "rejected" as const, reason };
    },
  );
  return {
    completion,
    throwIfFailed() {
      if (failure) throw failure.reason;
    },
  };
}

/** Preserve the originating failure identity, including its stack, at the actual await boundary. */
export function unwrapProofWorkerCompletion<T>(
  outcome: { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown },
): T {
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

/** Startup has its own existing 60s proof bound; lock acquisition keeps its original 10s bound. */
export function waitForProofWorkerReady(worker: Pick<Worker, "on" | "off">): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const signal = message as { type?: unknown; error?: unknown };
      if (signal.type === "ready") {
        cleanup();
        resolve();
      } else if (signal.type === "error") {
        cleanup();
        reject(new Error(String(signal.error ?? "Worker initialization failed")));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Worker exited before readiness (code ${code})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Worker initialization did not report readiness within 60s"));
    }, 60_000);
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}
