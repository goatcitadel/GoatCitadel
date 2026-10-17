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
  resourceTime,
  resourceTitle,
  type LibraryResource,
} from "./library-resources";
import { TimeText } from "../../ui/TimeText";
import { readLibraryResource, type ResourcePreview } from "./library-resource-preview";
import { LibraryFileDownload } from "./LibraryFileDownload";
import { LibraryArtifactDownload } from "./LibraryArtifactDownload";
import { readArtifactRunId } from "../../../features/native-routes/library/artifact-run-link";
import { formatArtifactProvenance } from "../../../features/native-routes/shared/native-helpers";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";

/** An object URL for a previewed image, revoked when the image changes or the preview closes. */
function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") return setUrl(undefined);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

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
    /** The read settled after access changed, so its content was withheld. */
    accessChanged?: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  const binding = JSON.stringify([access.identity, workspaceId, citadelId, resourceBinding(resource), attempt]);
  const generation = useRef(0);
  const reopenRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const token = ++generation.current;
    void readLibraryResource(resource, workspaceId, citadelId)
      .then((data) => {
        if (generation.current !== token) return;
        setPreview(isCurrent() ? { binding, data } : { binding, accessChanged: true });
      })
      .catch((cause: unknown) => {
        if (generation.current !== token) return;
        setPreview(
          isCurrent() ? { binding, error: describeApiError(cause).summary } : { binding, accessChanged: true },
        );
      });
    return () => {
      generation.current += 1;
    };
  }, [binding, resource, workspaceId, citadelId, isCurrent]);
  const active = preview?.binding === binding ? preview : undefined;
  const accessChanged = Boolean(active?.accessChanged);
  useEffect(() => {
    if (accessChanged) reopenRef.current?.focus();
  }, [accessChanged]);
  const imageUrl = useObjectUrl(active?.data?.image);
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="break-words text-base font-semibold text-fg">{resourceTitle(resource)}</h3>
      <p className="text-sm text-fg-secondary">{resourceDescription(resource)}</p>
      <p className="text-sm text-fg-secondary">
        <TimeText prefix={resourceTime(resource).label} value={resourceTime(resource).value} absolute />
      </p>
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
      {accessChanged ? (
        <Callout tone="warning">
          <p>Access changed while the preview was loading, so it was not shown. Reopen the preview to read it again.</p>
          <Button ref={reopenRef} size="sm" className="mt-2" onClick={() => setAttempt((value) => value + 1)}>
            Reopen preview
          </Button>
        </Callout>
      ) : null}
      {active?.data?.unavailable ? <p className="text-sm text-fg-secondary">{active.data.unavailable}</p> : null}
      {active?.data?.warning ? <p className="text-sm text-fg-muted">{active.data.warning}</p> : null}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`Preview of ${resourceTitle(resource)}`}
          className="max-h-96 max-w-full rounded-md border border-line object-contain"
        />
      ) : null}
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
      <TechnicalDetails label="Resource identity">
        <code className="block break-all font-mono text-xs">{resourceId(resource)}</code>
      </TechnicalDetails>
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
