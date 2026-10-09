import { useRef, useState } from "react";
import { canonicalJsonString, type ChatProjectImportResult } from "@goatcitadel/contracts";
import { importChatProject } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { Callout } from "../../ui/Callout";
import { useCockpitRoute } from "../../app/use-cockpit-route";
const empty = {
  sourceType: "local_folder" as "local_folder" | "github_repo",
  sourcePath: "",
  repoUrl: "",
  ref: "",
  name: "",
};
export function ProjectImport({
  workspaceId,
  citadelId,
  refresh,
}: {
  workspaceId: string;
  citadelId?: string;
  refresh: () => Promise<unknown>;
}) {
  const access = useProjectAccess(JSON.stringify([citadelId, workspaceId])),
    route = useCockpitRoute();
  const draft = useSessionDraft(`project-import:${access.presentationScope}`, empty, undefined, {
    label: "Project import",
  });
  const [review, setReview] = useState<{ token: object; value: typeof empty }>(),
    [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChatProjectImportResult>(),
    [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<string>();
  const pending = useRef(false);
  async function submit() {
    if (
      !review ||
      pending.current ||
      review.token !== access.token ||
      !access.current() ||
      uncertain === canonicalJsonString(review.value)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const value = review.value;
      const response = await importChatProject({
        workspaceId,
        citadelId,
        name: value.name.trim() || undefined,
        sourceType: value.sourceType,
        ...(value.sourceType === "local_folder"
          ? { sourcePath: value.sourcePath.trim() }
          : { repoUrl: value.repoUrl.trim(), ref: value.ref.trim() || undefined }),
      });
      if (!access.current()) return;
      if (response.project.workspaceId !== workspaceId || response.sourceType !== value.sourceType)
        throw new Error("The import receipt does not match this request.");
      setResult(response);
      setReview(undefined);
      draft.acceptSaved(empty, undefined, value);
      await refresh();
    } catch (cause) {
      if (access.current()) {
        setUncertain(canonicalJsonString(review.value));
        setReview(undefined);
        setError(
          `${describeApiError(cause).summary} Import outcome is not confirmed. Inspect refreshed projects before submitting another import; the same request is locked here.`,
        );
      }
    } finally {
      pending.current = false;
      if (access.current()) setBusy(false);
    }
  }
  const valid = draft.value.sourceType === "local_folder" ? draft.value.sourcePath.trim() : draft.value.repoUrl.trim();
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer font-medium">Import project source</summary>
      <section aria-label="Project source import" className="mt-3 grid min-w-0 gap-3">
        <Field label="Project source">
          {(props) => (
            <select
              {...props}
              className="min-w-0 rounded-md border border-line bg-raised p-2"
              value={draft.value.sourceType}
              onChange={(event) =>
                draft.setValue({ ...draft.value, sourceType: event.target.value as typeof empty.sourceType })
              }
            >
              <option value="local_folder">Local folder</option>
              <option value="github_repo">GitHub repository</option>
            </select>
          )}
        </Field>
        {(draft.value.sourceType === "local_folder"
          ? ([["sourcePath", "Folder path"]] as const)
          : ([
              ["repoUrl", "Repository URL"],
              ["ref", "Branch or reference"],
            ] as const)
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            {(props) => (
              <input
                {...props}
                className="w-full min-w-0 rounded-md border border-line bg-raised p-2"
                value={draft.value[key]}
                onChange={(event) => draft.setValue({ ...draft.value, [key]: event.target.value })}
              />
            )}
          </Field>
        ))}
        <Field label="Imported project name (optional)">
          {(props) => (
            <input
              {...props}
              className="w-full min-w-0 rounded-md border border-line bg-raised p-2"
              value={draft.value.name}
              onChange={(event) => draft.setValue({ ...draft.value, name: event.target.value })}
            />
          )}
        </Field>
        <p className="text-sm text-fg-secondary">
          The Gateway copies local folders outside the managed workspace, may initialize Git, or clones the chosen
          repository. Existing path and network policy apply.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!valid || busy || uncertain === canonicalJsonString(draft.value)}
            onClick={() => {
              setError("");
              setReview({ token: access.token, value: { ...draft.value } });
            }}
          >
            Review project import
          </Button>
          <Button disabled={busy} onClick={draft.discard}>
            Discard import draft
          </Button>
        </div>
        {error ? <Callout tone="error">{error}</Callout> : null}
        {result ? (
          <section aria-label="Project import receipt" className="grid gap-2">
            <p>
              Gateway returned {result.project.name}. {result.imported ? "Source imported." : "Existing source reused."}{" "}
              Repository readiness: {result.repoReady ? "ready" : "not ready"}.
            </p>
            <p className="break-all">Materialized path: {result.materializedPath}</p>
            <Button onClick={() => route.navigate(`/chat/projects/${encodeURIComponent(result.project.projectId)}`)}>
              Open imported project
            </Button>
          </section>
        ) : null}
        <Dialog
          open={Boolean(review && review.token === access.token)}
          onOpenChange={(value) => {
            if (!value && !busy) setReview(undefined);
          }}
          title="Review project import"
          description="Review the source and destination scope before materializing project files."
        >
          <div className="grid min-w-0 gap-3">
            <p>
              Workspace {workspaceId} · Citadel {citadelId || "default"}
            </p>
            <p className="break-all">
              {review?.value.sourceType === "local_folder" ? review.value.sourcePath : review?.value.repoUrl}
            </p>
            <p>
              Reference: {review?.value.ref || "Repository default"} · Name:{" "}
              {review?.value.name || "Derived from source"}
            </p>
            <Callout tone="warning">
              This can copy or clone files and initialize a repository under Gateway policy. Importing does not run
              project code.
            </Callout>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void submit()}>
                Confirm project import
              </Button>
              <Button disabled={busy} onClick={() => setReview(undefined)}>
                Cancel
              </Button>
            </div>
          </div>
        </Dialog>
      </section>
    </details>
  );
}
