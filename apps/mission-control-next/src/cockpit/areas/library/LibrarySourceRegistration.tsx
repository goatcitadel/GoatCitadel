import { useState } from "react";
import { canonicalJsonString, type ExternalSourceCreateInput, type ExternalSourceKind, type WorkspacePathBridgeSnapshotRecord, type WorkspacePathFlavor } from "@goatcitadel/contracts";
import { inspectExternalSourcePath, registerExternalSource, resolveExternalSourcePath } from "@goatcitadel/mission-control-shared/api/external-sources";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useLibraryOperation } from "./use-library-operation";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Dialog } from "../../ui/Dialog";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

const EMPTY = { kind: "codex_sessions" as ExternalSourceKind, label: "", path: "", inputFlavor: "windows_native" as WorkspacePathFlavor, targetFlavor: "windows_native" as WorkspacePathFlavor, distro: "", producers: "", git: false };
const FLAVORS: WorkspacePathFlavor[] = ["windows_native", "windows_forward", "msys", "wsl", "posix"];
export function LibrarySourceRegistration({ workspaceId, onRegistered }: { workspaceId: string; onRegistered: (sourceId: string) => void }) {
  const operation = useLibraryOperation(JSON.stringify(["source-registration", workspaceId]));
  return <Registration key={operation.identity} workspaceId={workspaceId} onRegistered={onRegistered} />;
}
function Registration({ workspaceId, onRegistered }: { workspaceId: string; onRegistered: (sourceId: string) => void }) {
  const operation = useLibraryOperation(JSON.stringify(["source-registration", workspaceId]));
  const draft = useSessionDraft(operation.presentationScope, EMPTY, undefined, { label: "External source registration" });
  const [bridge, setBridge] = useSessionViewState<{ draft: string; snapshot: WorkspacePathBridgeSnapshotRecord } | undefined>(operation.key + ":bridge", undefined);
  const [review, setReview] = useState<ExternalSourceCreateInput>();
  const [reviewedDraft, setReviewedDraft] = useState<typeof EMPTY>();
  const [registered, setRegistered] = useSessionViewState<{ sourceId: string; label: string; binding: string } | undefined>(operation.key + ":registered", undefined);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useSessionViewState<string | undefined>(operation.key + ":notice", undefined);
  const binding = canonicalJsonString(draft.value);
  const verified = bridge?.draft === binding && bridge.snapshot.workspaceId === workspaceId && bridge.snapshot.status === "verified" && Boolean(bridge.snapshot.canonicalHostPath);
  async function verify() {
    if (busy || operation.locked) return;
    setBusy(true); setNotice(undefined);
    const input = draft.value;
    try {
      const snapshot = await resolveExternalSourcePath({ verificationId: crypto.randomUUID(), workspaceId, inputPath: input.path.trim(), inputFlavor: input.inputFlavor, targetFlavor: input.targetFlavor, requireGitIdentity: input.git, ...((input.inputFlavor === "wsl" || input.targetFlavor === "wsl") ? { distro: input.distro.trim() } : {}) });
      if (!operation.current()) return;
      if (snapshot.workspaceId !== workspaceId || snapshot.inputFlavor !== input.inputFlavor || snapshot.targetFlavor !== input.targetFlavor || snapshot.gitIdentityRequired !== input.git) throw new Error("Path evidence does not match the reviewed workspace and path options.");
      setBridge({ draft: binding, snapshot });
      setNotice(snapshot.status === "verified" ? "Path verified. Registration, scan and source read access remain separate." : `Path ${snapshot.status}: ${snapshot.reasonCode ?? "No reason returned"}. Registration is unavailable.`);
    } catch (cause) { if (operation.current()) setNotice(describeApiError(cause).summary); }
    finally { if (operation.current()) setBusy(false); }
  }
  async function prepare() {
    if (!verified || !bridge || busy || operation.locked || !draft.isDirty || registered?.binding === binding) return;
    setBusy(true); setNotice(undefined);
    try {
      const workspace = (await fetchWorkspaces()).items.find(item => item.workspaceId === workspaceId);
      if (!operation.current()) return;
      if (!workspace || workspace.lifecycleStatus !== "active") throw new Error("The active workspace revision is unavailable. Refresh workspace access before registering.");
      const input = draft.value, snapshot = bridge.snapshot;
      setReviewedDraft({ ...input });
      setReview({ workspaceId, expectedWorkspaceRevision: workspace.revision, kind: input.kind, label: input.label.trim(), canonicalRootPath: snapshot.canonicalHostPath!, pathBridgeSnapshotId: snapshot.snapshotId, pathBridgeSnapshotSha256: snapshot.snapshotSha256, inputFlavor: input.inputFlavor, targetFlavor: input.targetFlavor, ...(snapshot.distro ? { distro: snapshot.distro } : {}), requireGitIdentity: input.git, ...(input.git ? { gitIdentitySha256: snapshot.gitIdentity.identitySha256 } : {}), acceptedProducerVersions: input.producers.split(",").map(value => value.trim()).filter(Boolean) });
    } catch (cause) { if (operation.current()) setNotice(describeApiError(cause).summary); }
    finally { if (operation.current()) setBusy(false); }
  }
  async function confirm() {
    if (!review || !reviewedDraft || busy || operation.locked || registered?.binding === canonicalJsonString(reviewedDraft)) return;
    setBusy(true);
    try {
      const receipt = await operation.run(String(review.expectedWorkspaceRevision), async () => {
        const workspace = (await fetchWorkspaces()).items.find(item => item.workspaceId === workspaceId);
        if (!operation.current()) return;
        const snapshot = await inspectExternalSourcePath(workspaceId, review.pathBridgeSnapshotId);
        if (!workspace || workspace.revision !== review.expectedWorkspaceRevision || workspace.lifecycleStatus !== "active" || snapshot.status !== "verified" || snapshot.snapshotSha256 !== review.pathBridgeSnapshotSha256 || snapshot.canonicalHostPath !== review.canonicalRootPath) throw new Error("Workspace or path evidence changed. Verify and review the source again.");
      }, () => registerExternalSource(review), result => {
        if (result.source.workspaceId !== workspaceId || result.source.canonicalRootPath !== review.canonicalRootPath || result.source.pathBridgeSnapshotSha256 !== review.pathBridgeSnapshotSha256 || result.source.kind !== review.kind) throw new Error("Registration receipt does not match the reviewed source.");
        draft.acceptSaved(reviewedDraft, undefined, reviewedDraft);
        setRegistered({ sourceId: result.source.sourceId, label: result.source.label, binding: canonicalJsonString(reviewedDraft) });
      });
      if (!receipt || !operation.current()) return;
      setNotice(`Registered ${receipt.source.label}. No scan, import or unrestricted source read access is implied.`);
      setReview(undefined);
      openRegistered(receipt.source.sourceId);
    } catch (cause) { if (operation.current()) setNotice(describeApiError(cause).summary); }
    finally { if (operation.current()) setBusy(false); }
  }
  function openRegistered(sourceId: string) {
    if (!operation.current()) return;
    try { onRegistered(sourceId); } catch { setNotice("Registration is saved. Inspection did not open; use Inspect registered source to try the navigation again. Do not register the saved source again."); }
  }
  return <details className="min-w-0 max-w-full wrap-anywhere rounded-md border border-line p-3"><summary>Register external source</summary><div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
    <p>Register one exact read root. The Gateway verifies allowed roots and path identity before registration; registration does not grant context access.</p>
    <Field label="External source kind">{props => <select {...props} className="min-w-0 w-full max-w-full" value={draft.value.kind} onChange={event => draft.setValue({ ...draft.value, kind: event.target.value as ExternalSourceKind })}>{(["codex_sessions", "codex_memory", "claude_sessions", "claude_memory"] as const).map(kind => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</select>}</Field>
    {([['label', 'External source label'], ['path', 'External source root'], ['producers', 'Accepted producer versions']] as const).map(([key, label]) => <Field key={key} label={label}>{props => <input {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={draft.value[key]} onChange={event => draft.setValue({ ...draft.value, [key]: event.target.value })} />}</Field>)}
    {([['inputFlavor', 'Input path format'], ['targetFlavor', 'Target path format']] as const).map(([key, label]) => <Field key={key} label={label}>{props => <select {...props} className="min-w-0 w-full max-w-full" value={draft.value[key]} onChange={event => draft.setValue({ ...draft.value, [key]: event.target.value as WorkspacePathFlavor })}>{FLAVORS.map(flavor => <option key={flavor} value={flavor}>{flavor.replaceAll("_", " ")}</option>)}</select>}</Field>)}
    {draft.value.inputFlavor === "wsl" || draft.value.targetFlavor === "wsl" ? <Field label="WSL distribution">{props => <input {...props} className="min-w-0 w-full max-w-full" value={draft.value.distro} onChange={event => draft.setValue({ ...draft.value, distro: event.target.value })} />}</Field> : null}
    <label><input type="checkbox" checked={draft.value.git} onChange={event => draft.setValue({ ...draft.value, git: event.target.checked })} /> Require verified Git identity</label>
    {notice ? <Callout>{notice}</Callout> : null}{operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    {registered ? <div><p>Saved source: {registered.label}</p><Button disabled={busy} onClick={() => openRegistered(registered.sourceId)}>Inspect registered source</Button></div> : null}
    {verified ? <><p className="break-words">Verified root: {bridge.snapshot.canonicalHostPath}</p><TechnicalDetails label="Path verification provenance"><p>{bridge.snapshot.snapshotId}</p><p className="break-all">SHA-256: {bridge.snapshot.snapshotSha256}</p><p>Recorded: {bridge.snapshot.createdAt}</p></TechnicalDetails></> : null}
    <div className="flex flex-wrap gap-2"><Button disabled={busy || operation.locked || !draft.value.path.trim()} onClick={() => void verify()}>Verify external source path</Button><Button disabled={busy || operation.locked || !draft.isDirty || registered?.binding === binding || !verified || !draft.value.label.trim() || !draft.value.producers.trim()} onClick={() => void prepare()}>Review source registration</Button><Button variant="ghost" disabled={busy} onClick={draft.discard}>Discard source registration draft</Button></div>
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review source registration" description="Register this exact verified root and producer policy."><div className="grid min-w-0 grid-cols-1 gap-3 wrap-anywhere"><p>{review?.label} · Workspace {workspaceId}</p><p className="break-words">Root: {review?.canonicalRootPath}</p><p>Source kind: {review?.kind.replaceAll("_", " ")}</p><p>Accepted producers: {review?.acceptedProducerVersions.join(", ")}</p><p>Git identity required: {review?.requireGitIdentity ? "Yes" : "No"}</p>{notice ? <Callout>{notice}</Callout> : null}<Button disabled={busy || operation.locked} onClick={() => void confirm()}>Confirm source registration</Button></div></Dialog>
  </div></details>;
}
