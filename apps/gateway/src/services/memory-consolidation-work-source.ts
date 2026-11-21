import type { ChatTurnTraceRecord, TranscriptEvent } from "@goatcitadel/contracts";
import { redactSecretText } from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import type {
  ConsolidationCursor,
  ConsolidationProgress,
  ConsolidationSourceExclusion,
  ConsolidationSourceInspection,
} from "@goatcitadel/storage";

const MAX_DIGEST_EVENTS = 40;
const MAX_DIGEST_TOTAL_CHARS = 6_000;

export interface ConsolidationSourceBinding {
  workspaceId: string;
  sessionId: string;
  turnIds: string[];
  sourceHash: string;
}

export interface MemoryConsolidationWorkSourceDeps {
  listWorkspaceIds: () => Promise<string[]>;
  resolveEligibleSourceSession: (sessionId: string) => Promise<{ workspaceId: string } | undefined>;
  listCompletedTracePage: (input: {
    workspaceId: string;
    after: ConsolidationCursor;
    through: string;
    limit: number;
  }) => Promise<ChatTurnTraceRecord[]>;
  readTranscriptOrEmpty: (sessionId: string) => Promise<TranscriptEvent[]>;
  readCanonicalSource?(input: {
    workspaceId: string;
    sessionId: string;
    turnIds: string[];
  }): Promise<{ sourceHash: string; events: TranscriptEvent[] } | undefined>;
  inspectCanonicalSource?(input: {
    workspaceId: string;
    sessionId: string;
    turnIds: string[];
  }): Promise<ConsolidationSourceInspection>;
  readProgress: (workspaceId: string) => Promise<ConsolidationProgress>;
  claimProgress: (
    workspaceId: string,
    expectedRevision: number,
    leaseOwner: string,
    now: string,
  ) => Promise<ConsolidationProgress | undefined>;
  commitProgress: (
    workspaceId: string,
    expectedRevision: number,
    leaseOwner: string,
    cursor: ConsolidationCursor | undefined,
    now: string,
    sourceExclusions?: ConsolidationSourceExclusion[],
  ) => Promise<unknown>;
}

/** Canonical eligibility, bounded transcript windows and durable cursor ownership. */
export class MemoryConsolidationWorkSource {
  public constructor(private readonly deps: MemoryConsolidationWorkSourceDeps) {}

  public async listDueWorkspaces() {
    const workspaces = await Promise.all(
      [...new Set(await this.deps.listWorkspaceIds())].map(async (workspaceId) => ({
        workspaceId,
        progress: await this.deps.readProgress(workspaceId),
      })),
    );
    workspaces.sort(
      (a, b) =>
        (a.progress.lastAttemptAt ?? "").localeCompare(b.progress.lastAttemptAt ?? "") ||
        a.workspaceId.localeCompare(b.workspaceId),
    );
    return workspaces;
  }

  public async isEligibleSession(sessionId: string, workspaceId: string): Promise<boolean> {
    return (await this.deps.resolveEligibleSourceSession(sessionId))?.workspaceId === workspaceId;
  }

  public async hasCurrentBinding(binding: ConsolidationSourceBinding): Promise<boolean> {
    return (await this.deps.readCanonicalSource?.(binding))?.sourceHash === binding.sourceHash;
  }

  public claimProgress(...args: Parameters<MemoryConsolidationWorkSourceDeps["claimProgress"]>) {
    return this.deps.claimProgress(...args);
  }

  public commitProgress(...args: Parameters<MemoryConsolidationWorkSourceDeps["commitProgress"]>) {
    return this.deps.commitProgress(...args);
  }

  public listCompletedTracePage(input: Parameters<MemoryConsolidationWorkSourceDeps["listCompletedTracePage"]>[0]) {
    return this.deps.listCompletedTracePage(input);
  }

