import { useLibraryOperation } from "./use-library-operation";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useEffect, useRef, useState } from "react";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  resourceBinding,
  resourceDescription,
  resourceId,
  resourceTitle,
  type LibraryResource,
} from "./library-resources";
import { readLibraryResource, type ResourcePreview } from "./library-resource-preview";
import { LibraryFileDownload } from "./LibraryFileDownload";
import { LibraryArtifactDownload } from "./LibraryArtifactDownload";
import { readArtifactRunId } from "../../../features/native-routes/library/artifact-run-link";
import { formatArtifactProvenance } from "../../../features/native-routes/shared/native-helpers";
import { useCockpitRoute } from "../../app/use-cockpit-route";

export function LibraryResourceDetail({
  resource,
  workspaceId,
  citadelId,
}: {
  resource: LibraryResource;
  workspaceId: string;
  citadelId: string;
}) {
  const access = useLibraryOperation(JSON.stringify(["resource-preview", workspaceId, citadelId]));
  const isCurrent = access.current;
  const route = useCockpitRoute();
  const recordedRunId = resource.kind === "artifacts" ? readArtifactRunId(resource.item) : undefined;
  const runId = typeof recordedRunId === "string" && recordedRunId.trim() ? recordedRunId : undefined;
  const artifactHref = (pathname: string, source = true) => {
    if (resource.kind !== "artifacts") return pathname;
    const item = resource.item,
      params = new URLSearchParams(route.search);
    params.delete("shell");
    params.delete("shellScope");
    params.set("workspaceId", workspaceId);
    params.set("citadelId", citadelId);
    params.set("artifactId", item.artifactId);
    if (source) {
      params.set("sessionId", item.sessionId);
      params.set("turnId", item.turnId);
    } else {
      params.delete("sessionId");
      params.delete("turnId");
    }
    if (item.projectId) params.set("projectId", item.projectId);
    else params.delete("projectId");
    if (source && runId) params.set("runId", runId);
    else params.delete("runId");
    return pathname + "?" + params + route.hash;
  };
  const [preview, setPreview] = useState<{
    binding: string;
    data?: ResourcePreview;
    error?: string;
  }>();
  const binding = JSON.stringify([access.identity, workspaceId, citadelId, resourceBinding(resource)]);
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current;
    void readLibraryResource(resource, workspaceId, citadelId)
      .then((data) => {
        if (generation.current === token && isCurrent()) setPreview({ binding, data });
      })
      .catch((cause: unknown) => {
        if (generation.current === token && isCurrent())
          setPreview({ binding, error: describeApiError(cause).summary });
      });
    return () => {
      generation.current += 1;
    };
  }, [binding, resource, workspaceId, citadelId, isCurrent]);
  const active = preview?.binding === binding ? preview : undefined;
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="break-words font-display text-lg font-semibold text-fg">{resourceTitle(resource)}</h3>
      <p className="text-sm text-fg-secondary">{resourceDescription(resource)}</p>
      <TechnicalDetails label="Exact resource timestamps">
        <p>{resource.kind === "files" ? resource.item.modifiedAt : resource.item.createdAt}</p>
      </TechnicalDetails>
      {resource.kind === "files" ? <LibraryFileDownload key={binding} file={resource.item} /> : null}
      {resource.kind === "artifacts" ? (
        <LibraryArtifactDownload
          key={binding}
          artifact={resource.item}
          workspaceId={workspaceId}
          citadelId={citadelId}
        />
      ) : null}
      {!active ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading resource preview…
        </p>
      ) : null}
      {active?.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {active.error}
        </p>
      ) : null}
      {active?.data?.warning ? <p className="text-sm text-fg-muted">{active.data.warning}</p> : null}
      {active?.data?.text !== undefined ? (
        <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">
          {active.data.text || "No content recorded."}
        </div>
      ) : null}
      {active?.data?.artifact ? (
        <div className="cockpit-chat-documents min-w-0">
          <GeneratedArtifactViewer artifact={active.data.artifact} compact />
        </div>
      ) : null}
      <details className="text-xs text-fg-muted">
        <summary>Resource identity</summary>
        <code className="mt-2 block break-all font-mono">{resourceId(resource)}</code>
      </details>
      {resource.kind === "artifacts" ? (
        <TechnicalDetails label="Artifact provenance">
          <pre className="whitespace-pre-wrap break-all">{formatArtifactProvenance(resource.item)}</pre>
        </TechnicalDetails>
      ) : null}
      {resource.kind === "artifacts" && resource.item.workspaceId === workspaceId ? (
        <>
          <NativeOwnerLink
            scope={binding}
            className="text-sm font-medium text-accent hover:underline"
            href={artifactHref("/chat")}
          >
            Open artifact conversation
          </NativeOwnerLink>
          <NativeOwnerLink
            scope={binding}
            className="text-sm font-medium text-accent hover:underline"
            href={artifactHref("/library/artifacts")}
          >
            Reopen exact artifact
          </NativeOwnerLink>
          <NativeOwnerLink
            scope={binding}
            className="text-sm font-medium text-accent hover:underline"
            href={artifactHref("/chat", false)}
          >
            Use artifact in Chat
          </NativeOwnerLink>
          {runId ? (
            <NativeOwnerLink
              scope={binding}
              className="text-sm font-medium text-accent hover:underline"
              href={artifactHref("/work/runs/" + encodeURIComponent(runId))}
            >
              Open artifact run
            </NativeOwnerLink>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
