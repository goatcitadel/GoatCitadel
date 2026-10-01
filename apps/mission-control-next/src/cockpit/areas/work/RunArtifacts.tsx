import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";
import type { ObserveRunTraceArtifact, ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";

const MAX_PREVIEW_BYTES = 256 * 1024;
const ARTIFACT_KINDS = new Set(["markdown", "html", "mermaid", "code", "text"]);

function artifactBinding(artifact: ObserveRunTraceArtifact): string {
  return JSON.stringify([artifact.artifactId, artifact.workspaceId, artifact.sessionId,
    artifact.turnId, artifact.version, artifact.contentHash, artifact.kind]);
}

function canPreview(artifact: ObserveRunTraceArtifact): boolean {
  return Boolean(artifact.artifactId && artifact.sessionId && artifact.turnId
    && Number.isSafeInteger(artifact.version) && artifact.version > 0
    && artifact.contentHash && /^[a-f0-9]{64}$/iu.test(artifact.contentHash)
    && ARTIFACT_KINDS.has(artifact.kind));
}

interface Inspection {
  scope: string;
  binding: string;
  expected: ObserveRunTraceArtifact;
  state: "loading" | "ready" | "error";
  artifact?: ChatGeneratedArtifactRecord;
  error?: string;
}

export function RunArtifacts({ trace, workspaceId }: { trace: ObserveRunTraceResponse; workspaceId: string }) {
  const client = useQueryClient();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const requestId = useRef(0);
  const scope = JSON.stringify([workspaceId, trace.runId]);
  const scopedRun = trace.runId === trace.run.runId && durableRunWorkspaceId(trace.run) === workspaceId;
  const artifacts = scopedRun && trace.artifacts.state === "available"
    ? trace.artifacts.items.filter((artifact) => artifact.workspaceId === workspaceId) : [];
  const current = useRef({ scope, artifacts });
  current.current = { scope, artifacts };
  useEffect(() => () => { requestId.current += 1; }, []);
  const active = inspection?.scope === scope ? inspection : null;
  const unchanged = active && artifacts.some((artifact) => artifactBinding(artifact) === active.binding);

  const close = () => { requestId.current += 1; setInspection(null); };
  const inspect = async (expected: ObserveRunTraceArtifact) => {
    if (!canPreview(expected)) return;
    const id = ++requestId.current;
    const binding = artifactBinding(expected);
    setInspection({ scope, binding, expected, state: "loading" });
    try {
      const { item } = await fetchChatGeneratedArtifact(expected.artifactId, workspaceId);
      if (requestId.current !== id || current.current.scope !== scope) return;
      if (!current.current.artifacts.some((artifact) => artifactBinding(artifact) === binding)) return;
      if (!item || artifactBinding(item) !== binding) {
        throw new Error("The artifact no longer matches this run's recorded version and scope. Refresh run evidence before opening it again.");
      }
      if (typeof item.content !== "string" || new TextEncoder().encode(item.content).byteLength > MAX_PREVIEW_BYTES) {
        throw new Error("This artifact is too large for the bounded preview. Open its conversation to inspect it.");
      }
      setInspection({ scope, binding, expected, state: "ready", artifact: item });
    } catch (cause) {
      if (requestId.current === id && current.current.scope === scope) {
        setInspection({ scope, binding, expected, state: "error", error: describeApiError(cause).summary });
      }
    }
  };
  const refresh = () => {
    close();
    void client.invalidateQueries({ queryKey: queryKeys.runTrace(trace.runId) });
  };

  return <section aria-label="Run artifacts" className="rounded-lg border border-line bg-raised p-4">
    <h2 className="font-display text-lg font-semibold text-fg">Artifacts</h2>
    {!scopedRun ? <p className="mt-2 text-sm text-fg-muted">Artifact evidence has no matching run workspace.</p>
      : trace.artifacts.state !== "available" ? <p className="mt-2 text-sm text-fg-muted">Artifact evidence is {humanizeToken(trace.artifacts.state).toLowerCase()}.</p>
        : artifacts.length ? <ul className="mt-3 grid gap-2">{artifacts.map((artifact) => <li key={artifact.artifactId} className="rounded-md border border-line p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="text-sm font-medium text-fg">{artifact.title}</p><p className="text-xs text-fg-muted">{humanizeToken(artifact.kind)} · Version {artifact.version}</p></div>
            <Button size="sm" disabled={!canPreview(artifact)} onClick={() => void inspect(artifact)}>Preview artifact</Button>
          </div>
          {!canPreview(artifact) ? <p className="mt-2 text-xs text-fg-muted">Preview needs a supported format and a recorded version, hash, session, and turn.</p> : null}
        </li>)}</ul> : <p className="mt-2 text-sm text-fg-muted">No artifacts with explicit workspace evidence were returned for this run.</p>}
    <Sheet open={Boolean(active)} onOpenChange={(open) => { if (!open) close(); }} title="Run artifact preview" sideOnDesktop>
      {active ? <div className="cockpit-chat-documents grid min-w-0 gap-3">
        {!unchanged ? <p role="alert" className="text-sm text-status-failed">Run evidence changed. Refresh it before opening this artifact again.</p>
          : active.state === "loading" ? <p role="status" className="text-sm text-fg-muted">Loading the recorded artifact…</p>
            : active.state === "error" ? <p role="alert" className="text-sm text-status-failed">{active.error}</p>
              : active.artifact ? <>
                {active.artifact.publicProjection?.contentRedacted ? <p className="text-sm text-fg-muted">The Gateway redacted content in this preview. The recorded hash identifies the stored artifact.</p> : null}
                <GeneratedArtifactViewer artifact={active.artifact} compact />
              </> : null}
        {!unchanged || active.state === "error" ? <Button size="sm" onClick={refresh}>Refresh run evidence</Button> : null}
        {unchanged ? <NativeOwnerLink scope={[scope, active.expected.artifactId, active.expected.sessionId]} className="text-sm font-medium text-accent hover:underline" href={`/chat?sessionId=${encodeURIComponent(active.expected.sessionId)}&shell=cockpit`}>Open artifact conversation</NativeOwnerLink> : null}
      </div> : null}
    </Sheet>
  </section>;
}