  public async prepareSourceWindows(
    session: { sessionId: string; traces: ChatTurnTraceRecord[] },
    workspaceId: string,
    limit: number,
    exclude: (exclusion: ConsolidationSourceExclusion) => void,
  ): Promise<{ windows: ChatTurnTraceRecord[][]; unavailable: boolean }> {
    const windows: ChatTurnTraceRecord[][] = [];
    let current: ChatTurnTraceRecord[] = [],
      chars = 0,
      eventCount = 0,
      unavailable = false;
    const fallback =
      this.deps.inspectCanonicalSource || this.deps.readCanonicalSource
        ? undefined
        : await this.deps.readTranscriptOrEmpty(session.sessionId);
    for (const trace of session.traces) {
      const input = { workspaceId, sessionId: session.sessionId, turnIds: [trace.turnId] };
      let inspection: ConsolidationSourceInspection;
      if (this.deps.inspectCanonicalSource) inspection = await this.deps.inspectCanonicalSource(input);
      else if (this.deps.readCanonicalSource) {
        const source = await this.deps.readCanonicalSource(input);
        inspection = source ? { status: "ready", ...source } : { status: "unavailable" };
      } else {
        const events = (fallback ?? []).filter(
          (event) =>
            event.sessionId === session.sessionId &&
            ((event.type === "message.user" && event.eventId === trace.userMessageId) ||
              (event.type === "message.assistant" && event.eventId === trace.assistantMessageId)),
        );
        inspection = {
          status: "ready",
          events,
          sourceHash: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
        };
      }
      if (inspection.status === "unavailable") {
        unavailable = true;
        break;
      }
      let digest = "",
        reason: ConsolidationSourceExclusion["reason"] | undefined;
      if (inspection.status === "excluded") reason = inspection.reason;
      else {
        try {
          digest = buildTranscriptDigest(inspection.events);
        } catch (error) {
          if (error instanceof ConsolidationDigestExclusion) reason = error.reason;
          else throw error;
        }
      }
      if (reason) {
        exclude({
          sessionId: session.sessionId,
          turnId: trace.turnId,
          finishedAt: trace.finishedAt ?? trace.startedAt,
          sourceHash: inspection.sourceHash,
          reason,
        });
        continue;
      }
      const count = inspection.status === "ready" ? inspection.events.length : 0;
      if (
        current.length &&
        (eventCount + count > MAX_DIGEST_EVENTS || chars + 1 + digest.length > MAX_DIGEST_TOTAL_CHARS)
      ) {
        windows.push(current);
        current = [];
        chars = 0;
        eventCount = 0;
        if (windows.length >= limit) return { windows, unavailable };
      }
      current.push(trace);
      chars += (chars ? 1 : 0) + digest.length;
      eventCount += count;
    }
    if (current.length && windows.length < limit) windows.push(current);
    return { windows, unavailable };
  }

  public async readDraftSource(
    workspaceId: string,
    sessionId: string,
    traces: readonly ChatTurnTraceRecord[],
  ): Promise<{ digest: string; binding?: ConsolidationSourceBinding }> {
    const sourceInput = { workspaceId, sessionId, turnIds: traces.map((trace) => trace.turnId) };
    const canonical = this.deps.readCanonicalSource ? await this.deps.readCanonicalSource(sourceInput) : undefined;
    if (this.deps.readCanonicalSource && !canonical)
      throw new Error("Canonical consolidation source is unavailable or changed.");
    const events = canonical?.events ?? (await this.deps.readTranscriptOrEmpty(sessionId));
    const userMessageIds = new Set(traces.map((trace) => trace.userMessageId));
    const assistantMessageIds = new Set(traces.map((trace) => trace.assistantMessageId));
    const sourceEvents = events.filter(
      (event) =>
        event.sessionId === sessionId &&
        ((event.type === "message.user" && userMessageIds.has(event.eventId)) ||
          (event.type === "message.assistant" && assistantMessageIds.has(event.eventId))),
    );
    const digest = buildTranscriptDigest(sourceEvents);
    return { digest, ...(canonical ? { binding: { ...sourceInput, sourceHash: canonical.sourceHash } } : {}) };
  }
}

class ConsolidationDigestExclusion extends Error {
  public constructor(public readonly reason: "digest_size_limit" | "credential_values") {
    super("Source is outside bounded consolidation: " + reason);
  }
}

function buildTranscriptDigest(events: TranscriptEvent[]): string {
  if (events.length > MAX_DIGEST_EVENTS) throw new ConsolidationDigestExclusion("digest_size_limit");
  const lines: string[] = [];
  let total = 0;
  for (const event of events) {
    const text = extractEventText(event.payload);
    if (!text) {
      continue;
    }
    const role = event.type === "message.user" ? "user" : "assistant";
    const boundedText = text.normalize("NFKC");
    if (redactSecretText(boundedText, { env: process.env }).redactionCount > 0)
      throw new ConsolidationDigestExclusion("credential_values");
    const line = `${role}: ${boundedText}`;
    if (total + (lines.length ? 1 : 0) + line.length > MAX_DIGEST_TOTAL_CHARS)
      throw new ConsolidationDigestExclusion("digest_size_limit");
    lines.push(line);
    total += (lines.length > 1 ? 1 : 0) + line.length;
  }
  return lines.join("\n");
}

function extractEventText(payload: Record<string, unknown>): string | undefined {
  const message = payload.message;
  const messageContent = message && typeof message === "object" && "content" in message ? message.content : message;
  for (const value of [messageContent, payload.text, payload.content]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
