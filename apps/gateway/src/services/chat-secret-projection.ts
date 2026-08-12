import { isDeepStrictEqual } from "node:util";
import {
  redactSecretText,
  redactStructuredSecrets,
  type ChatGeneratedArtifactRecord,
  type ChatDelegateResponse,
  type ChatDelegateSuggestResponse,
  type ChatDelegationRunDetail,
  type ChatDelegationRunRecord,
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
import { restoreProjectedUrlFragments } from "./integration-connection-public-projection.js";
import {
  collectWorkspaceExplorerScopeRoots,
  projectWorkspaceExplorerPathValue,
} from "./workspace-explorer-path-projection.js";

const PUBLIC_MARKER = "[REDACTED]";
const PUBLIC_MARKER_PATTERN = /\[REDACTED\]/gi;

export function projectChatTurnTraceForPublic(trace: ChatTurnTraceRecord): ChatTurnTraceRecord {
  return redactStructuredSecrets(trace).value as ChatTurnTraceRecord;
}

export function projectChatMessageForPublic(message: ChatMessageRecord | undefined): ChatMessageRecord | undefined {
  if (!message || message.role === "user") {
    return message;
  }
  return redactStructuredSecrets(message).value;
}

/** Historical/search reopening is a discovery surface, so redact every role. */
export function projectChatHistoryMessageForPublic(
  message: ChatMessageRecord,
): import("@goatcitadel/contracts").ChatHistoryMessageRecord {
  return {
    messageId: message.messageId,
    sessionId: message.sessionId,
    role: message.role,
    content: redactSecretText(message.content).value,
    timestamp: message.timestamp,
  };
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
  return projectPublicDelegationValue(response);
}

export function projectChatDelegationRunForPublic<T extends ChatDelegationRunRecord | ChatDelegationRunDetail>(
  value: T,
): T {
  const projected = projectPublicDelegationValue(value);
  if (isChatDelegationRunDetail(value)) {
    const projectedDetail = projected as ChatDelegationRunDetail;
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

export function projectChatDelegationStreamValueForPublic<T>(
  value: T,
  options: { readOnlyExplorer?: boolean } = {},
): T {
  return projectPublicDelegationValue(value, options.readOnlyExplorer === true);
}

function projectPublicDelegationValue<T>(value: T, forceReadOnlyExplorer = false): T {
  const roots = collectWorkspaceExplorerScopeRoots(value);
  const explorerValue =
    forceReadOnlyExplorer || containsReadOnlyExplorerMarker(value)
      ? projectWorkspaceExplorerPathValue(value, roots)
      : value;
  return stripPrivateDelegationScopePaths(projectPublicSecretValue(explorerValue));
}

function containsReadOnlyExplorerMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReadOnlyExplorerMarker);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.workflowTemplate === "read_only_workspace_explorer") return true;
  if (record.profile === "read_only_explorer") return true;
  return Object.values(record).some(containsReadOnlyExplorerMarker);
}

function stripPrivateDelegationScopePaths<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripPrivateDelegationScopePaths(item)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "rootPath" || key === "projectId" || (key === "resolvedPaths" && "requestedPaths" in record)) continue;
    projected[key] = stripPrivateDelegationScopePaths(child);
  }
  return projected as T;
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
    // content. Keep the same raw-content rule used for user Chat messages,
    // except the dedicated explorer projection cannot reintroduce a host path
    // after its report/detail was made workspace-relative.
    objective: raw.workflowTemplate === "read_only_workspace_explorer" ? projected.objective : raw.objective,
    roles: [...raw.roles],
  };
}

