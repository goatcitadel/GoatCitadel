import { useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString, type OnboardingState } from "@goatcitadel/contracts";
import {
  bootstrapOnboarding,
  fetchOnboardingState,
  fetchSettings,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../library/session-drafts";
import { getOnboardingAttempt, setOnboardingAttempt, useOnboardingAttempt } from "./onboarding-completion-state";
import { isManagedRuntimeRevisionConflict } from "./managed-runtime-state";
import {
  defaultsOwnerBinding,
  defaultsReceiptMatches,
  onboardingDefaultsDraft,
  onboardingDefaultsInput,
  type OnboardingDefaultsDraft,
} from "./onboarding-defaults-binding";

export function useOnboardingDefaults(options: {
  state?: OnboardingState;
  runtime?: RuntimeSettingsResponse;
  workspaceId: string;
  active: boolean;
  onSettled: () => Promise<unknown>;
}) {
  const base = getGatewayApiBaseUrl(),
    key = `onboarding-defaults:${base}`;
  const attempt = useOnboardingAttempt(key);
  const draft = useSessionDraft(
    `onboarding:${options.workspaceId}:defaults`,
    onboardingDefaultsDraft(options.state),
    options.runtime?.revision,
    { label: "First-run defaults", active: options.active, available: Boolean(options.state && options.runtime) },
  );
  const identity = canonicalJsonString([
    base,
    options.workspaceId,
    options.active,
    options.state?.settings,
    options.runtime?.deploymentProfile,
    options.runtime?.revision,
    draft.value,
    draft.baseRevision,
  ]);
  const live = useRef({ identity, generation: 0, mounted: true, lifetime: {} });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation++;
  }
  const generation = live.current.generation;
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    owner.lifetime = {};
    return () => {
      owner.mounted = false;
    };
  }, []);
  const [review, setReview] = useState<{
    generation: number;
    state: OnboardingState;
    binding: string;
    submitted: OnboardingDefaultsDraft;
    revision: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const consumed = useRef(new WeakSet<object>());
  const current = () =>
    live.current.mounted &&
    live.current.generation === generation &&
    live.current.identity === identity &&
    getGatewayApiBaseUrl() === base;
  const invalidate = () => {
    live.current.generation++;
    setReview(null);
    setNotice(null);
  };
  const edit = (value: OnboardingDefaultsDraft) => {
    invalidate();
    draft.setValue(value);
  };
  const restricted = !options.runtime || options.runtime.deploymentProfile === "remote_hardened";
  const restrictionReason = !options.runtime
    ? "Read the current runtime before choosing prompt-skipping defaults."
    : options.runtime.deploymentProfile === "remote_hardened"
      ? "Remote Hardened keeps first-run defaults that skip normal prompts unavailable."
      : undefined;
  const canReview = options.active && options.state && options.runtime && !attempt && !draft.hasRemoteChanges;
  function begin() {
    if (!current() || !canReview || !options.state || !options.runtime) return;
    try {
      if (typeof draft.baseRevision !== "number") throw new Error("Load the current defaults revision.");
      onboardingDefaultsInput(draft.value, draft.baseRevision);
      if (restricted && draft.value.toolApprovalMode === "bypass")
        throw new Error("This deployment keeps prompt-skipping defaults unavailable.");
      if (draft.baseRevision !== options.runtime.revision)
        throw new Error("Adopt the current defaults revision before reviewing the retained draft.");
      setReview({
        generation,
        state: structuredClone(options.state),
        binding: defaultsOwnerBinding(options.state, options.runtime),
        submitted: structuredClone(draft.value),
        revision: draft.baseRevision,
      });
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Defaults could not be reviewed.");
    }
  }
  async function confirm(): Promise<boolean> {
    const origin = review;
    if (
      !origin ||
      consumed.current.has(origin) ||
      origin.generation !== generation ||
      !current() ||
      getOnboardingAttempt(key)
    )
      return false;
    consumed.current.add(origin);
    const lifetime = live.current.lifetime;
    const isCurrent = () => current() && live.current.lifetime === lifetime;
    setOnboardingAttempt(key, { phase: "pending", message: "Checking and applying reviewed defaults…" });
    setReview(null);
    let dispatched = false,
      received = false,
      confirmed = false;
    try {
      const [fresh, runtime] = await Promise.all([
        fetchOnboardingState({ signal: new AbortController().signal }),
        fetchSettings({ signal: new AbortController().signal }),
      ]);
      if (!isCurrent()) return false;
      if (defaultsOwnerBinding(fresh, runtime) !== origin.binding)
        throw new Error("Defaults changed during review. Refresh and review the current revision.");
      const input = onboardingDefaultsInput(origin.submitted, origin.revision);
      dispatched = true;
      const receipt = await bootstrapOnboarding(input);
      received = true;
      if (
        getGatewayApiBaseUrl() !== base ||
        !Number.isFinite(Date.parse(receipt.appliedAt)) ||
        !defaultsReceiptMatches(origin.state, receipt.state, input)
      )
        throw new Error("The defaults receipt did not match the reviewed change.");
      const [saved, savedRuntime] = await Promise.all([
        fetchOnboardingState({ signal: new AbortController().signal }),
        fetchSettings({ signal: new AbortController().signal }),
      ]);
      if (
        getGatewayApiBaseUrl() !== base ||
        !defaultsReceiptMatches(origin.state, saved, input) ||
        defaultsOwnerBinding(saved, savedRuntime) !== defaultsOwnerBinding(receipt.state, savedRuntime) ||
        savedRuntime.deploymentProfile !== runtime.deploymentProfile
      )
        throw new Error("The independent read did not confirm the defaults receipt.");
      confirmed = true;
      draft.acceptSaved(onboardingDefaultsDraft(saved), saved.settings.revision, origin.submitted);
      if (isCurrent())
        setNotice("Gateway confirmed the defaults. Setup completion and model execution remain separate.");
    } catch (error) {
      if (dispatched && !confirmed && (received || !isManagedRuntimeRevisionConflict(error, origin.revision)))
        setOnboardingAttempt(key, {
          phase: "unknown",
          message:
            "Defaults outcome is unconfirmed. Another bootstrap is locked in both shells for this app session. Refresh settings to inspect their recorded state.",
        });
      else if (isCurrent())
        setNotice(
          confirmed
            ? "Defaults were confirmed, but this editor could not refresh."
            : error instanceof Error
              ? error.message
              : "Defaults could not be applied.",
        );
    } finally {
      if (getOnboardingAttempt(key)?.phase === "pending") setOnboardingAttempt(key);
    }
    if (confirmed && isCurrent())
      try {
        await options.onSettled();
      } catch {
        if (isCurrent()) setNotice("Defaults were confirmed, but refresh failed.");
      }
    return confirmed;
  }
  async function refresh() {
    if (!current() || getOnboardingAttempt(key)?.phase === "pending") return;
    invalidate();
    const refreshGeneration = live.current.generation,
      lifetime = live.current.lifetime;
    try {
      await options.onSettled();
    } catch {
      if (
        live.current.mounted &&
        live.current.identity === identity &&
        live.current.generation === refreshGeneration &&
        live.current.lifetime === lifetime &&
        getGatewayApiBaseUrl() === base
      )
        setNotice("Current defaults could not be refreshed.");
    }
  }
  return {
    draft,
    edit,
    begin,
    confirm,
    refresh,
    cancel: invalidate,
    rebase: () => {
      invalidate();
      draft.rebaseToCurrent();
    },
    review: review?.generation === generation ? review : null,
    attempt,
    locked: Boolean(attempt),
    notice,
    restricted,
    restrictionReason,
    canReview: Boolean(canReview),
  };
}
