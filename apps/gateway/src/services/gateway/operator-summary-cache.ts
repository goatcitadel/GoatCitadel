import type { OperatorSummary } from "@goatcitadel/contracts";

export class OperatorSummaryCache {
  private cachedAt = 0;
  private cached: OperatorSummary[] | null = null;
  private inFlight?: Promise<OperatorSummary[]>;

  public constructor(private readonly ttlMs = 15_000) {}

  public get(loader: () => OperatorSummary[], now = Date.now()): OperatorSummary[] {
    if (this.cached && now - this.cachedAt < this.ttlMs) {
      return this.cached;
    }

    this.cached = loader();
    this.cachedAt = now;
    return this.cached;
  }

  public async getAsync(loader: () => Promise<OperatorSummary[]>, now = Date.now()): Promise<OperatorSummary[]> {
    if (this.cached && now - this.cachedAt < this.ttlMs) {
      return this.cached;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = loader().then((loaded) => {
      this.cached = loaded;
      this.cachedAt = now;
      return loaded;
    });
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  public invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
    this.inFlight = undefined;
  }
}