function isChatDelegationRunDetail(value: unknown): value is ChatDelegationRunDetail {
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
  if (normalizePublicMarkers(incoming) === projected) {
    return raw;
  }
  const restoredUrl = restoreProjectedUrlFragments(raw, projected, incoming);
  if (restoredUrl !== undefined) {
    return restoredUrl;
  }
  if (containsEncodedPublicMarker(incoming) || isProjectedMarkerUrl(projected, incoming)) {
    throw new Error("Projected session URL metadata cannot move or encode a hidden credential slot.");
  }
  if (!containsPublicMarker(incoming)) {
    return incoming;
  }

  const slots = extractProjectedSecretSlots(raw, projected);
  if (!slots) {
    throw new Error("Projected session metadata must keep each redaction marker in its original credential slot.");
  }
  const projectedParts = projected.split(PUBLIC_MARKER);
  const anchors = slots.map((_slot, index) => markerAnchor(projectedParts[index] ?? ""));
  if (anchors.some((anchor) => !anchor)) {
    throw new Error("Projected session metadata must keep each redaction marker in its original credential slot.");
  }
  const anchorIdentities = anchors.map((anchor) => normalizeMarkerAnchor(anchor!));
  if (new Set(anchorIdentities).size !== anchorIdentities.length) {
    throw new Error(
      "Projected session metadata with repeated credential slots cannot be reordered or edited in place.",
    );
  }
  const slotByAnchor = new Map(anchorIdentities.map((identity, index) => [identity, slots[index] ?? ""]));
  const usedAnchors = new Set<string>();
  let cursor = 0;
  let reconciled = "";
  for (const match of incoming.matchAll(/\[REDACTED\]/gi)) {
    const markerIndex = match.index;
    const anchor = markerAnchor(incoming.slice(0, markerIndex));
    const identity = anchor ? normalizeMarkerAnchor(anchor) : "";
    const slot = slotByAnchor.get(identity);
    if (!identity || slot === undefined || usedAnchors.has(identity)) {
      throw new Error("Projected session metadata must keep each redaction marker in its original credential slot.");
    }
    usedAnchors.add(identity);
    reconciled += `${incoming.slice(cursor, markerIndex)}${slot}`;
    cursor = markerIndex + match[0].length;
  }
  return `${reconciled}${incoming.slice(cursor)}`;
}

function reconcileProjectedSessionTags(
  raw: string[] | undefined,
  projected: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  const hasProjectedSecrets = Boolean(
    raw && projected && raw.length === projected.length && raw.some((tag, index) => tag !== projected[index]),
  );
  if (hasProjectedSecrets && incoming?.some(containsEncodedPublicMarker)) {
    throw new Error("Projected session URL metadata cannot move or encode a hidden credential slot.");
  }
  if (!raw || !projected || !incoming || !incoming.some(containsPublicMarker)) {
    return incoming;
  }
  if (raw.length !== projected.length || projected.length !== incoming.length) {
    throw new Error("Projected session tags with hidden values cannot be reordered or resized.");
  }
  const projectedMarkerIndices = projected.flatMap((tag, index) => (containsPublicMarker(tag) ? [index] : []));
  const incomingMarkerIndices = incoming.flatMap((tag, index) => (containsPublicMarker(tag) ? [index] : []));
  if (incomingMarkerIndices.some((index) => !projectedMarkerIndices.includes(index))) {
    throw new Error("Projected session tags with hidden values cannot be reordered or resized.");
  }
  if (
    projectedMarkerIndices.length > 1 &&
    incomingMarkerIndices.some((index) => normalizePublicMarkers(incoming[index] ?? "") !== projected[index])
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
    /\b[A-Za-z0-9_-]*(?:authorization|authentication|auth|bearer|cookie|cookies|credential|credentials|api[-_]?key|apikey|client[-_]?key|access[-_]?key|private[-_]?key|consumer[-_]?key|signing[-_]?key|token|secret|password|passwd|signature|webhook[-_]?(?:url|uri|endpoint)?)[A-Za-z0-9_-]*\b\s*[:=]\s*$|(?:Bearer|Basic)\s+$|\/(?:services|webhooks|bot)\/?$/i,
  );
  return match?.[0];
}

function normalizeMarkerAnchor(anchor: string): string {
  return anchor.toLowerCase().replace(/\s+/g, "");
}

function containsPublicMarker(value: string): boolean {
  PUBLIC_MARKER_PATTERN.lastIndex = 0;
  return PUBLIC_MARKER_PATTERN.test(value);
}

function normalizePublicMarkers(value: string): string {
  return value.replace(PUBLIC_MARKER_PATTERN, PUBLIC_MARKER);
}

function containsEncodedPublicMarker(value: string): boolean {
  return /%5Bredacted%5D/i.test(value);
}

function isProjectedMarkerUrl(projected: string, incoming: string): boolean {
  const projectedUrl = parseHttpUrl(projected);
  const incomingUrl = parseHttpUrl(incoming);
  return Boolean(projectedUrl && incomingUrl && urlContainsPublicMarker(projectedUrl));
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function urlContainsPublicMarker(url: URL): boolean {
  return (
    containsPublicMarker(decodeUrlComponent(url.pathname)) ||
    containsPublicMarker(decodeUrlComponent(url.hash)) ||
    [...url.searchParams.values()].some(containsPublicMarker) ||
    containsPublicMarker(url.username) ||
    containsPublicMarker(url.password)
  );
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
