import {
  ConflictError,
  SemanticValidationError,
  ServiceUnavailableError,
  type ChangePlanProductSourceUpdateRequest,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { ManagedSourceInstallRecord, ProductSourceUpdateManifestRecord } from "@goatcitadel/storage";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
} from "./evolution-control-plane-adapter.js";
import type { ProductSourceUpdatePublicManifest, ProductSourceUpdateService } from "./product-source-update-service.js";

export type ProductSourceApplyObservation =
  | { readonly status: "not_started" | "running"; readonly evidenceRefs?: readonly string[] }
  | {
      readonly status: "succeeded" | "rolled_back";
      readonly baselineSha: string;
      readonly baselineTree: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: "failed" | "rollback_failed";
      readonly failureCode: string;
      readonly evidenceRefs?: readonly string[];
    };

export interface ProductSourceApplySupervisorPort {
  launchApply(input: {
    plan: ChangePlanRecord;
    manifest: ProductSourceUpdateManifestRecord;
    approvalIds: readonly string[];
  }): Promise<ProductSourceApplyObservation>;
  inspect(manifest: ProductSourceUpdateManifestRecord): Promise<ProductSourceApplyObservation>;
  launchRollback(input: {
    plan: ChangePlanRecord;
    manifest: ProductSourceUpdateManifestRecord;
  }): Promise<ProductSourceApplyObservation>;
}

type SourceUpdates = Pick<
  ProductSourceUpdateService,
  "appendEvent" | "getManifestForPlan" | "inspectInstall" | "listEvents" | "project" | "stage" | "verifyManifest"
>;

export interface ProductSourceUpdateChangePlanAdapterDependencies {
  readonly sourceUpdates: SourceUpdates;
  readonly supervisor: ProductSourceApplySupervisorPort;
  readonly createProtectedApproval: (
    plan: ChangePlanRecord,
    manifest: ProductSourceUpdatePublicManifest,
  ) => Promise<string>;
  readonly acceptAppliedBaseline: (input: {
    installId: string;
    expectedRevision: number;
    expectedPreviousSha: string;
    baselineSha: string;
    baselineTree: string;
  }) => Promise<ManagedSourceInstallRecord>;
  readonly isEnabled?: () => boolean | Promise<boolean>;
}

/**
 * Governs review and promotion of a Code Mode source candidate. Code Mode owns
 * generation; the Gateway staging owner captures immutable bytes; this
 * adapter alone can ask the narrow supervisor to promote them.
 */
export class ProductSourceUpdateChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanProductSourceUpdateRequest> {
  public readonly adapterId = "product-source-update";
  public readonly version = 1;
  public readonly kinds = ["product_source_update"] as const;

