import {
  ConflictError,
  type ChangePlanManagedSourceRegistrationRequest,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
  EvolutionControlPlaneOwnerInputReceipt,
} from "./evolution-control-plane-adapter.js";
import type { ManagedSourceInstallService } from "./managed-source-install-service.js";

type ManagedSourceOwner = Pick<
  ManagedSourceInstallService,
  "activateCandidate" | "discardCandidate" | "inspectRegistered" | "project"
>;

export class ManagedSourceRegistrationChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanManagedSourceRegistrationRequest> {
  public readonly adapterId = "managed-source-registration";
  public readonly version = 1;
  public readonly kinds = ["managed_source_registration"] as const;

  public constructor(private readonly owner: ManagedSourceOwner) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext) {
    return {
      target: { ownerId: "managed_source_registry", resourceId: "goatcitadel-source-v1" },
      title: "Register this GoatCitadel source install",
      summary: "Choose one clean GoatCitadel Git checkout through the native desktop picker.",
      impact:
        "The Gateway stores the canonical path privately and binds future source updates to its exact Git baseline. Registration does not modify source files.",
      risk: "caution" as const,
      status: "awaiting_input" as const,
      requiredAction: context.actions.nativePathPicker({ title: "Choose clean GoatCitadel source root" }),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  public async resumeOwnerInput(
    context: EvolutionControlPlaneAdapterContext,
    _plan: ChangePlanRecord,
    receipt: EvolutionControlPlaneOwnerInputReceipt,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (
      receipt.actionKind !== "native_path_picker" ||
      receipt.ownerId !== "managed_source_candidate" ||
      receipt.ownerRevision === undefined
    ) {
      throw new ConflictError({ message: "Managed source picker receipt is invalid or stale." });
    }
    const candidateRef = candidateReference(receipt.ownerResourceId, receipt.ownerRevision);
    return {
      status: "awaiting_confirmation",
      evidenceRefs: [candidateRef, ...(receipt.evidenceRefs ?? [])],
      requiredAction: context.actions.confirmation({
        title: "Confirm managed source registration",
        confirmationText:
          "Revalidate the exact clean Git baseline and register this source install for governed updates.",
      }),
      result: {
        summary:
          "The selected GoatCitadel checkout passed private path, Git identity, cleanliness, and fixed-volume checks.",
      },
    };
  }

  public async apply(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const candidate = requireCandidateReference(plan.evidenceRefs);
    const active = await this.owner.activateCandidate(candidate.installId, candidate.revision);
    const projected = this.owner.project(active);
    return {
      status: "verifying",
      evidenceRefs: [
        candidateReference(active.installId, active.revision),
        `managed-source-baseline:${active.baselineSha}:${active.baselineTree}`,
      ],
      result: {
        summary: `${projected.label} is registered for governed source evolution. Live apply support: ${projected.liveApplySupported ? "Windows verified helper required" : "stage and review only"}.`,
        appliedRevision: active.revision,
      },
    };
  }

  public async verify(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const candidate = requireCandidateReference(plan.evidenceRefs);
    const inspected = await this.owner.inspectRegistered(candidate.installId);
    if (inspected.record.status !== "active" || !inspected.matchesBaseline) {
      return manual("The registered source owner no longer matches its approved clean baseline.");
    }
    return {
      status: "completed",
      evidenceRefs: [`managed-source-install:${inspected.record.installId}:${inspected.record.revision}`],
      result: plan.result ?? { summary: "The managed source registration is active and baseline-bound." },
    };
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    let candidate: { installId: string; revision: number };
    try {
      candidate = requireCandidateReference(plan.evidenceRefs);
      const inspected = await this.owner.inspectRegistered(candidate.installId);
      if (inspected.record.status === "active" && inspected.matchesBaseline) {
        return {
          effectObserved: true,
          status: "completed" as const,
          evidenceRefs: [`managed-source-install:${inspected.record.installId}:${inspected.record.revision}`],
          result: plan.result ?? { summary: "Owner state proves the managed source registration is active." },
        };
      }
    } catch {
      // Fall through to fail-closed recovery.
    }
    return {
      effectObserved: false,
      ...manual("Managed source activation could not be proven after restart; it was not replayed."),
    };
  }

  public async discard(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord): Promise<void> {
    try {
      const candidate = requireCandidateReference(plan.evidenceRefs);
      await this.owner.discardCandidate(candidate.installId, candidate.revision);
    } catch {
      // No candidate or already activated/removed: cancellation remains idempotent.
    }
  }
}

export function candidateReference(installId: string, revision: number): string {
  return `managed-source-candidate:${installId}:${revision}`;
}

function requireCandidateReference(refs: readonly string[]): { installId: string; revision: number } {
  for (const ref of refs) {
    const match = /^managed-source-candidate:([A-Za-z0-9._@/-]+):(\d+)$/u.exec(ref);
    if (!match) continue;
    const revision = Number(match[2]);
    if (Number.isSafeInteger(revision) && revision >= 1) return { installId: match[1]!, revision };
  }
  throw new ConflictError({ message: "Managed source candidate evidence is unavailable." });
}

function manual(summary: string): EvolutionControlPlaneAdapterOutcome {
  return { status: "manual_required", result: { summary, failureCode: "managed_source_revalidation_failed" } };
}
