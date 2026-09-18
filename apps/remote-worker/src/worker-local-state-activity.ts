import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkerStateWriterGate {
  pause(): void;
  /** Reacquire writer custody even after caller cancellation; never resume
   * mutations while the controller still owns measurement exclusion. */
  resume(): Promise<void>;
}

/** Coordinates this Node process's registered writers only. Other processes,
 * earlier worker lifetimes, and unregistered calls require separate custody. */
export class WorkerLocalStateActivity {
  private tail: Promise<void> = Promise.resolve();
  private readonly scope = new AsyncLocalStorage<{ active: boolean }>();
  private externalWriters = 0;
  private observing = false;
  private gate?: WorkerStateWriterGate;
  private started = false;
  private failed = false;

  installWriterGate(gate: WorkerStateWriterGate): void {
    if (this.started || this.gate || typeof gate.pause !== "function" || typeof gate.resume !== "function")
      throw new Error("Worker writer gate must be installed before activity starts.");
    this.gate = Object.freeze({ pause: gate.pause.bind(gate), resume: gate.resume.bind(gate) });
  }

  /** Reserve synchronously before launching a writer that needs concurrent state
   * saves. Only joined, proven cleanup releases it; uncertainty remains sticky
   * for this owner lifetime. This is not persisted cross-process custody. */
  beginExternalWriter(): (cleanupVerified: boolean) => void {
    this.started = true;
    if (this.failed) throw new Error("Worker writer custody is unavailable.");
    if (this.observing) throw new Error("Worker measurement is active.");
    this.externalWriters++;
    let finished = false;
    return (cleanupVerified) => {
      if (finished) return;
      finished = true;
      if (cleanupVerified === true) this.externalWriters--;
    };
  }

  mutation<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.run(work, signal);
  }

  /** Drain earlier mutations and withhold later ones until the callback settles.
   * Aborting an active callback never releases its exclusion prematurely. */
  quiescent<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.run(async () => {
      if (this.externalWriters) throw new Error("Worker external writer cleanup is not verified.");
      this.observing = true;
      try {
        try { this.gate?.pause(); }
        catch (error) { this.failed = true; throw error; }
        try { return await work(); }
        finally {
          try { await this.gate?.resume(); }
          catch (error) { this.failed = true; throw error; }
        }
      }
      finally { this.observing = false; }
    }, signal);
  }

  private async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.started = true;
    signal?.throwIfAborted();
    if (this.scope.getStore()?.active) throw new Error("Worker state activity cannot be nested.");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await waitForTurn(previous, signal);
    } catch (error) {
      // A cancelled waiter must not let its successors overtake an active owner.
      void previous.then(release);
      throw error;
    }
    const frame = { active: true };
    try {
      signal?.throwIfAborted();
      if (this.failed) throw new Error("Worker writer custody is unavailable.");
      const result = await this.scope.run(frame, work);
      signal?.throwIfAborted();
      return result;
    } finally {
      frame.active = false;
      release();
    }
  }
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  return new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void previous.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

export const workerLocalStateActivity = new WorkerLocalStateActivity();
