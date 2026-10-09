import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type AgentProfileRecord } from "@goatcitadel/contracts";
import { fetchAgent, createAgentProfile, updateAgentProfile, archiveAgentProfile, restoreAgentProfile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

const empty = { roleId: "", name: "", title: "", summary: "", specialties: "", aliases: "", defaultTools: "" };
const fields = { roleId: "Role ID", name: "Agent name", title: "Agent title", summary: "Agent summary", specialties: "Specialties", aliases: "Aliases", defaultTools: "Default tools" };
function from(item?: AgentProfileRecord) { return item ? { roleId: item.roleId, name: item.name, title: item.title, summary: item.summary, specialties: item.specialties.join(", "), aliases: item.aliases.join(", "), defaultTools: item.defaultTools.join(", ") } : empty; }
const split = (value: string) => [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
export function LibraryAgentEditor({ agentId, workspaceId, onClose }: { agentId?: string; workspaceId: string; onClose?: () => void }) {
  const access = useProjectAccess(JSON.stringify([workspaceId, agentId]));
  const query = useQuery({ queryKey: ["library", "agent", agentId, access.identity], queryFn: () => fetchAgent(agentId!), enabled: Boolean(agentId), staleTime: 0 });
  if (agentId && !query.data) return <Callout tone={query.isError ? "error" : "info"}>{query.isError ? describeApiError(query.error).summary : "Reading agent profile…"}</Callout>;
  return <AgentEditor key={access.identity} item={query.data} workspaceId={workspaceId} available={!agentId || (!query.isFetching && !query.isError)} onClose={onClose} />;
}
function AgentEditor({ item, workspaceId, available, onClose }: { item?: AgentProfileRecord; workspaceId: string; available: boolean; onClose?: () => void }) {
  const access = useProjectAccess(JSON.stringify([workspaceId, item?.agentId]));
  const client = useQueryClient(), leave = useDraftLeave();
  const draft = useSessionDraft(JSON.stringify(["cockpit-agent", getGatewayApiBaseUrl(), workspaceId, item?.agentId ?? "new"]), from(item), item?.updatedAt, { label: item?.name ?? "New agent profile" });
  const [review, setReview] = useState<{ action: "save" | "archive" | "restore"; item?: AgentProfileRecord; draft: typeof empty }>(), [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<{ error: boolean; text: string }>();
  const pending = useRef(false);
  const editable = !item || item.editable;
  const stale = Boolean(item && item.updatedAt !== draft.baseRevision);
  const changedReview = Boolean(review?.item && item && canonicalJsonString(review.item) !== canonicalJsonString(item));
  async function confirm() {
    if (!review || !access.current() || pending.current || outcome || !available || (review.action === "save" && !editable) || changedReview) return;
    pending.current = true; setBusy(true);
    try {
      if (review.item) { const fresh = await fetchAgent(review.item.agentId); if (canonicalJsonString(fresh) !== canonicalJsonString(review.item)) throw new Error("The profile changed during review. Refresh and inspect it before making another request."); }
      if (!access.current()) return;
      const value = review.draft;
      const input = { name: value.name.trim(), title: value.title.trim(), summary: value.summary.trim(), specialties: split(value.specialties), aliases: split(value.aliases), defaultTools: split(value.defaultTools) };
      const saved = review.action === "archive" ? await archiveAgentProfile(review.item!.agentId) : review.action === "restore" ? await restoreAgentProfile(review.item!.agentId) : review.item ? await updateAgentProfile(review.item.agentId, input) : await createAgentProfile({ ...input, roleId: value.roleId.trim() });
      if (!access.current()) return;
      if ((review.item && saved.agentId !== review.item.agentId) || (review.action === "archive" && saved.lifecycleStatus !== "archived") || (review.action === "restore" && saved.lifecycleStatus !== "active")) throw new Error("The returned profile does not confirm this request.");
      if (review.action === "save") draft.acceptSaved(review.item ? from(saved) : empty, review.item ? saved.updatedAt : undefined, review.draft);
      setOutcome({ error: false, text: `${saved.name}: ${review.action === "save" ? "profile saved" : saved.lifecycleStatus}.` });
      await client.invalidateQueries({ queryKey: ["library", "agents"] }); await client.invalidateQueries({ queryKey: ["library", "agent"] });
    } catch (cause) { if (access.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} The action is not confirmed. Your draft is retained; refresh before retrying.` }); }
    finally { pending.current = false; if (access.current()) setBusy(false); }
  }
  function start(action: "save" | "archive" | "restore") { setOutcome(undefined); setReview({ action, item, draft: { ...draft.value } }); }
  return <section className="grid gap-3 rounded-lg border border-line p-3" aria-label="Agent profile editor"><h2 className="font-display text-lg">{item?.name ?? "New agent profile"}</h2><p className="text-sm text-fg-secondary">Installation-wide profile{item ? ` · ${item.lifecycleStatus} · ${item.isBuiltin ? "Built-in role" : "Custom role"}` : ""}. Default tools do not grant tool access.</p>{!editable ? <Callout>Profile fields are read-only. Archive and restore remain governed by the Gateway.</Callout> : null}{stale ? <Callout tone="warning">The profile changed. Discard your draft to load the latest version.</Callout> : null}
    {(Object.keys(fields) as (keyof typeof empty)[]).map(key => <Field key={key} label={fields[key]} help={["specialties", "aliases", "defaultTools"].includes(key) ? "Comma-separated values." : undefined}>{props => key === "summary" ? <textarea {...props} className="w-full rounded-md border border-line bg-raised p-2" rows={4} disabled={!editable} value={draft.value[key]} onChange={event => draft.setValue({ ...draft.value, [key]: event.target.value })} /> : <input {...props} className="w-full rounded-md border border-line bg-raised p-2" disabled={!editable || (key === "roleId" && Boolean(item))} value={draft.value[key]} onChange={event => draft.setValue({ ...draft.value, [key]: event.target.value })} />}</Field>)}
    <div className="flex flex-wrap gap-2"><Button disabled={!editable || !available || stale || busy || !draft.value.roleId.trim() || !draft.value.name.trim() || !draft.value.title.trim() || !draft.value.summary.trim()} onClick={() => start("save")}>Review agent save</Button><Button disabled={busy} variant="ghost" onClick={draft.discard}>Discard agent changes</Button>{item ? <Button disabled={!available || busy} onClick={() => start(item.lifecycleStatus === "archived" ? "restore" : "archive")}>{item.lifecycleStatus === "archived" ? "Review agent restore" : "Review agent archive"}</Button> : onClose ? <Button disabled={busy} variant="ghost" onClick={() => leave.request(onClose)}>Close new profile</Button> : null}</div>
    {item ? <TechnicalDetails label="Profile provenance and diagnostics"><p>Profile: {item.agentId} · Updated {item.updatedAt}</p><p>Definition: {item.richDefinitionId ?? "No imported definition"} · {item.richDefinitionParseStatus ?? "No parser result"}</p><p>{item.activeSessions} active conversations · Runtime {item.status}</p></TechnicalDetails> : null}
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review agent profile" description="This changes an installation-wide reusable profile."><div className="grid gap-3"><p>{review?.draft.name} · {review?.action}</p><Callout tone="warning">{review?.action === "archive" ? "Archive removes this profile from active selection while retaining its records." : "The Gateway validates the role, duplicate names, profile fields and tool defaults. Existing tool grants remain authoritative."}</Callout>{outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : changedReview ? <Callout tone="warning">The profile changed during review. Refresh before proceeding.</Callout> : null}<Button disabled={busy || Boolean(outcome) || changedReview || !available} onClick={() => void confirm()}>Confirm agent change</Button></div></Dialog>{leave.dialog}
  </section>;
}
