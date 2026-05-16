import type { CuratorScopeKind, CuratorScopeViolation } from "@goatcitadel/contracts";

const ALLOWED_KINDS = new Set<string>(["skill", "memory"]);

export interface CuratorScopeGuardOptions {
  recordViolation?: (violation: CuratorScopeViolation) => void;
}

export class CuratorScopeGuard {
  public constructor(private readonly options: CuratorScopeGuardOptions = {}) {}

  public assertScopeAllowed(kind: string): asserts kind is CuratorScopeKind {
    if (!ALLOWED_KINDS.has(kind)) {
      const violation: CuratorScopeViolation = {
        attemptedKind: kind,
        reason: "Only 'skill' and 'memory' scopes allowed in curator/improvement background runs",
      };
      this.options.recordViolation?.(violation);
      throw new Error(`Curator scope violation: ${violation.reason} (attempted=${kind})`);
    }
  }
}
