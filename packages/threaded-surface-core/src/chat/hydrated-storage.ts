import type { ChatAttachmentRecord, ChatRoutedContextRef, RunTemplateInvocation } from "@goatcitadel/contracts";
import type { OutboundQueueItem, OutboundRequestPrefsSnapshot } from "./useChatSurfaceOrchestration";
import {
  MAX_HYDRATED_MESSAGE_CHARS,
  MAX_HYDRATED_QUEUE_ITEMS,
  hasOnlyKeys,
  hasOwn,
  isBoundedString,
  isCanonicalTimestamp,
  isPlainRecord,
  isSafeIdentifier,
  isWithinStorageBudget,
  parseHydratedAttachmentsValue,
  parseHydratedWorkspaceSnapshotRequest,
} from "./hydrated-storage-validation";

function parseHydratedRequestPrefs(value: unknown): OutboundRequestPrefsSnapshot | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "mode",
      "providerId",
      "model",
      "webMode",
      "memoryMode",
      "thinkingLevel",
      "speedMode",
      "subagentPolicy",
      "fullWebAccess",
    ]) ||
    value.mode !== "chat" ||
    !["auto", "off", "quick", "deep"].includes(value.webMode as string) ||
    !["auto", "on", "off"].includes(value.memoryMode as string) ||
    !["off", "minimal", "standard", "extended", "deep", "max", "ultra"].includes(value.thinkingLevel as string) ||
    !["standard", "fast"].includes(value.speedMode as string) ||
    !["off", "ask_when_useful", "auto_when_useful"].includes(value.subagentPolicy as string) ||
    typeof value.fullWebAccess !== "boolean" ||
    !isSafeIdentifier(value.providerId) ||
    !isSafeIdentifier(value.model, 512)
  ) {
    return null;
  }
  return Object.freeze({ ...value }) as unknown as OutboundRequestPrefsSnapshot;
}

const MAX_HYDRATED_EXTERNAL_CONTEXT_REFS = 16;

/**
 * Fail-closed parser for HX-407 queue-frozen external context refs. Only send
 * items may carry them, every ref is a safe external or explicitly selected
 * document identifier,
 * and any drift rejects the whole persisted queue (matching the envelope's
 * all-or-nothing hydration posture).
 */
function parseHydratedExternalContextRefs(
  value: unknown,
  action: unknown,
): OutboundQueueItem["externalContextRefs"] | null {
  if (
    action !== "send" ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_HYDRATED_EXTERNAL_CONTEXT_REFS
  ) {
    return null;
  }
  const refs: ChatRoutedContextRef[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !isPlainRecord(candidate) ||
      !hasOnlyKeys(candidate, ["kind", "ref", "label"]) ||
      !["external_attachment", "personal_note", "generated_artifact"].includes(candidate.kind as string) ||
      !isSafeIdentifier(candidate.ref) ||
      seen.has(candidate.ref) ||
      (hasOwn(candidate, "label") && !isBoundedString(candidate.label, 160))
    ) {
      return null;
    }
    seen.add(candidate.ref);
    refs.push(
      Object.freeze({
        kind: candidate.kind as ChatRoutedContextRef["kind"],
        ref: candidate.ref,
        ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
      }),
    );
  }
  return Object.freeze(refs);
}

function parseHydratedTemplateInvocation(value: unknown, action: unknown): RunTemplateInvocation | null {
  if (
    action !== "send" ||
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["ownerKind", "ownerId", "ownerRevision", "templateId", "schemaHash", "values"]) ||
    !["prompt_pack", "agent_preset"].includes(value.ownerKind as string) ||
    !isSafeIdentifier(value.ownerId) ||
    !isBoundedString(value.ownerRevision, 256) ||
    (hasOwn(value, "templateId") && !isSafeIdentifier(value.templateId)) ||
    typeof value.schemaHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.schemaHash) ||
    !isPlainRecord(value.values) ||
    Object.keys(value.values).length > 32
  ) {
    return null;
  }
  for (const [fieldId, fieldValue] of Object.entries(value.values)) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/u.test(fieldId) ||
      !(
        typeof fieldValue === "boolean" ||
        (typeof fieldValue === "number" && Number.isFinite(fieldValue)) ||
        isBoundedString(fieldValue, 100_000, true)
      )
    ) {
      return null;
    }
  }
  return Object.freeze({
    ownerKind: value.ownerKind,
    ownerId: value.ownerId,
    ownerRevision: value.ownerRevision,
    ...(typeof value.templateId === "string" ? { templateId: value.templateId } : {}),
    schemaHash: value.schemaHash,
    values: Object.freeze({ ...value.values }),
  }) as RunTemplateInvocation;
}

/** Fail-closed parser for browser-persisted attachment references. */
export function parseHydratedChatAttachments(
  raw: string | null,
  scope: { workspaceId: string; sessionId: string | null },
): ChatAttachmentRecord[] {
  if (!raw || !isWithinStorageBudget(raw)) {
    return [];
  }
  try {
    return parseHydratedAttachmentsValue(JSON.parse(raw), scope) ?? [];
  } catch {
    return [];
  }
}

