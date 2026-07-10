import { isDeepStrictEqual } from "node:util";
import {
  redactSecretText,
  redactStructuredSecrets,
  type ChatGeneratedArtifactRecord,
  type ChatDelegateResponse,
  type ChatDelegateSuggestResponse,
  type ChatDelegationRunRecord,
  type ChatDelegationStepRecord,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type ChatSessionSearchResponse,
  type ChatStreamChunk,
  type ChatStreamChunkDraft,
  type ChatTurnTraceRecord,
  type ContextManifestDetail,
  type RecentCrossProjectSession,
} from "@goatcitadel/contracts";
import { projectPublicSecretValue } from "./public-secret-projection.js";
import { projectProviderRuntimePublicValue } from "./provider-settings-public-projection.js";

const PUBLIC_MARKER = "[REDACTED]";

export function projectChatTurnTraceForPublic(trace: ChatTurnTraceRecord): ChatTurnTraceRecord {
  return redactStructuredSecrets(trace).value as ChatTurnTraceRecord;
}

export function projectChatMessageForPublic(message: ChatMessageRecord | undefined): ChatMessageRecord | undefined {
  if (!message || message.role === "user") {
    return message;
  }
  return redactStructuredSecrets(message).value;
}

export function projectChatSessionForPublic(session: ChatSessionRecord): ChatSessionRecord {
  const projected = redactStructuredSecrets(session).value;
  return {
    ...projected,
    title: projectOptionalSessionText(session.title),
    folderId: projectOptionalSessionText(session.folderId),
    folderName: projectOptionalSessionText(session.folderName),
    tags: session.tags?.map((tag) => redactSecretText(tag).value),
  };
}

export function preserveChatSessionSecretsForPublicUpdate(
  current: ChatSessionRecord,
  input: { title?: string; folderId?: string; folderName?: string; tags?: string[] },
): typeof input {
  const projected = projectChatSessionForPublic(current);
  const keys = ["title", "folderId", "folderName", "tags"] as const;
  const reconciled = structuredClone(input);
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) {
      continue;
    }
    if (key === "tags") {
      reconciled.tags = reconcileProjectedSessionTags(current.tags, projected.tags, input.tags);
      continue;
    }
    reconciled[key] = reconcileProjectedSessionText(current[key], projected[key], input[key]);
  }
  return reconciled;
}

export function projectChatSessionSearchResponseForPublic(
  response: ChatSessionSearchResponse,
): ChatSessionSearchResponse {
  const { items, ...metadata } = response;
  return {
    ...redactStructuredSecrets(metadata).value,
    items: items.map((item) => {
      const { session, ...result } = item;
      return {
        ...redactStructuredSecrets(result).value,
        session: projectChatSessionForPublic(session),
      };
    }),
  };
}

export function projectRecentCrossProjectSessionForPublic(
  session: RecentCrossProjectSession,
): RecentCrossProjectSession {
  return redactStructuredSecrets(session).value;
}

export function projectChatStreamChunkForPublic<T extends ChatStreamChunk | ChatStreamChunkDraft>(chunk: T): T {
  return redactStructuredSecrets(chunk).value as T;
}

export function projectChatGeneratedArtifactForPublic(
  artifact: ChatGeneratedArtifactRecord,
): ChatGeneratedArtifactRecord {
  const projected = redactStructuredSecrets(artifact);
  return {
    ...projected.value,
    ...(projected.redactionCount > 0
      ? {
          publicProjection: {
            artifactRedacted: true as const,
            contentRedacted: projected.redactedPaths.includes("$.content"),
            redactionCount: projected.redactionCount,
            redactedPaths: projected.redactedPaths,
            canonicalContentHashRefersToStoredArtifact: true as const,
          },
        }
      : {}),
  };
}

export function projectChatDelegateResponseForPublic(response: ChatDelegateResponse): ChatDelegateResponse {
  return projectPublicSecretValue(response);
}

export function projectChatDelegationRunForPublic<
  T extends ChatDelegationRunRecord | { run: ChatDelegationRunRecord; steps: ChatDelegationStepRecord[] },
>(value: T): T {
  const projected = projectPublicSecretValue(value);
  if (isChatDelegationRunDetail(value)) {
    const projectedDetail = projected as { run: ChatDelegationRunRecord; steps: ChatDelegationStepRecord[] };
    return {
      ...projectedDetail,
      run: restoreDelegationOperatorInput(projectedDetail.run, value.run),
    } as T;
  }
  return restoreDelegationOperatorInput(projected as ChatDelegationRunRecord, value) as T;
}

export function projectChatDelegateSuggestionForPublic(
  response: ChatDelegateSuggestResponse,
): ChatDelegateSuggestResponse {
  const projected = projectPublicSecretValue(response);
  return {
    ...projected,
    suggestion: {
      ...projected.suggestion,
      objective: response.suggestion.objective,
      roles: [...response.suggestion.roles],
    },
  };
}

export function projectChatDelegationStreamValueForPublic<T>(value: T): T {
  return projectPublicSecretValue(value);
}

