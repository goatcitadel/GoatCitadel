import {
  ConflictError,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatRoutedContextRef,
  type ChatRoutedContextSnapshotRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";

/**
 * Attachments are bound to the session they were attached in, and a delegated
 * child always runs in its own session. Moving them would need a new transfer
 * authority, so children inherit only session-independent sources.
 */
const SESSION_BOUND_CONTEXT_KINDS: ReadonlySet<ChatRoutedContextRef["kind"]> = new Set([
  "attachment",
  "external_attachment",
]);

export type ExplicitContextInheritanceStorage = Pick<
  AsyncStorage,
  "routedContextSnapshots" | "chatDelegationRuns" | "durableRuns"
>;

/**
 * The ordered source identifiers a turn's admitted snapshot was requested with.
 * Only identifiers are inherited: the new turn re-runs the full admission
 * (scope, access, provenance and budget) and binds its own snapshot. Labels are
 * display-only and are not carried over.
 */
export function contextRefsFromSnapshot(snapshot: ChatRoutedContextSnapshotRecord): ChatRoutedContextRef[] {
  const seen = new Set<string>();
  const refs: ChatRoutedContextRef[] = [];
  for (const { kind, ref } of [...snapshot.entries].sort((left, right) => left.index - right.index)) {
    const key = `${kind}\u0000${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind, ref });
  }
  return refs;
}

/** Edit/retry: the source turn's admitted context, re-admitted on the new turn. */
export async function resolveBranchInheritedContextRefs(
  storage: Pick<ExplicitContextInheritanceStorage, "routedContextSnapshots">,
  sourceTurnId: string,
): Promise<ChatRoutedContextRef[] | undefined> {
  const snapshot = await storage.routedContextSnapshots.findByTurn(sourceTurnId);
  return snapshot ? contextRefsFromSnapshot(snapshot) : undefined;
}

/**
 * Child delegation: the parent durable turn's admitted context ids. The parent
 * snapshot must still match the id and hash recorded in the parent's durable
 * payload; the child then re-admits the refs under its own session scope.
 */
export async function resolveDelegatedParentContextRefs(
  storage: ExplicitContextInheritanceStorage,
  admission: ActiveTurnAdmission,
): Promise<ChatRoutedContextRef[] | undefined> {
  const delegationRunId = admission.admittedRequest.policyRunId;
  if (!delegationRunId || !admission.admittedRequest.parentDelegationStepId) return undefined;
  const delegation = await storage.chatDelegationRuns.get(delegationRunId);
  if (!delegation.parentRunId) return undefined;
  const parent = await storage.durableRuns.getRun(delegation.parentRunId);
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: parent.workflowKey,
    durableRunId: parent.runId,
    payload: parent.payload,
  });
  if (!authority?.routedContextSnapshotId) return undefined;
  const snapshot = await storage.routedContextSnapshots.findByTurn(authority.turnId);
  if (
    !snapshot ||
    snapshot.snapshotId !== authority.routedContextSnapshotId ||
    snapshot.snapshotHash !== authority.routedContextSnapshotHash ||
    snapshot.workspaceId !== admission.identity.workspaceId
  ) {
    throw new ConflictError({ message: "The parent turn's admitted context changed. Start a fresh delegated step." });
  }
  return contextRefsFromSnapshot(snapshot).filter((ref) => !SESSION_BOUND_CONTEXT_KINDS.has(ref.kind));
}

export interface InheritedChatContextRefs {
  refs: ChatRoutedContextRef[];
  source: "branch" | "parent";
}

/**
 * Server-derived refs for a turn that sent none: an edit/retry re-admits its
 * source turn's context, and a delegated child inherits its parent's. Never
 * applies to durable replay (the admitted snapshot is already bound), to a
 * historical profile-bound turn, or when the request names refs itself (an
 * explicit empty list opts out).
 */
export async function resolveInheritedChatContextRefs(
  host: {
    readonly storage: ExplicitContextInheritanceStorage;
    isFeatureEnabled(flag: string): Promise<boolean>;
  },
  input: {
    request: { contextRefs?: ChatRoutedContextRef[]; parentDelegationStepId?: string };
    branchKind: string;
    sourceTurnId?: string;
    admission?: ActiveTurnAdmission;
    profileBound: boolean;
  },
): Promise<InheritedChatContextRefs | undefined> {
  const { request, admission } = input;
  if (input.profileBound || request.contextRefs !== undefined || !admission || admission.durableClaim) return undefined;
  const child = Boolean(request.parentDelegationStepId);
  const branch = (input.branchKind === "retry" || input.branchKind === "edit") && Boolean(input.sourceTurnId);
  if (!child && !branch) return undefined;
  // Inherit only while explicit context itself is enabled, so a retry after
  // explicit context was turned off proceeds without context instead of failing.
  const isEnabled = (flag: string) => host.isFeatureEnabled(flag);
  if (!(await isEnabled("chatExplicitContextV1Enabled")) || !(await isEnabled("chatExplicitContextBranchesV1Enabled")))
    return undefined;
  const { storage } = host;
  if (child) {
    const refs = await resolveDelegatedParentContextRefs(storage, admission);
    return refs?.length ? { refs, source: "parent" } : undefined;
  }
  const refs = await resolveBranchInheritedContextRefs(storage, input.sourceTurnId!);
  return refs?.length ? { refs, source: "branch" } : undefined;
}
