import { GoatError, type ChangePlanCapabilityPackRequest, type ChangePlanRecord } from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneReconcileOutcome,
} from "./evolution-control-plane-adapter.js";

// Capability packs were replaced by plugins. Plans an older Gateway made keep their kind and adapter identity, so they
// still list and read, and startup still recovers them; this adapter refuses every action on them.

const RETIRED_MESSAGE = "Capability packs were replaced by plugins.";

/** 409 `CAPABILITY_PACKS_RETIRED`: an action on a capability pack plan, or a new one. */
export class CapabilityPacksRetiredError extends GoatError {
  public readonly code = "CAPABILITY_PACKS_RETIRED" as const;
  public readonly httpStatus = 409;

  public constructor() {
    super(RETIRED_MESSAGE);
  }
}

/** Keeps the old pack adapter's identity, so `capability-pack-execution@1` plans still match it. */
export class RetiredCapabilityPackChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanCapabilityPackRequest> {
  public readonly adapterId = "capability-pack-execution";
  public readonly version = 1;
  public readonly kinds = ["capability_pack"] as const;

  public refuseAction(): never {
    throw new CapabilityPacksRetiredError();
  }

  public async prepare(): Promise<never> {
    return this.refuseAction();
  }

  public async apply(): Promise<never> {
    return this.refuseAction();
  }

  public async verify(): Promise<never> {
    return this.refuseAction();
  }

  public async rollback(): Promise<never> {
    return this.refuseAction();
  }

  public async respond(): Promise<never> {
    return this.refuseAction();
  }

  public async reviewArtifacts(): Promise<never> {
    return this.refuseAction();
  }

  public async resumeOwnerInput(): Promise<never> {
    return this.refuseAction();
  }

  /** Expiry and a refused approval call this: a pack plan left nothing temporary behind to delete. */
  public async discard(): Promise<void> {
    return undefined;
  }

  /**
   * Startup recovery leaves a monitoring plan as it is. A plan stopped in any other live step can't stay there (no
   * step goes back to itself), so it settles as needing the operator, with the retired words.
   */
  public async reconcile(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneReconcileOutcome> {
    const kept = { evidenceRefs: plan.evidenceRefs, rollbackRefs: plan.rollbackRefs, effectObserved: false };
    if (plan.status === "monitoring") return { ...kept, status: "monitoring", result: plan.result };
    return {
      ...kept,
      status: "manual_required",
      result: { summary: RETIRED_MESSAGE, failureCode: "capability_packs_retired" },
    };
  }
}
