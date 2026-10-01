import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Citadel, CitadelGatehouseSummary, CitadelStructureSnapshot, CitadelTemplateSnapshot } from "@goatcitadel/contracts";
import { createCitadelFromTemplate, getCitadelGatehouse, getCitadelStructureSnapshot, listCitadelTemplates, upsertCitadelCharter } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { hasCitadelRecord, type DirectoryLifecycleReview } from "../settings/directory-lifecycle-binding";
import { useDirectoryLifecycle } from "../settings/use-directory-lifecycle";
import { getErrorMessage } from "../shared/native-helpers";
import { sameBlueprintValue } from "./citadel-blueprint-binding";
import { hasOverviewStructure, isOverviewPrewriteConflict, overviewReceiptMatches, validCitadelTemplate, type CitadelOverviewReview } from "./citadel-overview-binding";
import { citadelStructureAttempt, citadelStructureKey, citadelStructureLocked, setCitadelStructureAttempt, subscribeCitadelStructureAttempts } from "./citadel-structure-state";

type Gatehouse = CitadelGatehouseSummary & { wardCount: number };
interface OverviewState { key: string; loading: boolean; error: string | null; snapshot: CitadelStructureSnapshot | null; gatehouse: Gatehouse | null }
interface TemplateState { loading: boolean; error: string | null; items: CitadelTemplateSnapshot[] }
export function useCitadelOverview(citadelId: string, navigationKey = "") {
  const installation = getGatewayApiBaseUrl(), key = citadelStructureKey(citadelId, installation);
  const attempt = useSyncExternalStore(subscribeCitadelStructureAttempts, () => citadelStructureAttempt(citadelId, installation), () => citadelStructureAttempt(citadelId, installation));
  const [storedState, setState] = useState<OverviewState>({ key, loading: true, error: null, snapshot: null, gatehouse: null });
  const state: OverviewState = storedState.key === key ? storedState : { key, loading: true, error: null, snapshot: null, gatehouse: null };
  const [templateState, setTemplateState] = useState<TemplateState>({ loading: true, error: null, items: [] });
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<CitadelOverviewReview | null>(null);
  const reviewRef = useRef<CitadelOverviewReview | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; message: string } | null>(null);
  const live = useRef({ key, navigationKey, mounted: true, generation: 0, read: 0 });
  if (live.current.key !== key) { live.current.key = key; live.current.generation += 1; live.current.read += 1; reviewRef.current = null; }
  if (live.current.navigationKey !== navigationKey) { live.current.navigationKey = navigationKey; live.current.generation += 1; reviewRef.current = null; }
  const current = (generation: number) => live.current.mounted && live.current.key === key && live.current.generation === generation && getGatewayApiBaseUrl() === installation;
  const locked = attempt.phase !== "idle";
  const pending = attempt.phase === "checking" || attempt.phase === "saving";
  const ownerLocked = () => citadelStructureLocked(citadelId, installation);
  const setAttempt = (value: Parameters<typeof setCitadelStructureAttempt>[1]) => setCitadelStructureAttempt(citadelId, value, installation);
  const citadel: Citadel | null = state.snapshot?.charter ? { citadelId, record: state.snapshot.record, charter: state.snapshot.charter, chambers: state.snapshot.chambers } : null;
  const leave = useDraftLeave();
  const charterDraft = useSessionDraft(`charter:${key}:purpose`, citadel?.charter.purpose ?? "", state.snapshot?.revision,
    { label: "Charter purpose", active: editing, available: Boolean(citadel) && !state.error });
  const lifecycleTarget: DirectoryLifecycleReview | null = state.snapshot && hasCitadelRecord(state.snapshot.record)
    ? { kind: "citadel", record: state.snapshot.record, action: state.snapshot.record.lifecycleStatus === "active" ? "archive" : "restore" } : null;
  const lifecycle = useDirectoryLifecycle({ ownerKey: citadelId, available: Boolean(lifecycleTarget) && !state.loading && !state.error && !locked, reload });
  const lifecycleLocked = Boolean(lifecycleTarget && lifecycle.locked(lifecycleTarget));
  const lifecycleMessage = lifecycleTarget ? lifecycle.attempt(lifecycleTarget).message : undefined;

  useLayoutEffect(() => {
    const owner = live.current; owner.mounted = true;
    setEditing(false); setReview(null); reviewRef.current = null; setNotice(null);
    return () => { owner.mounted = false; owner.generation += 1; owner.read += 1; };
  }, [key]);
  useLayoutEffect(() => { reviewRef.current = null; setReview(null); }, [navigationKey]);
  useEffect(() => { void reload(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    setTemplateState({ loading: true, error: null, items: [] });
    void listCitadelTemplates().then(items => {
      if (cancelled || getGatewayApiBaseUrl() !== installation) return;
      if (!Array.isArray(items) || items.some(item => !validCitadelTemplate(item)) || new Set(items.map(item => item.id)).size !== items.length) throw new Error("Template owner evidence is unavailable.");
      setTemplateState({ loading: false, error: null, items });
    }).catch(error => { if (!cancelled && getGatewayApiBaseUrl() === installation) setTemplateState({ loading: false, error: getErrorMessage(error), items: [] }); });
    return () => { cancelled = true; };
  }, [installation]);

  async function reload() {
    const read = ++live.current.read;
    const isCurrent = () => live.current.mounted && live.current.key === key && live.current.read === read && getGatewayApiBaseUrl() === installation;
    setState(value => value.key === key ? { ...value, loading: true, error: null } : { key, loading: true, error: null, snapshot: null, gatehouse: null });
    try {
      const snapshot = await getCitadelStructureSnapshot(citadelId);
      if (!isCurrent()) return;
      if (!hasOverviewStructure(snapshot, citadelId)) throw new Error("The structure owner returned a different or unavailable Citadel.");
      setState({ key, loading: false, error: null, snapshot, gatehouse: null });
      if (!snapshot.charter) return;
      try {
        const gatehouse = await getCitadelGatehouse(citadelId);
        if (!isCurrent()) return;
        if (gatehouse?.citadelId !== citadelId) throw new Error("The Gatehouse owner returned a different Citadel.");
        setState(value => ({ ...value, gatehouse }));
      } catch (error) { if (isCurrent()) setNotice({ tone: "warning", message: `Charter loaded. Gatehouse summary unavailable: ${getErrorMessage(error)}` }); }
    } catch (error) { if (isCurrent()) setState({ key, loading: false, error: getErrorMessage(error), snapshot: null, gatehouse: null }); }
  }
  function invalidateReview() { live.current.generation += 1; reviewRef.current = null; setReview(null); }
  function changePurpose(value: string) { if (!ownerLocked()) { invalidateReview(); charterDraft.setValue(value); } }
  function openEditor() { if (citadel && !pending) { if (!ownerLocked()) invalidateReview(); setEditing(true); } }
  function closeEditor() { if (!pending) leave.request(() => { invalidateReview(); setEditing(false); }, [charterDraft.key]); }
  function requestCharter() {
    if (!citadel || !state.snapshot || ownerLocked() || lifecycleLocked || charterDraft.hasRemoteChanges || !charterDraft.value.trim() || state.snapshot.record?.lifecycleStatus === "archived" || charterDraft.baseRevision !== state.snapshot.revision) return;
    const charter = citadel.charter;
    const next: CitadelOverviewReview = { kind: "charter", before: structuredClone(state.snapshot), input: {
      purpose: charterDraft.value.trim(), kind: charter.kind, goals: charter.goals, boundaries: charter.boundaries, successDefinition: charter.successDefinition,
      defaultChamberId: charter.defaultChamberId, riskPosture: charter.riskPosture, modelPolicyDefault: charter.modelPolicyDefault,
    }, submittedPurpose: charterDraft.value, generation: live.current.generation };
    reviewRef.current = next; setReview(next); setNotice(null);
  }
  function requestTemplate(template: CitadelTemplateSnapshot) {
    if (!state.snapshot || citadel || ownerLocked() || lifecycleLocked || state.loading || state.error || state.snapshot.record?.lifecycleStatus === "archived" || !validCitadelTemplate(template)
      || !templateState.items.some(item => item.id === template.id && sameBlueprintValue(item, template))) return;
    const next: CitadelOverviewReview = { kind: "template", before: structuredClone(state.snapshot), template: structuredClone(template), generation: live.current.generation };
    reviewRef.current = next; setReview(next); setNotice(null);
  }
  function cancelReview() { if (!pending) { reviewRef.current = null; setReview(null); } }
  async function confirm(): Promise<boolean> {
    const submitted = reviewRef.current;
    if (!submitted || ownerLocked() || !current(submitted.generation) || lifecycleLocked) return false;
    const action = submitted.kind === "charter" ? "Charter save" : "template application";
    setAttempt({ phase: "checking", message: `Checking the reviewed ${action}…` });
    let dispatched = false;
    try {
      const before = await getCitadelStructureSnapshot(citadelId);
      if (!current(submitted.generation)) return false;
      if (!hasOverviewStructure(before, citadelId) || !sameBlueprintValue(before, submitted.before)) throw new Error("The Citadel changed. Your draft is preserved; review the current Charter and Chambers again.");
      if (submitted.kind === "template") {
        const templates = await listCitadelTemplates();
        if (!current(submitted.generation)) return false;
        if (!Array.isArray(templates) || templates.some(item => !validCitadelTemplate(item)) || new Set(templates.map(item => item.id)).size !== templates.length) throw new Error("Template owner evidence is unavailable.");
        const matches = templates.filter(item => item.id === submitted.template.id);
        if (matches.length !== 1 || !sameBlueprintValue(matches[0], submitted.template)) {
          setTemplateState({ loading: false, error: null, items: templates });
          throw new Error("The template changed. Review its current contents before applying it.");
        }
      }
      if (!current(submitted.generation)) return false;
      setAttempt({ phase: "saving", message: `Waiting for the Gateway ${action} owner…` }); dispatched = true;
      const receipt = submitted.kind === "charter"
        ? await upsertCitadelCharter(citadelId, { ...submitted.input, expectedRevision: submitted.before.revision })
        : await createCitadelFromTemplate(citadelId, submitted.template.id, submitted.before.revision, submitted.template.revision);
      if (getGatewayApiBaseUrl() !== installation || !overviewReceiptMatches(submitted, receipt)) throw new Error("The structure owner did not acknowledge the reviewed change.");
      const after = await getCitadelStructureSnapshot(citadelId);
      if (getGatewayApiBaseUrl() !== installation || !hasOverviewStructure(after, citadelId) || !sameBlueprintValue(after, receipt)) throw new Error("The saved structure could not be independently confirmed.");
      setAttempt({ phase: "idle" });
      const clean = submitted.kind === "charter" ? charterDraft.acceptSaved(receipt.charter!.purpose, receipt.revision, submitted.submittedPurpose) : true;
      if (current(submitted.generation)) {
        setState({ key, loading: false, error: null, snapshot: receipt, gatehouse: null });
        reviewRef.current = null; setReview(null); if (clean) setEditing(false);
        setNotice({ tone: "success", message: submitted.kind === "charter" ? "Citadel Charter saved and confirmed." : "Citadel template applied and confirmed." });
        void reload();
      }
      return clean;
    } catch (error) {
      if (!dispatched || isOverviewPrewriteConflict(error)) {
        setAttempt({ phase: "idle" });
        if (current(submitted.generation)) { reviewRef.current = null; setReview(null); setNotice({ tone: "warning", message: getErrorMessage(error) }); void reload(); }
      } else {
        setAttempt({ phase: "uncertain", message: "Citadel structure outcome is unconfirmed. Inspect the Citadel before any further structure change; retry is withheld in this app session." });
        if (current(submitted.generation)) { reviewRef.current = null; setReview(null); }
      }
      return false;
    } finally { if (!dispatched) setAttempt({ phase: "idle" }); }
  }
  return { state: { ...state, staged: Boolean(citadel), citadel }, templateState: { ...templateState, busyTemplateId: pending && review?.kind === "template" ? review.template.id : null }, defaultTemplates: (["personal", "company"] as const).flatMap(kind => {
    const template = templateState.items.find(item => item.kind === kind); return template ? [template] : [];
  }), charterDraft, editing, openEditor, closeEditor, setEditing, leave, notice, attempt, locked, pending, review,
    requestCharter, requestTemplate, cancelReview, confirm, changePurpose, reload, lifecycle, lifecycleTarget, lifecycleLocked, lifecycleMessage, invalidateReview };
}
