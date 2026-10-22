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
import { formatBytes } from "@goatcitadel/mission-control-shared/content/format";
import { TimeText } from "../../ui/TimeText";
import { LIBRARY_SECTION_LABELS } from "./library-sections";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Section } from "../../ui/Section";

export function LibraryKnowledgeWorkspace({ workspaceId }: { workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["knowledge", workspaceId]));
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const files = useQuery({
    queryKey: ["library", "knowledge-files", access.identity],
    queryFn: () => fetchMemoryFiles("memory"),
    staleTime: 0,
  });
  return (
    <section className={AREA_PAGE} aria-label="Library Knowledge">
      <AreaHeader
        title={LIBRARY_SECTION_LABELS.knowledge}
        description="Source material, governed imports, retrieval history and Engineering learnings."
      />
      <LibraryKnowledgeActions workspaceId={workspaceId} />
      <Field label="Filter Knowledge files">
        {(props) => (
          <input
            {...props}
            className="rounded-md border border-line bg-canvas p-2"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
      </Field>
      <Section title="Memory files" description="Installation memory files, not a workspace-only directory.">
        {files.error ? <Callout tone="error">{describeApiError(files.error).summary}</Callout> : null}
        {files.isPending ? <p role="status">Reading memory files…</p> : null}
        <ul className="divide-y divide-line-subtle">
          {files.data?.items
            .filter((file) => file.relativePath.toLowerCase().includes(filter.toLowerCase()))
            .map((file) => (
              <li key={file.relativePath} className="space-y-1 py-3">
                <h3 className="break-words">{file.relativePath}</h3>
                <p>{formatBytes(file.size)}</p>
                <Button onClick={() => setSelectedPath(file.relativePath)}>Preview {file.relativePath}</Button>
                <p>
                  <TimeText prefix="Modified" value={file.modifiedAt} />
                </p>
                <LibraryFileDownload key={`${file.relativePath}:${file.modifiedAt}`} file={file} />
              </li>
            ))}
        </ul>
      </Section>
      {files.data?.items
        .filter((file) => file.relativePath === selectedPath)
        .map((file) => (
          <LibraryResourceDetail
            key={access.identity + file.relativePath}
            resource={{ kind: "files", item: file }}
            workspaceId={workspaceId}
            citadelId="personal"
          />
        ))}
      <LibraryKnowledgeEvidence workspaceId={workspaceId} />
      <LibraryExternalSources workspaceId={workspaceId} />
      <LibraryEngineeringLearnings workspaceId={workspaceId} />
    </section>
  );
}