/** Fail-closed parser for immutable browser-persisted outbound queue envelopes. */
export function parseHydratedOutboundQueue(
  raw: string | null,
  scope: {
    workspaceId: string;
    sessionId: string | null;
  },
): OutboundQueueItem[] {
  if (!raw || !isWithinStorageBudget(raw)) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_HYDRATED_QUEUE_ITEMS) {
      return [];
    }
    const parsed: OutboundQueueItem[] = [];
    const queueIds = new Set<string>();
    for (const candidate of value) {
      if (
        !isPlainRecord(candidate) ||
        !hasOnlyKeys(candidate, [
          "id",
          "action",
          "sessionId",
          "targetTurnId",
          "content",
          "displayContent",
          "attachments",
          "createdAt",
          "paused",
          "modelCouncil",
          "requestPrefs",
          "externalContextRefs",
          "templateInvocation",
          "workspaceSnapshot",
        ]) ||
        !isSafeIdentifier(candidate.id) ||
        queueIds.has(candidate.id) ||
        !["send", "edit", "retry"].includes(candidate.action as string) ||
        !isBoundedString(candidate.content, MAX_HYDRATED_MESSAGE_CHARS, true) ||
        (hasOwn(candidate, "displayContent") &&
          (!isBoundedString(candidate.displayContent, MAX_HYDRATED_MESSAGE_CHARS) ||
            candidate.displayContent.trim().length === 0)) ||
        !isCanonicalTimestamp(candidate.createdAt) ||
        (hasOwn(candidate, "paused") && typeof candidate.paused !== "boolean") ||
        (scope.sessionId === null ? hasOwn(candidate, "sessionId") : candidate.sessionId !== scope.sessionId)
      ) {
        return [];
      }
      const targetTurnId = hasOwn(candidate, "targetTurnId") ? candidate.targetTurnId : undefined;
      if (
        (candidate.action === "send" && (candidate.content as string).trim().length === 0) ||
        (candidate.action === "send" && targetTurnId !== undefined) ||
        (candidate.action === "edit" &&
          ((candidate.content as string).trim().length === 0 || !isSafeIdentifier(targetTurnId))) ||
        (candidate.action === "retry" &&
          (candidate.content !== "" ||
            !isSafeIdentifier(targetTurnId) ||
            (candidate.attachments as unknown[]).length > 0))
      ) {
        return [];
      }
      if (
        hasOwn(candidate, "modelCouncil") &&
        (!isPlainRecord(candidate.modelCouncil) ||
          !hasOnlyKeys(candidate.modelCouncil, ["enabled"]) ||
          candidate.modelCouncil.enabled !== true)
      ) {
        return [];
      }
      const attachments = parseHydratedAttachmentsValue(candidate.attachments, scope);
      const requestPrefs = hasOwn(candidate, "requestPrefs") ? parseHydratedRequestPrefs(candidate.requestPrefs) : null;
      if (!attachments || !requestPrefs) {
        return [];
      }
      const externalContextRefs = hasOwn(candidate, "externalContextRefs")
        ? parseHydratedExternalContextRefs(candidate.externalContextRefs, candidate.action)
        : undefined;
      if (hasOwn(candidate, "externalContextRefs") && !externalContextRefs) {
        return [];
      }
      const templateInvocation = hasOwn(candidate, "templateInvocation")
        ? parseHydratedTemplateInvocation(candidate.templateInvocation, candidate.action)
        : undefined;
      if (hasOwn(candidate, "templateInvocation") && !templateInvocation) {
        return [];
      }
      const workspaceSnapshot = hasOwn(candidate, "workspaceSnapshot")
        ? parseHydratedWorkspaceSnapshotRequest(candidate.workspaceSnapshot, candidate.action)
        : undefined;
      if (hasOwn(candidate, "workspaceSnapshot") && !workspaceSnapshot) {
        return [];
      }
      queueIds.add(candidate.id);
      parsed.push(
        Object.freeze({
          id: candidate.id,
          action: candidate.action,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          ...(typeof targetTurnId === "string" ? { targetTurnId } : {}),
          content: candidate.content,
          ...(typeof candidate.displayContent === "string" ? { displayContent: candidate.displayContent } : {}),
          attachments,
          createdAt: candidate.createdAt,
          paused: true,
          ...(hasOwn(candidate, "modelCouncil") ? { modelCouncil: Object.freeze({ enabled: true as const }) } : {}),
          requestPrefs,
          ...(externalContextRefs ? { externalContextRefs } : {}),
          ...(templateInvocation ? { templateInvocation } : {}),
          ...(workspaceSnapshot ? { workspaceSnapshot } : {}),
        }) as OutboundQueueItem,
      );
    }
    return Object.freeze(parsed) as unknown as OutboundQueueItem[];
  } catch {
    return [];
  }
}

/** Replace prior-session state while preserving items enqueued after a session transition rendered. */
export function mergeHydratedOutboundQueue(input: {
  hydrated: OutboundQueueItem[];
  current: OutboundQueueItem[];
  baselineIds: ReadonlySet<string>;
  sessionId: string | null;
  /** Only IDs captured for the first send's owner-created session may cross the unbound-to-bound transition. */
  initialSessionQueueIds?: ReadonlySet<string>;
}): OutboundQueueItem[] {
  const newlyQueued = input.current.flatMap((item) => {
    if (input.sessionId && item.sessionId === undefined && input.initialSessionQueueIds?.has(item.id)) {
      return [{ ...item, sessionId: input.sessionId }];
    }
    return !input.baselineIds.has(item.id) &&
      (input.sessionId === null ? item.sessionId === undefined : item.sessionId === input.sessionId)
      ? [item]
      : [];
  });
  const retainedNewItems = newlyQueued.slice(0, MAX_HYDRATED_QUEUE_ITEMS);
  const retainedIds = new Set(retainedNewItems.map((item) => item.id));
  const hydrated = input.hydrated
    .filter((item) => !retainedIds.has(item.id))
    .slice(0, MAX_HYDRATED_QUEUE_ITEMS - retainedNewItems.length);
  return [...hydrated, ...retainedNewItems];
}
