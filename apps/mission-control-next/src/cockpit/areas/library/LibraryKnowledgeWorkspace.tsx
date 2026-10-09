import { useState } from "react";
import { useLibraryOperation } from "./use-library-operation";
import { LibraryKnowledgeEvidence } from "./LibraryKnowledgeEvidence";
import { LibraryResourceDetail } from "./LibraryResourceDetail";
import { Field } from "../../ui/Field";
import { Button } from "../../ui/Button";
import { useQuery } from "@tanstack/react-query";
import { fetchMemoryFiles } from "@goatcitadel/mission-control-shared/api/memory";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { LibraryEngineeringLearnings } from "./LibraryEngineeringLearnings";
import { LibraryExternalSources } from "./LibraryExternalSources";
import { LibraryKnowledgeActions } from "./LibraryKnowledgeActions";
import { LibraryFileDownload } from "./LibraryFileDownload";
import { Callout } from "../../ui/Callout";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

export function LibraryKnowledgeWorkspace({ workspaceId }: { workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["knowledge", workspaceId]));
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const files = useQuery({ queryKey: ["library", "knowledge-files", access.identity], queryFn: () => fetchMemoryFiles("memory"), staleTime: 0 });
  return <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 p-4" aria-label="Library Knowledge"><header><h1 className="font-display text-xl">Knowledge</h1><p className="text-sm text-fg-secondary">Source material, governed imports, retrieval evidence and Engineering learnings.</p></header>
    <LibraryKnowledgeActions workspaceId={workspaceId} />
    <Field label="Filter Knowledge files">{props => <input {...props} className="rounded-md border border-line bg-canvas p-2" value={filter} onChange={event => setFilter(event.target.value)} />}</Field>
    <section className="grid gap-3"><h2 className="font-display text-lg">Memory files</h2><p className="text-sm text-fg-secondary">Installation memory files returned by the file owner, not a workspace-only directory.</p>{files.error ? <Callout tone="error">{describeApiError(files.error).summary}</Callout> : null}{files.isPending ? <p role="status">Reading memory files…</p> : null}<ul className="grid gap-2">{files.data?.items.filter(file => file.relativePath.toLowerCase().includes(filter.toLowerCase())).map(file => <li key={file.relativePath} className="rounded-md border border-line p-3"><h3 className="break-words">{file.relativePath}</h3><p>{file.size.toLocaleString()} bytes</p><Button onClick={() => setSelectedPath(file.relativePath)}>Preview {file.relativePath}</Button><p>Modified {new Date(file.modifiedAt).toLocaleString()}</p><LibraryFileDownload key={`${file.relativePath}:${file.modifiedAt}`} file={file} /></li>)}</ul></section>
    {files.data?.items.filter(file => file.relativePath === selectedPath).map(file => <LibraryResourceDetail key={access.identity + file.relativePath} resource={{ kind: "files", item: file }} workspaceId={workspaceId} citadelId="personal" />)}
    <LibraryKnowledgeEvidence workspaceId={workspaceId} />
    <LibraryExternalSources workspaceId={workspaceId} /><LibraryEngineeringLearnings workspaceId={workspaceId} />
    <ClassicOwnerLink href="/library/knowledge?shell=classic" scope={workspaceId} label="Open detailed knowledge diagnostics in classic view" />
  </section>;
}
