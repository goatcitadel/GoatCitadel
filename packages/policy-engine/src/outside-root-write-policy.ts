import {
  OUTSIDE_ROOT_WRITE_GRANT_DEFAULT_DURATION,
  OUTSIDE_ROOT_WRITE_GRANT_DURATIONS,
  isOutsideRootWriteTool,
  readOutsideRootWriteApprovalDetails,
  type OutsideRootWriteApprovalDetails,
  type OutsideRootWriteGrantDuration,
  type ToolGrantRecord,
  type ToolPolicyConfig,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import {
  deriveOutsideRootWriteCandidates,
  grantWriteRootsAdmit,
  isInsideToolWriteRoots,
  isOutsideRootWriteEnabled,
  outsideRootWriteSafetyContext,
  resolveOutsideRootWriteTarget,
} from "./sandbox/outside-root-write.js";
import { isSamePathOrDescendant } from "./sandbox/write-root-safety.js";
import type { WritePathCandidate } from "./write-path-candidates.js";

/**
 * Decision for the write targets of one request that land outside every write
 * root:
 * - `none`: nothing outside the roots qualifies; the ordinary write gate decides
 *   (and blocks anything outside the roots).
 * - `requires_approval`: the targets qualify for an operator approval.
 * - `admitted`: a verified folder grant or approve-once record admits them.
 *
 * `outsidePaths` lists the raw candidate paths this decision covers.
 */
export type OutsideRootWriteEvaluation =
  | { status: "none" }
  | { status: "requires_approval"; outsidePaths: ReadonlySet<string>; details: OutsideRootWriteApprovalDetails }
  | {
      status: "admitted";
      outsidePaths: ReadonlySet<string>;
      roots: string[];
      source: "grant" | "approval";
      grant?: ToolGrantRecord;
    };

export interface OutsideRootWritePolicyDeps {
  sandbox: ToolPolicyConfig["sandbox"];
  /** Gateway-owned eligibility (ordinary interactive sessions only). Absent means ineligible. */
  isEligible: () => Promise<boolean>;
  /** The verified approval id when this request is the exact approved request, else undefined. */
  verifiedApprovalId: () => Promise<string | undefined>;
  /** Engine-authored outside-root record of an approval, read from its approval events. */
  registeredDetails: (approvalId: string) => Promise<OutsideRootWriteApprovalDetails | undefined>;
  platform?: NodeJS.Platform;
}

const INELIGIBLE_ACTOR_SOURCES: ReadonlySet<ToolPolicyActorContext["authActorSource"]> = new Set([
  "a2a_peer",
  "mesh_node",
]);

const NONE: OutsideRootWriteEvaluation = { status: "none" };

export async function evaluateOutsideRootWrites(
  request: { toolName: string; policyContext?: Pick<ToolPolicyActorContext, "authActorSource"> },
  writeCandidates: readonly WritePathCandidate[],
  allowGrants: readonly ToolGrantRecord[] | undefined,
  deps: OutsideRootWritePolicyDeps,
): Promise<OutsideRootWriteEvaluation> {
  const { sandbox } = deps;
  const ctx = outsideRootWriteSafetyContext(sandbox);
  if (!ctx || !isOutsideRootWriteEnabled(sandbox) || !isOutsideRootWriteTool(request.toolName)) return NONE;
  if (INELIGIBLE_ACTOR_SOURCES.has(request.policyContext?.authActorSource)) return NONE;
  const outside = writeCandidates.filter((candidate) => !isInsideToolWriteRoots(candidate.path, sandbox));
  if (outside.length === 0 || outside.some((candidate) => candidate.intent === "delete")) return NONE;

  const resolved: string[] = [];
  for (const candidate of outside) {
    const result = resolveOutsideRootWriteTarget(candidate.path, ctx, deps.platform);
    if (!result.ok) return NONE;
    resolved.push(result.resolved);
  }
  if (!(await deps.isEligible())) return NONE;

  const outsidePaths = new Set(outside.map((candidate) => candidate.path));
  for (const grant of allowGrants ?? []) {
    const roots = grant.constraints?.writeRoots;
    if (!roots?.length) continue;
    const admitted = grantWriteRootsAdmit(roots, resolved, ctx, deps.platform);
    if (admitted) return { status: "admitted", outsidePaths, roots: admitted, source: "grant", grant };
  }

  const approvalId = await deps.verifiedApprovalId();
  if (approvalId) {
    const registered = await deps.registeredDetails(approvalId);
    if (registered && resolved.every((target) => registered.targets.some((r) => samePath(r, target, deps.platform)))) {
      return { status: "admitted", outsidePaths, roots: resolved, source: "approval" };
    }
  }

  return {
    status: "requires_approval",
    outsidePaths,
    details: {
      kind: "outside_root_write",
      targets: resolved,
      candidates: deriveOutsideRootWriteCandidates(resolved, ctx, deps.platform),
      durations: Object.keys(OUTSIDE_ROOT_WRITE_GRANT_DURATIONS) as OutsideRootWriteGrantDuration[],
      defaultDuration: OUTSIDE_ROOT_WRITE_GRANT_DEFAULT_DURATION,
    },
  };
}

/** Read the engine-authored outside-root record from an approval's registration event payload. */
export function readRegisteredOutsideRootWrite(
  events: readonly { eventType: string; payload?: Record<string, unknown> }[],
): OutsideRootWriteApprovalDetails | undefined {
  const registration = events.find((event) => event.eventType === "pending_action_registered");
  return readOutsideRootWriteApprovalDetails(registration?.payload?.outsideRootWrite);
}

function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  return isSamePathOrDescendant(left, right, platform) && isSamePathOrDescendant(right, left, platform);
}
