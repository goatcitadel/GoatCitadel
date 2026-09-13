import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Download, Upload, X } from "lucide-react";
import type { CitadelBlueprint, CitadelBlueprintValidationResult } from "@goatcitadel/contracts";
import {
  exportCitadelBlueprint,
  importCitadelBlueprint,
  isApiRequestError,
  listCitadels,
  validateCitadelBlueprint,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

interface ExportState {
  loading: boolean;
  error: string | null;
  staged: boolean;
  json: string | null;
}

interface ImportState {
  validation: CitadelBlueprintValidationResult | null;
  busy: boolean;
  done: boolean;
  error: string | null;
}

const INITIAL_IMPORT: ImportState = { validation: null, busy: false, done: false, error: null };

function parseBlueprint(text: string): { blueprint: unknown } | { parseError: string } {
  try {
    return { blueprint: JSON.parse(text) };
  } catch (error) {
    return { parseError: getErrorMessage(error) };
  }
}

/**
 * Blueprint import/export (spec §8). A Blueprint is the portable, secret-free
 * description of a Citadel. Export serializes the active Citadel; import validates
 * (schema + secret-scan) before applying, so a shared Blueprint can never smuggle
 * credentials or silently activate connections.
 */
export function CitadelBlueprintRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const importId = useId();
  const [exportState, setExportState] = useState<ExportState>({
    loading: true,
    error: null,
    staged: false,
    json: null,
  });
  const [view, setView] = useState<"export" | "import">("export");
  const [confirmImport, setConfirmImport] = useState(false);
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const validationGeneration = useRef(0);
  const leave = useDraftLeave();
  const blueprintDraft = useSessionDraft(`blueprint-import:${activeCitadelId}`, "", undefined, { label: "Blueprint import", active: view === "import" });
  const importText = blueprintDraft.value;
  const setImportText = blueprintDraft.setValue;
  const [importState, setImportState] = useState<ImportState>(INITIAL_IMPORT);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const exportProofItems = buildBlueprintProofItems(exportState.json, activeCitadelId);

  useEffect(() => {
    let cancelled = false;
    setExportState((current) => ({ ...current, loading: true, error: null }));
    void listCitadels("active", 500)
      .then(async ({ items }) => {
        const listed = items.find((item) => item.citadelId === activeCitadelId || item.slug === activeCitadelId);
        if (!listed || listed.hasCharter === false) {
          return null;
        }
        return exportCitadelBlueprint(activeCitadelId);
      })
      .then((blueprint) => {
        if (!cancelled) {
          setExportState({
            loading: false,
            error: null,
            staged: Boolean(blueprint),
            json: blueprint ? JSON.stringify(blueprint, null, 2) : null,
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (isApiRequestError(error) && error.status === 404) {
          setExportState({ loading: false, error: null, staged: false, json: null });
        } else {
          setExportState({ loading: false, error: getErrorMessage(error), staged: false, json: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCitadelId]);

  const validate = useCallback(async () => {
    const generation = ++validationGeneration.current;
    setValidatedText(null);
    const parsed = parseBlueprint(importText);
    if ("parseError" in parsed) {
      setImportState({ ...INITIAL_IMPORT, validation: { ok: false, errors: [`Invalid JSON: ${parsed.parseError}`] } });
      return;
    }
    try {
      const validation = await validateCitadelBlueprint(parsed.blueprint);
      if (generation !== validationGeneration.current) return;
      setValidatedText(importText);
      setImportState({ ...INITIAL_IMPORT, validation });
    } catch (error) {
      if (generation === validationGeneration.current) setImportState({ ...INITIAL_IMPORT, error: getErrorMessage(error) });
    }
  }, [importText]);

  const applyImport = useCallback(async () => {
    if (validatedText !== importText || !importState.validation?.ok || importState.busy) return;
    const submitted = importText;
    const parsed = parseBlueprint(importText);
    if ("parseError" in parsed) {
      return;
    }
    setImportState((current) => ({ ...current, busy: true, error: null }));
    try {
      await importCitadelBlueprint(activeCitadelId, parsed.blueprint as CitadelBlueprint);
      blueprintDraft.acceptSaved("", undefined, submitted);
      setValidatedText(null);
      setImportState((current) => ({ ...current, validation: null, busy: false, done: true }));
      setConfirmImport(false);
    } catch (error) {
      setImportState((current) => ({ ...current, busy: false, error: getErrorMessage(error) }));
    }
  }, [activeCitadelId, importText, validatedText, importState.validation, importState.busy, blueprintDraft.acceptSaved]);

  const canApply = validatedText === importText && importState.validation?.ok === true && !importState.busy;

  const loadExportForImport = useCallback(() => {
    if (!exportState.json) {
      return;
    }
    leave.request(() => {
      setImportText(exportState.json!); setView("import");
      validationGeneration.current += 1; setValidatedText(null); setImportState(INITIAL_IMPORT);
    }, [blueprintDraft.key]);
  }, [exportState.json, leave, blueprintDraft.key, setImportText]);

  const downloadExport = useCallback(() => {
    if (!exportState.json) {
      return;
    }
    downloadBlueprint(exportState.json, activeCitadelId);
    setExportNotice("Blueprint downloaded as a secret-free JSON file.");
  }, [activeCitadelId, exportState.json]);

  return (
    <NativePageFrame
      icon={Download}
      area="library"
      kicker={routeKicker(route)}
      title="Blueprint"
      description={`Export ${activeCitadelName} as a portable, secret-free Blueprint, or import one. Imports are validated and secret-scanned before they apply.`}
      loading={exportState.loading}
      error={exportState.error}
    >
      <div className="mc-next-settings-button-row" role="group" aria-label="Blueprint view">{(["export", "import"] as const).map((item) => <NativeButton key={item} variant="ghost" aria-pressed={view === item} onClick={() => leave.request(() => setView(item), [blueprintDraft.key])}>{item === "export" ? "Export" : `Import${blueprintDraft.isDirty ? " · Unsaved" : ""}`}</NativeButton>)}</div>
      <NativeGrid className="mc-next-calm-directory">
        {view === "export" ? <NativeCard title="Export" subtitle="The current Citadel as a Blueprint. Secrets are never included.">
          {exportState.staged && exportState.json ? (
            <>
              <NativeList items={exportProofItems} emptyLabel="No export proof available." density="compact" />
              <div className="mc-next-blueprint-actions">
                <NativeButton variant="default" onClick={downloadExport}>
                  <Download size={16} />
                  Download blueprint
                </NativeButton>
                <NativeButton variant="outline" onClick={loadExportForImport}>
                  <Upload size={16} />
                  Load export for import
                </NativeButton>
              </div>
              {exportNotice ? <NoticeBanner tone="success" message={exportNotice} /> : null}
              <details className="mc-next-inline-disclosure"><summary>Export preview</summary><pre className="mc-next-blueprint-json" aria-label="Exported Blueprint">
                {exportState.json}
              </pre></details>
            </>
          ) : (
            <EmptyState size="compact" title={`${activeCitadelName} needs a Charter before export.`} />
          )}
        </NativeCard> : null}

        {view === "import" ? <NativeCard
          title="Import"
          subtitle="Paste a Blueprint, validate it, then apply. Validation runs a schema check and a secret scan."
        >
          <label className="mc-next-mason-field" htmlFor={importId}>
            <span>Blueprint JSON</span>
            <textarea
              id={importId}
              className="mc-next-settings-textarea"
              value={importText}
              rows={6}
              placeholder='{ "schemaVersion": "goatcitadel.blueprint.v1", ... }'
              onChange={(event) => {
                validationGeneration.current += 1; setValidatedText(null);
                setImportText(event.target.value);
                setImportState(INITIAL_IMPORT);
              }}
            />
          </label>
          <div className="mc-next-blueprint-actions">
            <NativeButton variant="default" disabled={importText.trim().length === 0} onClick={() => void validate()}>
              <Check size={16} />
              Validate
            </NativeButton>
            <NativeButton variant="outline" disabled={!canApply} onClick={() => setConfirmImport(true)}>
              <Upload size={16} />
              {importState.busy ? "Importing…" : "Review import"}
            </NativeButton>
          </div>

          {importState.error ? <NoticeBanner tone="error" message={importState.error} /> : null}
          {importState.done ? <p className="mc-next-blueprint-ok">Blueprint imported.</p> : null}
          {importState.validation ? (
            importState.validation.ok ? (
              <p className="mc-next-blueprint-ok">
                <Check size={16} aria-hidden="true" />
                Valid — safe to import.
              </p>
            ) : (
              <div className="mc-next-blueprint-errors">
                <p>
                  <X size={16} aria-hidden="true" />
                  Cannot import:
                </p>
                <NativeList
                  items={importState.validation.errors.map((message) => ({ title: message }))}
                  emptyLabel="Invalid."
                  density="compact"
                />
              </div>
            )
          ) : null}
        </NativeCard> : null}
      </NativeGrid>
      {leave.dialog}
      <ConfirmModal open={confirmImport} title="Apply this Blueprint?" message={`Apply the validated Blueprint to ${activeCitadelName}? External connections and grants still require their existing setup and approval steps.`} confirmLabel={importState.busy ? "Importing…" : "Apply Blueprint"} pending={importState.busy} disableDismiss={importState.busy} cancelDisabled={importState.busy} onCancel={() => setConfirmImport(false)} onConfirm={() => void applyImport()} />
    </NativePageFrame>
  );
}

export function downloadBlueprint(exportedJson: string, citadelId: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Browser downloads are unavailable in this environment.");
  }
  const objectUrl = URL.createObjectURL(new Blob([exportedJson], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${sanitizeBlueprintFilename(citadelId)}-blueprint.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function sanitizeBlueprintFilename(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 80) || "citadel";
}

export function buildBlueprintProofItems(
  exportedJson: string | null,
  citadelId: string,
): Array<{ title: string; meta?: string; body?: string }> {
  if (!exportedJson) {
    return [];
  }
  const parsed = parseBlueprint(exportedJson);
  const blueprint =
    "blueprint" in parsed && parsed.blueprint && typeof parsed.blueprint === "object"
      ? (parsed.blueprint as Record<string, unknown>)
      : {};
  return [
    {
      title: "Citadel",
      meta: citadelId,
      body: "Export is generated through the Gateway-backed Citadel blueprint API.",
    },
    {
      title: "Schema",
      meta: typeof blueprint.schemaVersion === "string" ? blueprint.schemaVersion : "unknown",
      body: "Portable Blueprint schema used for validation before import.",
    },
    {
      title: "Content",
      meta: `${exportedJson.length} chars`,
      body: "Read-only artifact preview; importing requires explicit validation and operator action.",
    },
    {
      title: "Secret posture",
      meta: "secret-free contract",
      body: "Blueprint export omits credentials and import validation runs a secret scan.",
    },
  ];
}
