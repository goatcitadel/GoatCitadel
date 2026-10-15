import type { DocsIngestInput } from "@goatcitadel/contracts";
import { Field } from "../../ui/Field";

/** The session-retained Knowledge source draft. */
export type KnowledgeDraft = {
  title: string;
  source: string;
  sourceType: DocsIngestInput["sourceType"];
  sessionId: string;
  namespace: string;
  query: string;
};

const INPUT = "min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2";

/** Namespace, source type, title and source body for a Knowledge ingest draft. */
export function KnowledgeSourceFields({
  value,
  onChange,
}: {
  value: KnowledgeDraft;
  onChange: (next: KnowledgeDraft) => void;
}) {
  return (
    <>
      <Field label="Knowledge namespace">
        {(props) => (
          <input
            {...props}
            className={INPUT}
            value={value.namespace}
            onChange={(event) => onChange({ ...value, namespace: event.target.value })}
          />
        )}
      </Field>
      <Field label="Source type">
        {(props) => (
          <select
            {...props}
            className={INPUT}
            value={value.sourceType}
            onChange={(event) =>
              onChange({ ...value, sourceType: event.target.value as DocsIngestInput["sourceType"] })
            }
          >
            <option value="text">Text</option>
            <option value="file">File</option>
            <option value="url">URL</option>
          </select>
        )}
      </Field>
      <Field label="Source title">
        {(props) => (
          <input
            {...props}
            className={INPUT}
            value={value.title}
            onChange={(event) => onChange({ ...value, title: event.target.value })}
          />
        )}
      </Field>
      <Field label="Knowledge source" help="Text, an allowed file path, or a URL matching the selected source type.">
        {(props) => (
          <textarea
            {...props}
            rows={4}
            className={INPUT}
            value={value.source}
            onChange={(event) => onChange({ ...value, source: event.target.value })}
          />
        )}
      </Field>
    </>
  );
}
