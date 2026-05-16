export interface StartupPhaseRecord {
  readonly id: string;
  readonly owner: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly notes?: string;
}

export interface StartupPhaseInProgress {
  readonly id: string;
  readonly owner: string;
  readonly startedAt: string;
  readonly ageMs: number;
}

export interface StartupPhaseSnapshot {
  readonly phases: readonly StartupPhaseRecord[];
  readonly inProgress: readonly StartupPhaseInProgress[];
  readonly ready: boolean;
}

export interface OpenPhaseOptions {
  readonly owner: string;
  readonly notes?: string;
}

export interface OpenPhase {
  close(notes?: string): void;
}

export type InProgressLogger = (entry: { phase: string; owner: string; ageMs: number }) => void;

interface InternalPhase {
  id: string;
  owner: string;
  startMs: number;
  endMs?: number;
  notes?: string;
}

export class StartupPhaseRecorder {
  private readonly phases: InternalPhase[] = [];
  private readonly lastEmitAt = new Map<string, number>();
  private ready = false;

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly onInProgress?: InProgressLogger,
  ) {}

  public open(id: string, options: OpenPhaseOptions): OpenPhase {
    const entry: InternalPhase = {
      id,
      owner: options.owner,
      startMs: this.now(),
      notes: options.notes,
    };
    this.phases.push(entry);
    return {
      close: (notes?: string) => {
        entry.endMs = this.now();
        if (notes) {
          entry.notes = notes;
        }
      },
    };
  }

  public markReady(): void {
    this.ready = true;
  }

  public tick(): void {
    if (!this.onInProgress) {
      return;
    }
    const ts = this.now();
    for (const p of this.phases) {
      if (p.endMs !== undefined) {
        continue;
      }
      const age = ts - p.startMs;
      if (age < 5000) {
        continue;
      }
      const lastEmit = this.lastEmitAt.get(p.id) ?? -Infinity;
      if (ts - lastEmit < 10_000) {
        continue;
      }
      this.onInProgress({ phase: p.id, owner: p.owner, ageMs: age });
      this.lastEmitAt.set(p.id, ts);
    }
  }

  public snapshot(): StartupPhaseSnapshot {
    const ts = this.now();
    const closed: StartupPhaseRecord[] = [];
    const open: StartupPhaseInProgress[] = [];
    for (const p of this.phases) {
      if (p.endMs !== undefined) {
        closed.push({
          id: p.id,
          owner: p.owner,
          startedAt: new Date(p.startMs).toISOString(),
          finishedAt: new Date(p.endMs).toISOString(),
          durationMs: p.endMs - p.startMs,
          notes: p.notes,
        });
      } else {
        open.push({
          id: p.id,
          owner: p.owner,
          startedAt: new Date(p.startMs).toISOString(),
          ageMs: ts - p.startMs,
        });
      }
    }
    return { phases: closed, inProgress: open, ready: this.ready };
  }
}

let singleton: StartupPhaseRecorder | undefined;

export function getStartupPhaseRecorder(logger?: InProgressLogger): StartupPhaseRecorder {
  if (!singleton) {
    singleton = new StartupPhaseRecorder(Date.now, logger);
  }
  return singleton;
}

export function resetStartupPhaseRecorderForTests(): void {
  singleton = undefined;
}
