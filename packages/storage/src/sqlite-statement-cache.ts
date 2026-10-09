/**
 * Least-recently-used cache of compiled statements keyed by SQL text. The
 * compile function is injected so the client passes the native `prepare` and
 * tests can count compilations.
 */
export class BoundedStatementCache<T> {
  private readonly entries = new Map<string, T>();

  public constructor(
    private readonly limit: number,
    private readonly compile: (sql: string) => T,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Statement cache limit must be a positive integer.");
    }
  }

  public get size(): number {
    return this.entries.size;
  }

  /** Returns the compiled statement for `sql`, compiling it only on a miss. */
  public get(sql: string): T {
    const cached = this.entries.get(sql);
    if (cached !== undefined) {
      // Re-insert so Map order tracks recency; the first key is the oldest.
      this.entries.delete(sql);
      this.entries.set(sql, cached);
      return cached;
    }
    const compiled = this.compile(sql);
    this.entries.set(sql, compiled);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return compiled;
  }

  public clear(): void {
    this.entries.clear();
  }
}