  public constructor(private readonly deps: ProductSourceUpdateChangePlanAdapterDependencies) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanProductSourceUpdateRequest) {
    if (this.deps.isEnabled && !(await this.deps.isEnabled())) {
      throw new ServiceUnavailableError("Product source evolution is disabled by rollout policy.");
    }
    const inspection = await this.deps.sourceUpdates.inspectInstall(request.sourceInstallId);
    return {
      target: {
        ownerId: "managed_source_install",
        resourceId: inspection.record.installId,
        expectedRevision: inspection.record.revision,
        expectedHash: inspection.record.baselineSha,
      },
      title: `Prepare update for ${inspection.record.label}`,
      summary: request.changeSummary,
      impact:
        "The Gateway will capture the exact verified Code Mode patch in private immutable artifacts. The registered live source is not modified while staging.",
      risk: "danger" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({
        title: "Stage source update for review",
        confirmationText:
          "Run the Gateway-selected checks and capture an exact reversible patch from the linked verified Code Mode worktree.",
      }),
      evidenceRefs: [
        `code-mode-run:${request.codeModeRunId}`,
        `managed-source-baseline:${inspection.record.baselineSha}:${inspection.record.baselineTree}`,
      ],
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    };
  }

  public shouldStage(plan: ChangePlanRecord): boolean {
    return !plan.evidenceRefs.some((ref) => ref.startsWith("product-source-manifest:"));
  }

  public async stage(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    const manifest = await this.deps.sourceUpdates.stage({
      planId: plan.planId,
      workspaceId: context.origin.workspaceId,
      sourceInstallId: request.sourceInstallId,
      codeModeRunId: request.codeModeRunId,
      changeSummary: request.changeSummary,
    });
    assertPlanTarget(plan, manifest);
    const projected = this.deps.sourceUpdates.project(manifest);
    const refs = artifactRefs(manifest);
    return {
      status: "awaiting_input",
      target: { ...plan.target, expectedHash: manifest.manifestSha256 },
      evidenceRefs: evidenceRefs(manifest),
      rollbackRefs: [rollbackRef(manifest)],
      requiredAction: context.actions.artifactReview({
        title: projected.applyEligible ? "Review the exact source update" : "Review the staged source update blockers",
        artifactRefs: refs,
      }),
      result: {
        summary: projected.applyEligible
          ? `${projected.changedFiles.length} changed file(s) passed the selected staging proofs. The live source remains unchanged.`
          : `The patch was captured for review but cannot be applied: ${projected.blockers.join(", ")}.`,
        evidenceRefs: evidenceRefs(manifest),
        rollbackRef: rollbackRef(manifest),
      },
    };
  }

  public async reviewArtifacts(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    reviewedArtifactRefs: readonly string[],
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const manifest = await this.requireVerifiedManifest(plan);
    assertExactRefs(reviewedArtifactRefs, artifactRefs(manifest));
    const projected = this.deps.sourceUpdates.project(manifest);
    if (!projected.applyEligible) {
      await this.appendEvent(manifest, "manual_required", `review-blocked:${plan.revision}`, {
        blockers: projected.blockers,
      });
      return {
        status: "manual_required",
        evidenceRefs: evidenceRefs(manifest),
        rollbackRefs: [rollbackRef(manifest)],
        result: {
          summary: `The reviewed source update requires manual proof before live apply: ${projected.blockers.join(", ")}.`,
          failureCode: "source_update_proof_blocked",
        },
      };
    }
    return {
      status: "awaiting_confirmation",
      evidenceRefs: evidenceRefs(manifest),
      rollbackRefs: [rollbackRef(manifest)],
      requiredAction: context.actions.confirmation({
        title: "Apply and restart",
        confirmationText: `Apply only manifest ${manifest.manifestId} (${manifest.manifestSha256.slice(0, 12)}) to the registered source, restart GoatCitadel, smoke-check it, and automatically restore the approved rollback patch on failure.`,
      }),
      result: {
        summary:
          "The exact immutable patch and selected proof results were reviewed. No live source mutation has occurred.",
      },
    };
  }

  public async apply(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const manifest = await this.requireVerifiedManifest(plan);
    const projected = this.deps.sourceUpdates.project(manifest);
    if (!projected.applyEligible)
      return manual("The source update no longer satisfies its apply proof requirements.", "source_update_proof_drift");
    if (plan.approvalRefs.length < 1) {
      throw new ConflictError({ message: "Product source apply requires the canonical Apply and restart approval." });
    }
    if (manifest.riskClass === "protected_core" && plan.approvalRefs.length < 2) {
      const approvalId = requireApprovalId(await this.deps.createProtectedApproval(plan, projected));
      await this.appendEvent(manifest, "protected_approval_requested", `protected-approval:${approvalId}`, {
        approvalId,
        protectedAreas: manifest.protectedAreas,
      });
      return {
        status: "awaiting_approval",
        approvalRefs: [approvalId],
        evidenceRefs: evidenceRefs(manifest),
        rollbackRefs: [rollbackRef(manifest)],
        requiredAction: context.actions.approval({
          title: "Approve protected-core source update",
          risk: "danger",
          approvalId,
        }),
        result: {
          summary: `Protected areas require a second specialized approval: ${manifest.protectedAreas.join(", ")}.`,
        },
      };
    }
    await this.appendEvent(manifest, "apply_launched", `apply-launch:${manifest.manifestSha256}`, {
      approvalIds: plan.approvalRefs,
    });
    const observation = await this.deps.supervisor.launchApply({
      plan,
      manifest,
      approvalIds: plan.approvalRefs,
    });
    return await this.settleObservation(plan, manifest, observation);
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const manifest = await this.requireVerifiedManifest(plan, false);
    const observation = await this.deps.supervisor.inspect(manifest);
    const outcome = await this.settleObservation(plan, manifest, observation);
    return { effectObserved: observation.status === "succeeded" || observation.status === "rolled_back", ...outcome };
  }

  public async rollback(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const manifest = await this.requireVerifiedManifest(plan, false);
    if (!plan.rollbackRefs.includes(rollbackRef(manifest))) {
      throw new ConflictError({ message: "The approved rollback material is no longer bound to this Change Plan." });
    }
    await this.appendEvent(manifest, "rollback_started", `operator-rollback:${plan.revision}`);
    const observation = await this.deps.supervisor.launchRollback({ plan, manifest });
    return await this.settleObservation(plan, manifest, observation);
  }

  private async requireVerifiedManifest(plan: ChangePlanRecord, requireOriginalBaseline = true) {
    const manifest = await this.deps.sourceUpdates.getManifestForPlan(plan.planId);
    if (!plan.evidenceRefs.includes(manifestRef(manifest)) || plan.target.expectedHash !== manifest.manifestSha256) {
      throw new ConflictError({ message: "The staged source manifest binding changed before promotion." });
    }
    if (requireOriginalBaseline) return await this.deps.sourceUpdates.verifyManifest(manifest.manifestId);
    return manifest;
  }

  private async settleObservation(
    plan: ChangePlanRecord,
    manifest: ProductSourceUpdateManifestRecord,
    observation: ProductSourceApplyObservation,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (observation.status === "not_started") {
      return manual(
        "The native source-update supervisor has no durable launch record; apply was not replayed.",
        "source_update_not_started",
      );
    }
    if (observation.status === "running") {
      return {
        status: plan.status === "rolling_back" ? "rolling_back" : "monitoring",
        evidenceRefs: [...evidenceRefs(manifest), ...(observation.evidenceRefs ?? [])],
        rollbackRefs: [rollbackRef(manifest)],
        result: {
          summary:
            plan.status === "rolling_back"
              ? "The exact rollback operation is running under the native supervisor."
              : "The approved source update is running under the native supervisor.",
        },
      };
    }
    if (observation.status === "succeeded" || observation.status === "rolled_back") {
      const accepted = await this.deps.acceptAppliedBaseline({
        installId: manifest.installId,
        expectedRevision: manifest.installRevision,
        expectedPreviousSha: manifest.baseSha,
        baselineSha: observation.baselineSha,
        baselineTree: observation.baselineTree,
      });
      const eventType = observation.status === "succeeded" ? "apply_succeeded" : "rollback_succeeded";
      await this.appendEvent(manifest, eventType, `${eventType}:${observation.baselineSha}`, {
        baselineSha: observation.baselineSha,
        baselineTree: observation.baselineTree,
        installRevision: accepted.revision,
      });
      return {
        status: observation.status === "succeeded" ? "completed" : "rolled_back",
        target: { ...plan.target, expectedRevision: accepted.revision, expectedHash: observation.baselineSha },
        evidenceRefs: [
          ...evidenceRefs(manifest),
          ...observation.evidenceRefs,
          `managed-source-install:${accepted.installId}:${accepted.revision}`,
        ],
        rollbackRefs: [rollbackRef(manifest)],
        result: {
          summary:
            observation.status === "succeeded"
              ? "The native supervisor applied the exact patch, restarted GoatCitadel, and passed smoke checks."
              : "The native supervisor restored the exact approved prior content and passed smoke checks.",
          appliedRevision: accepted.revision,
        },
      };
    }
    if (observation.status !== "failed" && observation.status !== "rollback_failed") {
      throw new SemanticValidationError("Native source-update supervisor returned an unsupported observation.");
    }
    const rollbackFailed = observation.status === "rollback_failed";
    const failureCode = observation.failureCode;
    await this.appendEvent(
      manifest,
      rollbackFailed ? "rollback_failed" : "manual_required",
      `${observation.status}:${failureCode}`,
      {
        failureCode,
      },
    );
    return {
      status: rollbackFailed ? "rollback_failed" : "manual_required",
      evidenceRefs: [...evidenceRefs(manifest), ...(observation.evidenceRefs ?? [])],
      rollbackRefs: [rollbackRef(manifest)],
      result: {
        summary: rollbackFailed
          ? "The native supervisor could not complete the exact rollback. Manual recovery is required."
          : "The source update did not reach a provable healthy state. The supervisor stopped without replaying it.",
        failureCode,
      },
    };
  }

  private async appendEvent(
    manifest: ProductSourceUpdateManifestRecord,
    eventType: Parameters<SourceUpdates["appendEvent"]>[1]["eventType"],
    idempotencyKey: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const expectedSequence = (await this.deps.sourceUpdates.listEvents(manifest.manifestId)).length;
    await this.deps.sourceUpdates.appendEvent(manifest.manifestId, {
      expectedSequence,
      eventType,
      idempotencyKey,
      payload,
    });
  }
}

