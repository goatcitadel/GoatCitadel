import { useCallback, useEffect, useId, useState } from "react";
import { Check, Download, Upload, X } from "lucide-react";
import type { CitadelBlueprint, CitadelBlueprintValidationResult } from "@goatcitadel/contracts";
import {
  exportCitadelBlueprint,
  importCitadelBlueprint,
  isApiRequestError,
  validateCitadelBlueprint,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
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
export function CitadelBlueprintRoutePage({ route, activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const importId = useId();
  const [exportState, setExportState] = useState<ExportState>({ loading: true, error: null, staged: false, json: null });
  const [importText, setImportText] = useState("");
  const [importState, setImportState] = useState<ImportState>(INITIAL_IMPORT);

  useEffect(() => {
    let cancelled = false;
    setExportState((current) => ({ ...current, loading: true, error: null }));
    void exportCitadelBlueprint(activeWorkspaceId)
      .then((blueprint) => {
        if (!cancelled) {
          setExportState({ loading: false, error: null, staged: true, json: JSON.stringify(blueprint, null, 2) });
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
  }, [activeWorkspaceId]);

  const validate = useCallback(async () => {
    const parsed = parseBlueprint(importText);
    if ("parseError" in parsed) {
      setImportState({ ...INITIAL_IMPORT, validation: { ok: false, errors: [`Invalid JSON: ${parsed.parseError}`] } });
      return;
    }
    try {
      const validation = await validateCitadelBlueprint(parsed.blueprint);
      setImportState({ ...INITIAL_IMPORT, validation });
    } catch (error) {
      setImportState({ ...INITIAL_IMPORT, error: getErrorMessage(error) });
    }
  }, [importText]);

  const applyImport = useCallback(async () => {
    const parsed = parseBlueprint(importText);
    if ("parseError" in parsed) {
      return;
    }
    setImportState((current) => ({ ...current, busy: true, error: null }));
    try {
      await importCitadelBlueprint(activeWorkspaceId, parsed.blueprint as CitadelBlueprint);
      setImportState((current) => ({ ...current, busy: false, done: true }));
    } catch (error) {
      setImportState((current) => ({ ...current, busy: false, error: getErrorMessage(error) }));
    }
  }, [activeWorkspaceId, importText]);

  const canApply = importState.validation?.ok === true && !importState.busy;

  return (
    <NativePageFrame
      icon={Download}
      area="library"
      kicker={routeKicker(route)}
      title="Blueprint"
      description={`Export ${activeWorkspaceName} as a portable, secret-free Blueprint, or import one. Imports are validated and secret-scanned before they apply.`}
      loading={exportState.loading}
      error={exportState.error}    >
      <NativeGrid>
        <NativeCard
          title="Export"
          subtitle="The current Citadel as a Blueprint. Secrets are never included."
        >
          {exportState.staged && exportState.json ? (
            <pre className="mc-next-blueprint-json" aria-label="Exported Blueprint">
              {exportState.json}
            </pre>
          ) : (
            <EmptyState size="compact" title={`${activeWorkspaceName} isn't a Citadel yet — nothing to export.`} />
          )}
        </NativeCard>

        <NativeCard
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
                setImportText(event.target.value);
                setImportState(INITIAL_IMPORT);
              }}
            />
          </label>
          <div className="mc-next-blueprint-actions">
            <NativeButton
              variant="default"
              disabled={importText.trim().length === 0}
              onClick={() => void validate()}
            >
              <Check className="h-4 w-4" />
              Validate
            </NativeButton>
            <NativeButton
              variant="outline"
              disabled={!canApply}
              onClick={() => void applyImport()}
            >
              <Upload className="h-4 w-4" />
              {importState.busy ? "Importing…" : "Import"}
            </NativeButton>
          </div>

          {importState.error ? <p className="mc-next-mason-error">{importState.error}</p> : null}
          {importState.done ? <p className="mc-next-blueprint-ok">Blueprint imported.</p> : null}
          {importState.validation ? (
            importState.validation.ok ? (
              <p className="mc-next-blueprint-ok">
                <Check className="h-4 w-4" aria-hidden="true" />
                Valid — safe to import.
              </p>
            ) : (
              <div className="mc-next-blueprint-errors">
                <p>
                  <X className="h-4 w-4" aria-hidden="true" />
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
        </NativeCard>
      </NativeGrid>
    </NativePageFrame>
  );
}
