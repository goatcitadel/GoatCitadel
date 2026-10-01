import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CitadelBlueprint, CitadelBlueprintValidationResult, CitadelStructureSnapshot } from "@goatcitadel/contracts";
import { exportCitadelBlueprint, getCitadelStructureSnapshot, importCitadelBlueprint, isApiRequestError, listCitadels, validateCitadelBlueprint } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { blueprintImportMatches, hasBlueprintStructure, isBlueprintPrewriteConflict, sameBlueprintValue } from "./citadel-blueprint-binding";
import { blueprintAttempt, blueprintLocked, setBlueprintAttempt, subscribeBlueprintAttempts } from "./citadel-blueprint-state";
import { getErrorMessage } from "../shared/native-helpers";

interface ExportState { loading: boolean; error: string | null; staged: boolean; json: string | null }
interface ImportState { validation: CitadelBlueprintValidationResult | null; busy: boolean; done: boolean; error: string | null }
const INITIAL_IMPORT: ImportState = { validation: null, busy: false, done: false, error: null };
export function parseBlueprint(text: string): { blueprint: unknown } | { parseError: string } {
  try { return { blueprint: JSON.parse(text) }; } catch { return { parseError: "Blueprint must be valid JSON." }; }
}

/** One revision-bound import lifecycle and retained admission owner for both shells. */
export function useCitadelBlueprint(activeCitadelId: string) {
  const installation = getGatewayApiBaseUrl();
  const attempt = useSyncExternalStore(subscribeBlueprintAttempts, () => blueprintAttempt(activeCitadelId, installation), () => blueprintAttempt(activeCitadelId, installation));
  const [exportState, setExportState] = useState<ExportState>({ loading: true, error: null, staged: false, json: null });
  const [view, setViewState] = useState<"export" | "import">("export");
  const [confirmImport, setConfirmImportState] = useState(false);
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const [reviewedTarget, setReviewedTarget] = useState<CitadelStructureSnapshot | null>(null);
  const [importState, setImportState] = useState<ImportState>(INITIAL_IMPORT);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportGeneration, setExportGeneration] = useState(0);
  const scopeKey = JSON.stringify([installation, activeCitadelId]);
  const live = useRef({ scope: scopeKey, mounted: true, generation: 0 });
  const validated = useRef<{ text: string; target: CitadelStructureSnapshot; generation: number } | null>(null);
  const confirmation = useRef<typeof validated.current>(null);
  if (live.current.scope !== scopeKey) { live.current.scope = scopeKey; live.current.generation += 1; }
  useLayoutEffect(() => {
    const owner = live.current; owner.mounted = true;
    validated.current = null; confirmation.current = null;
    setValidatedText(null); setReviewedTarget(null); setConfirmImportState(false); setImportState(INITIAL_IMPORT); setExportNotice(null);
    return () => { owner.mounted = false; owner.generation += 1; };
  }, [scopeKey]);
  const leave = useDraftLeave();
  const blueprintDraft = useSessionDraft(`blueprint-import:${scopeKey}`, "", undefined, { label: "Blueprint import", active: view === "import" });
  const importText = blueprintDraft.value;
  const locked = attempt.phase !== "idle";
  const currentAt = (generation: number) => live.current.mounted && live.current.scope === scopeKey && live.current.generation === generation && getGatewayApiBaseUrl() === installation;
  const ownerLocked = () => blueprintLocked(activeCitadelId, installation);
  const setAttempt = (value: Parameters<typeof setBlueprintAttempt>[1]) => setBlueprintAttempt(activeCitadelId, value, installation);

  useEffect(() => {
    let cancelled = false;
    const scope = live.current.scope;
    setExportState({ loading: true, error: null, staged: false, json: null });
    void listCitadels("active", 500).then(async ({ items }) => {
      if (getGatewayApiBaseUrl() !== installation) throw new Error("The Gateway installation changed.");
      const matches = items.filter(item => item.citadelId === activeCitadelId);
      if (matches.length !== 1) throw new Error("Citadel directory evidence is unavailable for this export.");
      if (matches[0]?.hasCharter === false) return null;
      return exportCitadelBlueprint(activeCitadelId);
    }).then(blueprint => {
      if (!cancelled && live.current.scope === scope && getGatewayApiBaseUrl() === installation) setExportState({ loading: false, error: null, staged: Boolean(blueprint), json: blueprint ? JSON.stringify(blueprint, null, 2) : null });
    }).catch((error: unknown) => {
      if (!cancelled && live.current.scope === scope && getGatewayApiBaseUrl() === installation) setExportState({ loading: false, error: isApiRequestError(error) && error.status === 404 ? null : getErrorMessage(error), staged: false, json: null });
    });
    return () => { cancelled = true; };
  }, [activeCitadelId, installation, exportGeneration]);

  function invalidateReview() {
    live.current.generation += 1; validated.current = null; confirmation.current = null;
    setValidatedText(null); setReviewedTarget(null); setConfirmImportState(false); setImportState(INITIAL_IMPORT);
  }
  function changeText(text: string) { if (!locked) { invalidateReview(); blueprintDraft.setValue(text); } }
  function setView(next: "export" | "import") {
    if (next !== view) { invalidateReview(); setViewState(next); }
  }
  async function loadFile(file: Pick<File, "size" | "text">) {
    if (ownerLocked()) return;
    invalidateReview(); const generation = live.current.generation;
    if (file.size > 1_048_576) { setImportState({ ...INITIAL_IMPORT, error: "Choose a Blueprint file up to 1 MiB." }); return; }
    setImportState({ ...INITIAL_IMPORT, busy: true });
    try {
      const text = await file.text();
      if (currentAt(generation) && !ownerLocked()) { blueprintDraft.setValue(text); setView("import"); setImportState(INITIAL_IMPORT); }
    } catch { if (currentAt(generation)) setImportState({ ...INITIAL_IMPORT, error: "The Blueprint file could not be read." }); }
  }
  async function validate() {
    if (ownerLocked()) return;
    invalidateReview(); const generation = live.current.generation, submitted = importText;
    const parsed = parseBlueprint(submitted);
    if ("parseError" in parsed) { setImportState({ ...INITIAL_IMPORT, validation: { ok: false, errors: [parsed.parseError] } }); return; }
    setImportState({ ...INITIAL_IMPORT, busy: true });
    try {
      const validation = await validateCitadelBlueprint(parsed.blueprint);
      if (!currentAt(generation)) return;
      if (typeof validation?.ok !== "boolean" || !Array.isArray(validation.errors)) throw new Error("Blueprint validation evidence is unavailable.");
      const target = validation.ok ? await getCitadelStructureSnapshot(activeCitadelId) : null;
      if (!currentAt(generation)) return;
      if (target && !hasBlueprintStructure(target, activeCitadelId)) throw new Error("The reviewed structure does not belong to this Citadel.");
      if (target) { validated.current = { text: submitted, target: structuredClone(target), generation }; setValidatedText(submitted); setReviewedTarget(structuredClone(target)); }
      setImportState({ ...INITIAL_IMPORT, validation });
    } catch (error) { if (currentAt(generation)) setImportState({ ...INITIAL_IMPORT, error: getErrorMessage(error) }); }
  }
  const canApply = !locked && validatedText === importText && reviewedTarget?.citadelId === activeCitadelId
    && reviewedTarget.record?.lifecycleStatus !== "archived" && importState.validation?.ok === true && !importState.busy;
  function setConfirmImport(open: boolean) {
    if (ownerLocked()) return;
    if (open && (!canApply || !validated.current || !currentAt(validated.current.generation))) return;
    confirmation.current = open ? structuredClone(validated.current) : null;
    setConfirmImportState(open);
  }
  async function applyImport(): Promise<boolean> {
    const review = confirmation.current;
    if (!canApply || !confirmImport || !review || review.text !== importText || !currentAt(review.generation) || ownerLocked()) return false;
    const before = structuredClone(review.target), submitted = review.text, generation = review.generation;
    const parsed = parseBlueprint(submitted); if ("parseError" in parsed) return false;
    setAttempt({ phase: "checking", message: "Checking the reviewed Charter and Chambers…" });
    let dispatched = false, confirmed = false;
    try {
      const owner = await getCitadelStructureSnapshot(activeCitadelId);
      if (!currentAt(generation)) return false;
      if (!hasBlueprintStructure(owner, activeCitadelId) || !sameBlueprintValue(owner, before)) {
        invalidateReview(); setImportState({ ...INITIAL_IMPORT, error: "The Citadel changed. Your Blueprint is preserved. Validate again to review the current Charter and Chambers before importing." }); return false;
      }
      setAttempt({ phase: "saving", message: "Waiting for the Gateway Blueprint owner…" }); dispatched = true;
      const receipt = await importCitadelBlueprint(activeCitadelId, parsed.blueprint as CitadelBlueprint, before.revision);
      if (getGatewayApiBaseUrl() !== installation) throw new Error("The Gateway installation changed after import dispatch.");
      if (!blueprintImportMatches(before, parsed.blueprint as CitadelBlueprint, receipt)) throw new Error("The Blueprint owner did not acknowledge the reviewed import.");
      const after = await getCitadelStructureSnapshot(activeCitadelId);
      if (getGatewayApiBaseUrl() !== installation) throw new Error("The Gateway installation changed during import readback.");
      if (!hasBlueprintStructure(after, activeCitadelId) || !sameBlueprintValue(after, receipt)) throw new Error("The imported structure could not be independently confirmed.");
      confirmed = true; setAttempt({ phase: "idle" });
      const clean = blueprintDraft.acceptSaved("", undefined, submitted);
      if (currentAt(generation)) {
        validated.current = null; confirmation.current = null;
        setValidatedText(null); setReviewedTarget(null); setConfirmImportState(false); setImportState({ ...INITIAL_IMPORT, done: true }); setExportGeneration(value => value + 1);
      }
      return clean;
    } catch (error) {
      if (!dispatched || isBlueprintPrewriteConflict(error)) {
        setAttempt({ phase: "idle" });
        if (currentAt(generation)) { invalidateReview(); setImportState({ ...INITIAL_IMPORT, error: "The import was not confirmed. Validate again against the current Citadel before retrying." }); }
      } else {
        setAttempt({ phase: "uncertain", message: "Citadel structure outcome is unconfirmed. Inspect the Citadel before any further structure change; retry is withheld in this app session." });
        if (currentAt(generation)) { confirmation.current = null; setConfirmImportState(false); }
      }
      return false;
    } finally { if (!dispatched && !confirmed) setAttempt({ phase: "idle" }); }
  }
  function loadExportForImport() {
    const exported = exportState.json; if (!exported || locked) return;
    if (blueprintDraft.isDirty && importText !== exported) {
      setView("import"); setImportState({ ...INITIAL_IMPORT, error: "Your current import draft is preserved. Discard it before loading the export." }); return;
    }
    const generation = live.current.generation;
    leave.request(() => { if (currentAt(generation) && !ownerLocked()) { changeText(exported); setView("import"); } }, [blueprintDraft.key]);
  }
  return { exportState, view, setView, confirmImport, setConfirmImport, importState: { ...importState, busy: importState.busy || ["checking", "saving"].includes(attempt.phase) },
    reviewedTarget, validatedText, importText, blueprintDraft, leave, attempt, locked, canApply, validate, applyImport, changeText, loadExportForImport,
    exportNotice, setExportNotice, loadFile, refreshExport: () => setExportGeneration(value => value + 1) };
}
