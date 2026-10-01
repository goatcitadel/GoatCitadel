import { useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import type { CitadelAccessSnapshot, CitadelWardRecord, WardEffect } from "@goatcitadel/contracts";
import {
  addCitadelWard,
  evaluateCitadelGatehouseAction,
  removeCitadelWard,
} from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "../shared/native-helpers";
import { useCitadelAccessReview } from "./useCitadelAccessReview";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { EMPTY_WARD, WARD_EFFECTS, type WardDraft } from "./citadel-ward-model";
import { sameBlueprintValue } from "./citadel-blueprint-binding";

type WardView = "new" | "test" | "rule" | null;
export interface WardReview {
  before: CitadelAccessSnapshot;
  input: WardDraft;
  submitted: WardDraft;
  generation: number;
}
export interface WardDeleteReview {
  ward: CitadelWardRecord;
  revision: string;
  before: CitadelAccessSnapshot;
  generation: number;
}
export function useCitadelWards(citadelId: string) {
  const access = useCitadelAccessReview(citadelId),
    leave = useDraftLeave();
  const [view, setStoredView] = useState<WardView>(null),
    [selectedWardId, setSelectedWardId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null),
    [pendingAddWard, setAddReview] = useState<WardReview | null>(null),
    [pendingDeleteWard, setDeleteReview] = useState<WardDeleteReview | null>(null);
  const [probe, setStoredProbe] = useState(""),
    [probeResult, setProbeResult] = useState<{ action: string; effect: WardEffect } | null>(null),
    [probeError, setProbeError] = useState<string | null>(null),
    [probeBusy, setProbeBusy] = useState(false);
  const live = useRef({ key: access.key, generation: 0, probe: 0, mounted: true, activeProbe: null as object | null });
  if (live.current.key !== access.key) {
    live.current.key = access.key;
    live.current.generation += 1;
    live.current.probe += 1;
    live.current.activeProbe = null;
  }
  const addRef = useRef<WardReview | null>(null),
    deleteRef = useRef<WardDeleteReview | null>(null);
  const wardDraft = useSessionDraft(`ward:${access.key}:new`, EMPTY_WARD, access.snapshot?.revision, {
    label: "New Ward",
    available: Boolean(access.snapshot),
    active: view === "new",
  });
  const draft = wardDraft.value,
    wards = { loading: access.loading, error: access.error, items: access.snapshot?.wards ?? [] };
  const selectedWard = wards.items.find((item) => item.wardId === selectedWardId) ?? null;
  const current = (generation: number) =>
    live.current.mounted &&
    live.current.key === access.key &&
    live.current.generation === generation &&
    access.isCurrent();
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    addRef.current = null;
    deleteRef.current = null;
    setStoredView(null);
    setSelectedWardId(null);
    setDraftError(null);
    setAddReview(null);
    setDeleteReview(null);
    setStoredProbe("");
    setProbeResult(null);
    setProbeError(null);
    setProbeBusy(false);
    return () => {
      owner.mounted = false;
      owner.generation += 1;
      owner.probe += 1;
      owner.activeProbe = null;
    };
  }, [access.key]);
  function invalidate() {
    live.current.generation += 1;
    addRef.current = null;
    deleteRef.current = null;
    setAddReview(null);
    setDeleteReview(null);
  }
  function setView(next: WardView) {
    invalidate();
    live.current.probe += 1;
    setProbeResult(null);
    setProbeError(null);
    setStoredView(next);
  }
  function setDraft(value: SetStateAction<WardDraft>) {
    invalidate();
    setDraftError(null);
    wardDraft.setValue(value);
  }
  function requestAddWard() {
    if (
      !access.ready ||
      !access.snapshot ||
      wardDraft.hasRemoteChanges ||
      wardDraft.baseRevision !== access.snapshot.revision ||
      !draft.name.trim() ||
      !draft.actionPattern.trim()
    )
      return false;
    const review: WardReview = {
      before: structuredClone(access.snapshot),
      input: { name: draft.name.trim(), actionPattern: draft.actionPattern.trim(), effect: draft.effect },
      submitted: structuredClone(draft),
      generation: live.current.generation,
    };
    addRef.current = review;
    setAddReview(review);
    return true;
  }
  async function addWard() {
    const review = addRef.current;
    if (!review || !current(review.generation)) return false;
    if (!sameBlueprintValue(review.before, access.snapshot)) {
      invalidate();
      setDraftError("The access review changed. Review the current rules before adding this Ward.");
      return false;
    }
    let clean = false;
    const saved = await access.run(
      review.before.revision,
      () => addCitadelWard(citadelId, { ...review.input, expectedRevision: review.before.revision }),
      {
        change: { type: "add_ward", ward: review.input },
        isReviewCurrent: () => addRef.current === review && current(review.generation),
        onConfirmed: (record) => {
          clean = wardDraft.acceptSaved(EMPTY_WARD, record.revision, review.submitted);
        },
      },
    );
    if (!saved) {
      if (current(review.generation)) {
        addRef.current = null;
        setAddReview(null);
      }
      return false;
    }
    if (current(review.generation)) {
      setSelectedWardId(
        saved.wards.find((item) => !review.before.wards.some((before) => before.wardId === item.wardId))?.wardId ??
          null,
      );
      if (addRef.current === review) {
        addRef.current = null;
        setAddReview(null);
      }
      if (clean && current(review.generation)) setStoredView("rule");
    }
    return clean;
  }
  function setPendingDeleteWard(value: { ward: CitadelWardRecord; revision: string } | null) {
    invalidate();
    if (
      !value ||
      !access.ready ||
      !access.snapshot ||
      value.ward.citadelId !== citadelId ||
      value.revision !== access.snapshot.revision
    )
      return;
    const review = {
      ...structuredClone(value),
      before: structuredClone(access.snapshot),
      generation: live.current.generation,
    };
    deleteRef.current = review;
    setDeleteReview(review);
  }
  async function deleteWard() {
    const review = deleteRef.current;
    if (!review || !current(review.generation)) return;
    if (!sameBlueprintValue(review.before, access.snapshot)) {
      invalidate();
      setDraftError("The access review changed. Review the current Ward before deleting it.");
      return;
    }
    const saved = await access.run(
      review.revision,
      () => removeCitadelWard(citadelId, review.ward.wardId, review.revision),
      {
        change: { type: "remove_ward", wardId: review.ward.wardId },
        isReviewCurrent: () => deleteRef.current === review && current(review.generation),
      },
    );
    if (!current(review.generation)) return;
    deleteRef.current = null;
    setDeleteReview(null);
    if (saved) {
      setSelectedWardId(null);
      setStoredView(null);
    }
  }
  function setProbe(value: string) {
    live.current.probe += 1;
    setStoredProbe(value);
    setProbeResult(null);
    setProbeError(null);
  }
  async function evaluate() {
    const action = probe.trim();
    if (!action || live.current.activeProbe || !access.isCurrent()) return;
    const id = ++live.current.probe,
      admission = {};
    live.current.activeProbe = admission;
    setProbeBusy(true);
    setProbeError(null);
    setProbeResult(null);
    const isCurrent = () =>
      access.isCurrent() && live.current.mounted && live.current.key === access.key && live.current.probe === id;
    try {
      const result = await evaluateCitadelGatehouseAction(citadelId, action);
      if (!isCurrent()) return;
      if (result?.action !== action || !WARD_EFFECTS.includes(result.effect as WardEffect))
        throw new Error("The evaluation owner returned a different or unavailable action.");
      setProbeResult({ action, effect: result.effect as WardEffect });
    } catch (error) {
      if (isCurrent()) setProbeError(getErrorMessage(error));
    } finally {
      if (live.current.activeProbe === admission) {
        live.current.activeProbe = null;
        if (access.isCurrent()) setProbeBusy(false);
      }
    }
  }
  return {
    access,
    leave,
    wards,
    wardDraft,
    draft,
    setDraft,
    view,
    setView,
    selectedWard,
    setSelectedWardId,
    draftError,
    pendingAddWard,
    requestAddWard,
    addWard,
    cancelAddReview: () => {
      invalidate();
    },
    pendingDeleteWard,
    setPendingDeleteWard,
    deleteWard,
    probe,
    setProbe,
    probeResult,
    probeError,
    probeBusy,
    evaluate,
  };
}
