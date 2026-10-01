import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CapabilityScopeKind,
  CapabilityResourceType,
  CapabilityScopeView,
  CapabilityScopeSelectionReview,
} from "@goatcitadel/contracts";
import {
  fetchCitadelCapabilities,
  fetchWorkspaceCapabilities,
  updateReviewedCapabilities,
  resetReviewedCapabilities,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../library/session-drafts";
import {
  capabilityAssignments,
  capabilitySelection,
  rejectedCapabilityWrite,
  sameCapabilityValue,
  validCapabilityReceipt,
  validCapabilityReview,
  validCapabilityView,
} from "./capability-scope-binding";
import { capabilityScopeAttempt, setCapabilityScopeAttempt, useCapabilityScopeAttempt } from "./capability-scope-state";

export interface CapabilityScopeReview {
  reset: boolean;
  before: CapabilityScopeView & { selectionReview: CapabilityScopeSelectionReview };
  assignments: CapabilityScopeSelectionReview["assignments"];
  generation: number;
}
export interface CapabilityScopeOptions {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
  fetchScope?: (id: string, type: CapabilityResourceType) => Promise<CapabilityScopeView>;
}
export function useCapabilityScope({ scopeKind, scopeId, resourceType, fetchScope }: CapabilityScopeOptions) {
  const installation = getGatewayApiBaseUrl(),
    key = JSON.stringify(["capability-selection", installation, scopeKind, scopeId, resourceType]);
  const live = useRef({ key, binding: {}, mounted: true, epoch: 0, read: 0 });
  if (live.current.key !== key) {
    live.current.key = key;
    live.current.binding = {};
    live.current.epoch++;
    live.current.read++;
  }
  const binding = live.current.binding;
  const [state, setState] = useState<{
    key: string;
    view: CapabilityScopeView | null;
    loading: boolean;
    error: string | null;
  }>({ key, view: null, loading: true, error: null });
  const [review, setReview] = useState<CapabilityScopeReview | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const current = useCallback(
    () =>
      live.current.mounted &&
      live.current.key === key &&
      live.current.binding === binding &&
      getGatewayApiBaseUrl() === installation,
    [binding, installation, key],
  );
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch++;
      owner.read++;
    };
  }, [key]);
  const read = useCallback(async () => {
    const fetchOwner = fetchScope ?? (scopeKind === "citadel" ? fetchCitadelCapabilities : fetchWorkspaceCapabilities);
    const value = await fetchOwner(scopeId, resourceType);
    if (getGatewayApiBaseUrl() !== installation || !validCapabilityView(value, scopeKind, scopeId, resourceType))
      throw new Error("The scope owner returned a different or unavailable selection.");
    return value;
  }, [fetchScope, installation, resourceType, scopeId, scopeKind]);
  const reload = useCallback(async () => {
    const readId = ++live.current.read;
    live.current.epoch++;
    setReview(null);
    setState((previous) => ({ key, view: previous.key === key ? previous.view : null, loading: true, error: null }));
    try {
      const view = await read();
      if (current() && live.current.read === readId) setState({ key, view, loading: false, error: null });
    } catch {
      if (current() && live.current.read === readId)
        setState({
          key,
          view: null,
          loading: false,
          error: "The capability scope could not be read. Refresh to inspect its current state.",
        });
    }
  }, [current, key, read]);
  useEffect(() => {
    setNotice(null);
    void reload();
  }, [reload]);
  const view = state.key === key ? state.view : null;
  const ownerReview = view?.selectionReview;
  const supported = Boolean(
    view && validCapabilityReview(ownerReview, view) && Object.keys(capabilitySelection(view)).length <= 1000,
  );
  const active = ownerReview?.scopeLifecycleStatus === "active" && ownerReview.citadelLifecycleStatus === "active";
  const attempt = useCapabilityScopeAttempt(key),
    locked = attempt.phase !== "idle";
  const draft = useSessionDraft(key, capabilitySelection(view), ownerReview?.revision, {
    label: `${scopeKind} ${resourceType} selection`,
    available: supported,
  });
  const ready = supported && active && !state.loading && !state.error && !locked && !draft.hasRemoteChanges;
  const renderedGeneration = live.current.epoch;
  function toggle(ref: string) {
    if (!current() || !view || !supported || !Object.hasOwn(draft.value, ref)) return;
    live.current.epoch++;
    setReview(null);
    setNotice(null);
    draft.setValue((previous) => ({ ...previous, [ref]: !previous[ref] }));
  }
  function requestReview(reset = false) {
    if (
      !ready ||
      !view ||
      !validCapabilityReview(ownerReview, view) ||
      !current() ||
      renderedGeneration !== live.current.epoch
    )
      return;
    setNotice(null);
    setReview({
      reset,
      before: structuredClone({ ...view, selectionReview: ownerReview }),
      assignments: reset ? [] : capabilityAssignments(draft.value),
      generation: live.current.epoch,
    });
  }
  function cancelReview() {
    live.current.epoch++;
    setReview(null);
  }
  function discard() {
    live.current.epoch++;
    setReview(null);
    setNotice(null);
    draft.discard();
  }
  async function confirm() {
    if (
      !review ||
      !ready ||
      !current() ||
      review.generation !== live.current.epoch ||
      capabilityScopeAttempt(key).phase !== "idle"
    )
      return false;
    const submitted = structuredClone(draft.value),
      command = structuredClone(review),
      epoch = live.current.epoch,
      readId = live.current.read;
    const viewCurrent = () => current() && live.current.epoch === epoch && live.current.read === readId;
    let dispatched = false;
    setCapabilityScopeAttempt(key, {
      phase: "checking",
      message: "Checking the reviewed selection and Citadel parent…",
    });
    try {
      const fresh = await read();
      if (!viewCurrent()) return false;
      if (!sameCapabilityValue(fresh, command.before)) {
        setState({ key, view: fresh, loading: false, error: null });
        setReview(null);
        setNotice("The scope or its available choices changed. Review the current selection before another attempt.");
        return false;
      }
      setCapabilityScopeAttempt(key, { phase: "saving", message: "Waiting for the Gateway selection owner…" });
      dispatched = true;
      const before = command.before.selectionReview;
      const receipt = command.reset
        ? await resetReviewedCapabilities(scopeKind, scopeId, resourceType, before.revision)
        : await updateReviewedCapabilities(scopeKind, scopeId, {
            resourceType,
            expectedRevision: before.revision,
            assignments: command.assignments,
          });
      if (getGatewayApiBaseUrl() !== installation || !validCapabilityReceipt(receipt, before, command.assignments))
        throw new Error("The scope receipt did not match the reviewed selection.");
      const confirmed = await read();
      if (!sameCapabilityValue(confirmed.selectionReview, receipt.selectionReview))
        throw new Error("Selection readback differs from the receipt.");
      setCapabilityScopeAttempt(key, { phase: "idle" });
      draft.acceptSaved(capabilitySelection(confirmed), receipt.selectionReview.revision, submitted);
      if (!viewCurrent()) return false;
      setState({ key, view: confirmed, loading: false, error: null });
      setReview(null);
      setNotice("Capability selection saved and confirmed. Availability and runtime policy are evaluated separately.");
      return true;
    } catch (error) {
      if (!dispatched || rejectedCapabilityWrite(error, scopeKind, scopeId, command.reset)) {
        setCapabilityScopeAttempt(key, { phase: "idle" });
        if (viewCurrent()) {
          setReview(null);
          setNotice(
            dispatched
              ? "The scope changed before this write. Refresh and review its current selection."
              : "The current selection could not be checked. No change was sent.",
          );
        }
      } else
        setCapabilityScopeAttempt(key, {
          phase: "uncertain",
          message:
            "Capability selection outcome is unconfirmed. Inspect the saved owner; retry is withheld in this app session.",
        });
      return false;
    } finally {
      if (!dispatched) setCapabilityScopeAttempt(key, { phase: "idle" });
    }
  }
  return {
    view,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : null,
    supported,
    active,
    attempt,
    locked,
    ready,
    notice,
    draft,
    review: current() && review?.generation === live.current.epoch ? review : null,
    toggle,
    requestReview,
    cancelReview,
    confirm,
    discard,
    reload,
  };
}
