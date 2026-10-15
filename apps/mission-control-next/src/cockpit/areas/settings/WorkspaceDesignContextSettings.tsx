import { useCallback, useEffect, useState } from "react";
import type { ChatGeneratedArtifactRecord, GuidanceDocType } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  fetchChatGeneratedArtifacts,
  fetchWorkspaceGuidance,
  updateWorkspaceGuidance,
} from "@goatcitadel/mission-control-shared/api/client";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";

type ContextDocType = Extract<GuidanceDocType, "product" | "design">;

const DOCS: ReadonlyArray<{ docType: ContextDocType; fileName: string; purpose: string }> = [
  {
    docType: "product",
    fileName: "PRODUCT.md",
    purpose: "Who this workspace builds for, what it values, and the tone to keep.",
  },
  {
    docType: "design",
    fileName: "DESIGN.md",
    purpose: "Visual direction, components to reuse, and the brand block that decks and documents pick up.",
  },
];

// Mirrors DESIGN_BRAND_BLOCK_EXAMPLE in @goatcitadel/skills; the cockpit depends on contracts only.
const BRAND_BLOCK_EXAMPLE = [
  "```brand",
  "name: Acme Cooperative",
  "colors: #0f172a, #0ea5e9, #f8fafc",
  "fonts: Inter, Source Serif 4",
  "logo: assets/logo.svg",
  "```",
].join("\n");

const TEXTAREA_CLASS =
  "mt-1 block min-h-40 w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg";

type DocState<T> = Record<ContextDocType, T>;

export function WorkspaceDesignContextSettings({ workspaceId }: { workspaceId: string }) {
  const [drafts, setDrafts] = useState<DocState<string>>({ product: "", design: "" });
  const [status, setStatus] = useState<DocState<string | null>>({ product: null, design: null });
  const [saving, setSaving] = useState<ContextDocType | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [artifacts, setArtifacts] = useState<ChatGeneratedArtifactRecord[]>([]);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setLoaded(false);
    setArtifactsError(null);
    void (async () => {
      try {
        const bundle = await fetchWorkspaceGuidance(workspaceId);
        if (cancelled) return;
        const content = (docType: ContextDocType) =>
          bundle.workspace.find((doc) => doc.docType === docType)?.content ?? "";
        setDrafts({ product: content("product"), design: content("design") });
        setLoaded(true);
      } catch (error) {
        if (!cancelled) setLoadError(describeApiError(error).summary);
      }
      try {
        const response = await fetchChatGeneratedArtifacts({ workspaceId, kind: "markdown", limit: 50 });
        if (cancelled) return;
        // A redacted projection's hash names the stored bytes, not the text shown; never apply those.
        const items = response.items.filter(
          (item) =>
            item.content.trim().length > 0 &&
            !item.publicProjection?.contentRedacted &&
            !item.publicProjection?.artifactRedacted,
        );
        setArtifacts(items);
        setSelectedArtifactId((current) => current || items[0]?.artifactId || "");
      } catch (error) {
        if (!cancelled) setArtifactsError(describeApiError(error).summary);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const save = useCallback(
    async (docType: ContextDocType, content: string) => {
      const fileName = DOCS.find((doc) => doc.docType === docType)?.fileName ?? docType;
      setSaving(docType);
      setStatus((current) => ({ ...current, [docType]: null }));
      try {
        const saved = await updateWorkspaceGuidance(workspaceId, docType, content);
        setDrafts((current) => ({ ...current, [docType]: saved.content }));
        setStatus((current) => ({ ...current, [docType]: `Saved ${fileName}` }));
      } catch (error) {
        setStatus((current) => ({
          ...current,
          [docType]: `Could not save ${fileName}: ${describeApiError(error).summary}`,
        }));
      } finally {
        setSaving(null);
      }
    },
    [workspaceId],
  );

  // Saving is only possible once the stored documents are in the editors: an early or failed load must
  // never be overwritten with empty text.
  const editable = loaded && !loadError;

  const applyArtifact = (docType: ContextDocType) => {
    const artifact = artifacts.find((item) => item.artifactId === selectedArtifactId);
    if (!artifact) return;
    const fileName = DOCS.find((doc) => doc.docType === docType)?.fileName ?? docType;
    // The applied artifact's hash travels inside the document, so the provenance stays inspectable.
    // Applying only fills the editor; the operator reviews and presses Save, so nothing is replaced silently.
    const provenance = `<!-- applied from generated artifact ${artifact.artifactId} contentHash ${artifact.contentHash ?? "unknown"} -->\n`;
    setDrafts((current) => ({ ...current, [docType]: `${provenance}${artifact.content}` }));
    setStatus((current) => ({ ...current, [docType]: `Review the ${fileName} editor, then save.` }));
  };

  return (
    <section
      id="design-context"
      aria-label="Design context"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4"
    >
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Design context</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          PRODUCT.md and DESIGN.md apply to only this workspace, so a family workspace and a company workspace can keep
          different brands. The design skill reads them when it designs, and decks and documents use the brand block.
        </p>
      </header>
      {loadError ? (
        <p role="alert" className="text-sm text-status-failed">
          Workspace documents unavailable: {loadError}
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {DOCS.map((doc) => (
          <div key={doc.docType} className="space-y-2">
            <Field label={doc.fileName} help={doc.purpose}>
              {(field) => (
                <textarea
                  {...field}
                  value={drafts[doc.docType]}
                  disabled={!editable}
                  spellCheck={false}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDrafts((current) => ({ ...current, [doc.docType]: value }));
                  }}
                  className={TEXTAREA_CLASS}
                />
              )}
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!editable || saving !== null}
                onClick={() => void save(doc.docType, drafts[doc.docType])}
              >
                Save {doc.fileName}
              </Button>
              {status[doc.docType] ? (
                <p role="status" className="text-xs text-fg-secondary">
                  {status[doc.docType]}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer">Brand block format</summary>
        <p className="mt-2">
          Put one fenced block in DESIGN.md with up to six hex colors, up to three fonts, and a logo path inside the
          workspace. The first color becomes the accent for decks and documents.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-sunken p-2 font-mono text-xs text-fg">
          {BRAND_BLOCK_EXAMPLE}
        </pre>
      </details>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-fg">Apply a generated artifact</h4>
        <p className="text-xs text-fg-muted">
          When a chat turn drafts PRODUCT.md or DESIGN.md, save it as a generated artifact first; applying it here loads
          it into the editor with the artifact and its hash recorded at the top, and nothing changes until you save.
        </p>
        {artifactsError ? (
          <p role="alert" className="text-sm text-status-failed">
            Generated artifacts unavailable: {artifactsError}
          </p>
        ) : null}
        {artifacts.length === 0 ? (
          <p className="text-xs text-fg-muted">No generated Markdown artifacts in this workspace yet.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-sm text-fg-secondary">
              Generated artifact
              <select
                value={selectedArtifactId}
                onChange={(event) => setSelectedArtifactId(event.target.value)}
                className="mt-1 block min-h-10 w-full rounded-md border border-line-control bg-canvas px-2 text-fg"
              >
                {artifacts.map((artifact) => (
                  <option key={artifact.artifactId} value={artifact.artifactId}>
                    {artifact.title}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" disabled={!editable || saving !== null} onClick={() => applyArtifact("design")}>
              Apply as DESIGN.md
            </Button>
            <Button size="sm" disabled={!editable || saving !== null} onClick={() => applyArtifact("product")}>
              Apply as PRODUCT.md
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