export function projectChatWorkbenchExecutionForPublic<T>(value: T): T {
  return projectProviderRuntimePublicValue(value);
}

export function projectChatContextManifestForPublic(value: ContextManifestDetail): ContextManifestDetail {
  const projected = projectPublicSecretValue(value);
  return {
    ...projected,
    entries: projected.entries.map((entry, index) => {
      const raw = value.entries[index];
      if (!raw) {
        return entry;
      }
      const contentRedacted = raw.contentText !== entry.contentText;
      const metadataRedacted = !isDeepStrictEqual(raw.metadata, entry.metadata);
      const titleRedacted = raw.title !== entry.title;
      const sourceRefRedacted = raw.sourceRef !== entry.sourceRef;
      return contentRedacted || metadataRedacted || titleRedacted || sourceRefRedacted
        ? {
            ...entry,
            publicProjection: {
              entryRedacted: true as const,
              contentRedacted,
              metadataRedacted,
              titleRedacted,
              sourceRefRedacted,
              canonicalContentHashRefersToStoredEntry: true as const,
            },
          }
        : entry;
    }),
  };
}

function restoreDelegationOperatorInput(
  projected: ChatDelegationRunRecord,
  raw: ChatDelegationRunRecord,
): ChatDelegationRunRecord {
  return {
    ...projected,
    // The objective and requested roles are operator-authored conversation
    // content. Keep the same raw-content rule used for user Chat messages.
    objective: raw.objective,
    roles: [...raw.roles],
  };
}

function isChatDelegationRunDetail(
  value: unknown,
): value is { run: ChatDelegationRunRecord; steps: ChatDelegationStepRecord[] } {
  return Boolean(value && typeof value === "object" && "run" in value && "steps" in value);
}

function projectOptionalSessionText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSecretText(value).value;
}

function reconcileProjectedSessionText(
  raw: string | undefined,
  projected: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (raw === undefined || projected === undefined || incoming === undefined || raw === projected) {
    return incoming;
  }
  if (incoming === projected) {
    return raw;
  }
  if (!incoming.includes(PUBLIC_MARKER)) {
    return incoming;
  }

  const slots = extractProjectedSecretSlots(raw, projected);
  const incomingParts = incoming.split(PUBLIC_MARKER);
  if (!slots || incomingParts.length !== slots.length + 1) {
    throw new Error("Projected session metadata must keep each redaction marker in its original credential slot.");
  }
  for (let index = 0; index < slots.length; index += 1) {
    const anchor = markerAnchor(projected.split(PUBLIC_MARKER)[index] ?? "");
    if (!anchor || !(incomingParts[index] ?? "").endsWith(anchor)) {
      throw new Error("Projected session metadata must keep each redaction marker in its original credential slot.");
    }
  }
  return incomingParts.map((part, index) => (index < slots.length ? `${part}${slots[index]}` : part)).join("");
}

function reconcileProjectedSessionTags(
  raw: string[] | undefined,
  projected: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (!raw || !projected || !incoming || !incoming.some((tag) => tag.includes(PUBLIC_MARKER))) {
    return incoming;
  }
  if (raw.length !== projected.length || projected.length !== incoming.length) {
    throw new Error("Projected session tags with hidden values cannot be reordered or resized.");
  }
  const projectedMarkerIndices = projected.flatMap((tag, index) => (tag.includes(PUBLIC_MARKER) ? [index] : []));
  const incomingMarkerIndices = incoming.flatMap((tag, index) => (tag.includes(PUBLIC_MARKER) ? [index] : []));
  if (!isDeepStrictEqual(projectedMarkerIndices, incomingMarkerIndices)) {
    throw new Error("Projected session tags with hidden values cannot be reordered or resized.");
  }
  if (
    projectedMarkerIndices.length > 1 &&
    projectedMarkerIndices.some((index) => incoming[index] !== projected[index])
  ) {
    throw new Error("Projected session tags with hidden values cannot be reordered or resized.");
  }
  return incoming.map((tag, index) => reconcileProjectedSessionText(raw[index], projected[index], tag) ?? "");
}

function extractProjectedSecretSlots(raw: string, projected: string): string[] | undefined {
  const parts = projected.split(PUBLIC_MARKER);
  if (parts.length < 2 || !raw.startsWith(parts[0] ?? "")) {
    return undefined;
  }
  const slots: string[] = [];
  let cursor = (parts[0] ?? "").length;
  for (let index = 1; index < parts.length; index += 1) {
    const suffix = parts[index] ?? "";
    const suffixIndex = suffix ? raw.indexOf(suffix, cursor) : raw.length;
    if (suffixIndex < cursor) {
      return undefined;
    }
    slots.push(raw.slice(cursor, suffixIndex));
    cursor = suffixIndex + suffix.length;
  }
  return cursor === raw.length ? slots : undefined;
}

function markerAnchor(prefix: string): string | undefined {
  const match = prefix.match(
    /(?:Authorization|Proxy-Authorization)\s*:\s*$|(?:Bearer|Basic)\s+$|(?:api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|signature|secret)\s*[:=]\s*$|\/(?:services|webhooks|bot)\/?$/i,
  );
  return match?.[0];
}