function requireRequest(plan: ChangePlanRecord): ChangePlanProductSourceUpdateRequest {
  if (plan.request.kind !== "product_source_update")
    throw new SemanticValidationError("Product source Change Plan kind drifted.");
  return plan.request;
}

function assertPlanTarget(plan: ChangePlanRecord, manifest: ProductSourceUpdateManifestRecord): void {
  if (plan.target.resourceId !== manifest.installId || plan.target.expectedRevision !== manifest.installRevision) {
    throw new ConflictError({ message: "Managed source registration changed while the update was staged." });
  }
}

function manifestRef(manifest: ProductSourceUpdateManifestRecord): string {
  return `product-source-manifest:${manifest.manifestId}:sha256:${manifest.manifestSha256}`;
}

function rollbackRef(manifest: ProductSourceUpdateManifestRecord): string {
  return `product-source-rollback:${manifest.manifestId}:sha256:${manifest.rollbackSha256}`;
}

function artifactRefs(manifest: ProductSourceUpdateManifestRecord): string[] {
  return [
    manifestRef(manifest),
    `product-source-patch:${manifest.manifestId}:sha256:${manifest.patchSha256}`,
    rollbackRef(manifest),
  ].sort();
}

function evidenceRefs(manifest: ProductSourceUpdateManifestRecord): string[] {
  return [
    manifestRef(manifest),
    `code-mode-run:${manifest.codeModeRunId}`,
    ...manifest.validations.map((item) => item.evidenceRef ?? `product-source-proof:${item.proofId}:${item.status}`),
  ];
}

function assertExactRefs(actual: readonly string[], expected: readonly string[]): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new ConflictError({ message: "Product source artifacts changed after the review action was issued." });
  }
}

function requireApprovalId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(normalized)) {
    throw new SemanticValidationError("The protected-core approval owner returned an invalid approval binding.");
  }
  return normalized;
}

function manual(summary: string, failureCode: string): EvolutionControlPlaneAdapterOutcome {
  return { status: "manual_required", result: { summary, failureCode } };
}
