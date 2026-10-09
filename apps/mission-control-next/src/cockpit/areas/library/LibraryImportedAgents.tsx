import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type ImportedAgentCatalogRecord, type ImportedAgentCatalogLifecycleStatus } from "@goatcitadel/contracts";
import { fetchImportedAgentCatalog, fetchImportedAgentCatalogEntry, importAgencyAgentCatalog, patchImportedAgentCatalogState } from "@goatcitadel/mission-control-shared/api/agent-catalog";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

export function LibraryImportedAgents({ workspaceId }: { workspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  return <ImportedCatalog key={access.identity} workspaceId={workspaceId} />;
}
function ImportedCatalog({ workspaceId }: { workspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  const client = useQueryClient(), route = useCockpitRoute();
  const [search, setSearch] = useState("");
  const draft = useSessionDraft(`catalog-import:${access.presentationScope}`, { repoUrl: "", ref: "" }, undefined, { label: "Imported catalog source" });
  const { repoUrl, ref } = draft.value;
  const setRepoUrl = (value: string) => draft.setValue({ ...draft.value, repoUrl: value });
  const setRef = (value: string) => draft.setValue({ ...draft.value, ref: value });
  const [review, setReview] = useState<{ kind: "import"; repoUrl: string; ref: string } | { kind: "state"; entry: ImportedAgentCatalogRecord; state: ImportedAgentCatalogLifecycleStatus }>();
  const [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<{ error: boolean; text: string }>();
  const pending = useRef(false);
  const query = useQuery({ queryKey: ["library", "agent-catalog", workspaceId, access.identity], queryFn: () => fetchImportedAgentCatalog({ workspaceId, state: "all", limit: 100 }), staleTime: 0 });
  const entryId = new URLSearchParams(route.search).get("entryId");
  const entry = useQuery({ queryKey: ["library", "agent-catalog-entry", workspaceId, entryId, access.identity], queryFn: () => fetchImportedAgentCatalogEntry(entryId!), enabled: Boolean(entryId), staleTime: 0 });
  const selected = entry.data?.workspaceId === workspaceId ? entry.data : undefined;
  async function submit() {
    if (!review || !access.current() || pending.current || outcome || query.isError) return;
    pending.current = true; setBusy(true);
    try {
      if (review.kind === "import") {
        const result = await importAgencyAgentCatalog({ workspaceId, ...(review.repoUrl.trim() ? { repoUrl: review.repoUrl.trim() } : {}), ...(review.ref.trim() ? { ref: review.ref.trim() } : {}) });
        if (!access.current()) return;
        if (result.workspaceId !== workspaceId) throw new Error("Import receipt belongs to another workspace.");
        draft.acceptSaved({ repoUrl: "", ref: "" }, undefined, { repoUrl: review.repoUrl, ref: review.ref });
        setOutcome({ error: false, text: `Gateway imported ${result.importedCount} definitions from ${result.repoUrl} at ${result.ref}. Unsupported definitions: ${result.parseCounts.unsupported}. Import does not activate a Chat specialist.` });
      } else {
        const fresh = await fetchImportedAgentCatalogEntry(review.entry.entryId);
        if (!access.current()) return;
        if (fresh.workspaceId !== workspaceId || canonicalJsonString(fresh) !== canonicalJsonString(review.entry)) throw new Error("The imported definition changed during review.");
        const result = await patchImportedAgentCatalogState(fresh.entryId, { state: review.state });
        if (!access.current()) return;
        if (result.entryId !== fresh.entryId || result.workspaceId !== workspaceId || result.state !== review.state) throw new Error("Catalog receipt does not confirm the requested state.");
        setOutcome({ error: false, text: `Gateway confirmed catalog state: ${result.state}. Session activation is a separate Chat action.` });
      }
      await client.invalidateQueries({ queryKey: ["library", "agent-catalog"] }); await client.invalidateQueries({ queryKey: ["library", "agent-catalog-entry"] });
    } catch (cause) { if (access.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} The result is not confirmed. Refresh the catalog before retrying.` }); }
    finally { pending.current = false; if (access.current()) setBusy(false); }
  }
  return <section className="grid gap-3" aria-label="Imported agent catalog"><h2 className="font-display text-lg">Imported agent catalog</h2>
    {query.isFetching ? <p role="status">Reading imported catalog…</p> : null}{query.error ? <Callout tone="error">{describeApiError(query.error).summary}</Callout> : null}
    <details><summary>Import agent catalog</summary><div className="mt-2 grid gap-3"><Field label="Catalog repository URL" help="Leave blank to use the Gateway configured source.">{props => <input {...props} className="rounded-md border border-line bg-raised p-2" value={repoUrl} onChange={event => setRepoUrl(event.target.value)} />}</Field><Field label="Catalog Git reference" help="Leave blank to use the Gateway default.">{props => <input {...props} className="rounded-md border border-line bg-raised p-2" value={ref} onChange={event => setRef(event.target.value)} />}</Field><Button disabled={busy || query.isError || query.isFetching} onClick={() => { setOutcome(undefined); setReview({ kind: "import", repoUrl, ref }); }}>Review catalog import</Button></div></details>
    <Field label="Search imported agents">{props => <input {...props} className="rounded-md border border-line bg-raised p-2" value={search} onChange={event => setSearch(event.target.value)} />}</Field><Button disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh imported catalog</Button>
    <ul className="grid gap-2">{query.data?.items.filter(item => item.workspaceId === workspaceId && `${item.definition.frontmatter.name} ${item.division}`.toLowerCase().includes(search.toLowerCase())).map(item => <li key={item.entryId} className="rounded-lg border border-line p-3"><h3>{item.definition.frontmatter.name}</h3><p className="text-sm text-fg-secondary">{item.division} · {item.state} · {item.definition.parseStatus.replaceAll("_", " ")}</p><Button size="sm" onClick={() => route.requestTransition(review => { if (review.isCurrent()) review.navigate(`/library/agents?view=catalog&entryId=${encodeURIComponent(item.entryId)}&shell=cockpit`); })}>Inspect {item.definition.frontmatter.name}</Button></li>)}</ul>
    {entryId && entry.isPending ? <p role="status">Reading imported definition…</p> : null}{entry.error ? <Callout tone="error">{describeApiError(entry.error).summary}</Callout> : null}
    {entryId && !entry.isPending && !entry.error && !selected ? <p role="alert">Imported definition unavailable in this workspace. The link may be stale, foreign or missing.</p> : null}
    {selected ? <section className="grid gap-3 rounded-lg border border-line p-3"><h3 className="font-semibold">{selected.definition.frontmatter.name}</h3><p>{selected.definition.frontmatter.description}</p><p className="text-sm text-fg-secondary">Workspace {workspaceId} · {selected.state} · {selected.definition.parseStatus}</p>{selected.definition.parseWarnings.map((warning, index) => <Callout key={index} tone="warning">{warning}</Callout>)}<TechnicalDetails label="Imported definition provenance"><p>Source: {selected.definition.provenance.repoUrl ?? selected.definition.provenance.provider}</p><p>Path: {selected.definition.provenance.path}</p><p>Commit: {selected.definition.provenance.commit ?? "Unavailable"}</p><p className="break-all">SHA-256: {selected.definition.provenance.sha256}</p></TechnicalDetails><div className="flex flex-wrap gap-2">{(["disabled", "approved", "active", "retired"] as const).filter(state => state !== selected.state).map(state => <Button key={state} disabled={busy || entry.isFetching || entry.isError || ((state === "approved" || state === "active") && selected.definition.parseStatus === "unsupported")} onClick={() => { setOutcome(undefined); setReview({ kind: "state", entry: selected, state }); }}>Review {state}</Button>)}</div></section> : null}
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review imported agent catalog" description="The Gateway remains responsible for import validation, lifecycle policy and activation."><div className="grid gap-3"><p>Workspace {workspaceId}</p><p className="break-words">{review?.kind === "import" ? `${review.repoUrl || "Gateway configured source"} · ${review.ref || "Gateway default reference"}` : `${review?.entry.definition.frontmatter.name} → ${review?.state}`}</p><Callout tone="warning">Imported definitions are untrusted until their lifecycle and parser checks permit use. Catalog state is not proof of session activation.</Callout>{outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}<Button disabled={busy || Boolean(outcome) || query.isError} onClick={() => void submit()}>Confirm catalog request</Button></div></Dialog>
  </section>;
}
