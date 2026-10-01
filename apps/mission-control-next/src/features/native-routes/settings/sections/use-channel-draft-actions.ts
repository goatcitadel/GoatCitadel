import { useRef } from "react";
import type { ChannelSetupDraft, ChannelSetupValidationResult, ChangePlanRecord } from "@goatcitadel/contracts";
import {
  createChangePlan,
  fetchChannelSetupDraft,
  reviewChannelSetupConnection,
  submitChannelSetupDraftSecrets,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  validateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { formatJson, parseJsonObject } from "../helpers/input-format";
import { describeIntegrationConnectionError } from "./useIntegrationConnectionReview";
import { assertChannelDraft, beginChannelOperation } from "./channel-setup-state";
import type { ChannelSetupState } from "./use-channel-setup-state";

type Operation = NonNullable<ReturnType<typeof beginChannelOperation>>;
function canonical(draft: ChannelSetupDraft) {
  return {
    label: draft.label ?? "",
    enabled: draft.enabled,
    values: draft.draft,
    advancedText: formatJson(draft.draft),
  };
}
function assertCheck(result: ChannelSetupValidationResult, draft: ChannelSetupDraft) {
  if (
    result.draftId !== draft.draftId ||
    !Number.isSafeInteger(result.draftRevision) ||
    result.draftRevision <= draft.revision
  )
    throw new Error("The channel check did not acknowledge the reviewed draft and an advanced revision.");
}

export function useChannelDraftActions(s: ChannelSetupState, onPlanReady: (plan: ChangePlanRecord) => void) {
  const latestInput = useRef(s.channelDraft.value);
  latestInput.current = s.channelDraft.value;
  const currentInput = (input: typeof s.channelDraft.value) =>
    JSON.stringify(input) === JSON.stringify(latestInput.current);
  async function failure(cause: unknown) {
    if (!s.isCurrentDraft()) return;
    s.setValidationResult(null);
    s.setNotice({ tone: "error", message: describeIntegrationConnectionError(cause) });
    await Promise.allSettled([
      s.selectedDraft?.connectionId ? s.connectionReview.refresh() : Promise.resolve(),
      s.selectedDraft
        ? fetchChannelSetupDraft(s.selectedDraft.draftId).then((draft) => {
            assertChannelDraft(draft, s.selectedDraft!);
            if (s.isCurrentDraft()) s.mergeDraft(draft);
          })
        : Promise.resolve(),
    ]);
  }
  async function freshDraft(draft: ChannelSetupDraft, revision: number) {
    const latest = await fetchChannelSetupDraft(draft.draftId);
    assertChannelDraft(latest, draft);
    if (latest.revision !== revision) {
      if (s.isCurrentDraft()) s.mergeDraft(latest);
      throw new Error(
        "This channel draft changed elsewhere. Review its current revision before applying your changes.",
      );
    }
    return latest;
  }
  async function persist(op: Operation, valuesOverride?: Record<string, unknown>) {
    if (!s.selectedDraft || !s.selectedDefinition || s.channelDraft.hasRemoteChanges) return undefined;
    const input = s.channelDraft.value;
    const generation = s.inputEpoch.current;
    const values = valuesOverride ?? (s.advancedMode ? parseJsonObject(input.advancedText) : input.values);
    const submitted = { ...input, values, advancedText: formatJson(values) };
    const draft = await freshDraft(s.selectedDraft, Number(s.channelDraft.baseRevision));
    if (!s.isCurrentDraft() || !currentInput(input) || s.inputEpoch.current !== generation) return undefined;
    if (!s.draftHasChanges(values)) return draft;
    const secrets = new Set(s.selectedDefinition.adapter.secretFieldKeys);
    const publicValues = Object.fromEntries(Object.entries(values).filter(([key]) => !secrets.has(key)));
    const secureValues = Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) => secrets.has(key) && typeof value === "string" && value.trim() && value !== "[REDACTED]",
      ),
    ) as Record<string, string>;
    let saved = await op.write(
      () =>
        updateChannelSetupDraft(draft.draftId, {
          expectedRevision: draft.revision,
          label: input.label.trim() || undefined,
          enabled: input.enabled,
          draft: publicValues,
        }),
      (value) => {
        assertChannelDraft(value, draft, draft.revision);
        if (
          value.enabled !== input.enabled ||
          (input.label.trim() && value.label !== input.label.trim()) ||
          Object.entries(publicValues).some(
            ([key, field]) => JSON.stringify(value.draft[key]) !== JSON.stringify(field),
          )
        )
          throw new Error("The channel save response did not acknowledge the submitted public fields.");
      },
      draft.draftId,
    );
    // Never dispatch a second write after navigation or a newer edit. The first receipt remains inspectable.
    if (!s.isCurrentDraft() || !currentInput(input) || s.inputEpoch.current !== generation) {
      s.channelDraft.acceptSaved(
        canonical(saved),
        saved.revision,
        Object.keys(secureValues).length ? canonical(saved) : submitted,
      );
      if (s.isCurrentDraft()) s.mergeDraft(saved);
      return undefined;
    }
    if (Object.keys(secureValues).length) {
      const publicReceipt = saved;
      saved = await op.write(
        () =>
          submitChannelSetupDraftSecrets(draft.draftId, {
            expectedRevision: publicReceipt.revision,
            values: secureValues,
          }),
        (value) => {
          assertChannelDraft(value, draft, publicReceipt.revision);
          if (
            Object.keys(secureValues).some(
              (key) => value.secretState[key]?.configured !== true || value.draft[key] !== "[REDACTED]",
            )
          )
            throw new Error("The secure owner did not confirm redacted custody for the submitted channel fields.");
        },
        draft.draftId,
      );
    }
    const clean = s.channelDraft.acceptSaved(canonical(saved), saved.revision, submitted);
    if (!s.isCurrentDraft()) return undefined;
    s.mergeDraft(saved);
    if (!clean) {
      s.setNotice({
        tone: "warning",
        message: "The submitted channel draft was saved. Newer edits remain; save them before continuing.",
      });
      return undefined;
    }
    return saved;
  }
  async function run<T>(kind: NonNullable<ChannelSetupState["busyAction"]>, action: (op: Operation) => Promise<T>) {
    const op = beginChannelOperation();
    if (!op) return undefined;
    s.setBusyAction(kind);
    try {
      return await action(op);
    } catch (cause) {
      await failure(cause);
      return undefined;
    } finally {
      op.finish();
      if (s.isCurrentDraft()) s.setBusyAction(null);
    }
  }
  const handleSave = async (values?: Record<string, unknown>): Promise<boolean> =>
    Boolean(
      await run("save", async (op) => {
        const saved = await persist(op, values);
        if (saved && s.isCurrentDraft()) s.setNotice({ tone: "success", message: "Channel draft saved." });
        return saved;
      }),
    );
  const check = async (kind: "validate" | "test", values?: Record<string, unknown>): Promise<void> => {
    if (s.needsConnectionReview) return;
    await run(kind, async (op) => {
      const current = await persist(op, values);
      if (!current || !s.isCurrentDraft()) return;
      const input = latestInput.current;
      const generation = s.inputEpoch.current;
      const validation = await op.write(
        () => validateChannelSetupDraft(current.draftId, current.revision),
        (result) => assertCheck(result, current),
        current.draftId,
      );
      if (!s.isCurrentDraft() || !currentInput(input) || s.inputEpoch.current !== generation) return;
      let result = validation;
      let resultKind: "validate" | "test" = "validate";
      if (kind === "test" && validation.status !== "error") {
        result = await op.write(
          () => testChannelSetupDraft(current.draftId, validation.draftRevision),
          (value) => assertCheck(value, { ...current, revision: validation.draftRevision }),
        );
        resultKind = "test";
      }
      if (!s.isCurrentDraft() || !currentInput(input) || s.inputEpoch.current !== generation) return;
      s.setValidationRevision(result.draftRevision);
      s.setValidationResult({ ...result, kind: resultKind });
      s.setNotice({
        tone: result.status === "error" ? "error" : result.status === "warn" ? "warning" : "success",
        message: resultKind === "test" ? "Channel draft tested." : "Channel draft validated.",
      });
      await s.reload();
    });
  };
  const handleFinalize = async (values?: Record<string, unknown>): Promise<void> => {
    const draft = s.selectedDraft;
    if (!draft || s.needsConnectionReview) return;
    if (
      s.draftHasChanges(values) ||
      s.validationResult?.kind !== "test" ||
      s.validationResult.status !== "ok" ||
      s.validationRevision !== draft.revision
    ) {
      s.setNotice({
        tone: "warning",
        message: "Save these changes and run a passing live test for this exact revision before finalizing.",
      });
      return;
    }
    const input = s.channelDraft.value;
    const generation = s.inputEpoch.current;
    await run("finalize", async (op) => {
      await freshDraft(draft, draft.revision);
      if (!s.isCurrentDraft() || !currentInput(input) || s.inputEpoch.current !== generation) return;
      const plan = await op.write(
        () =>
          createChangePlan({
            workspaceId: s.activeWorkspaceId,
            surface: "settings",
            request: { kind: "channel_connection", channelKind: draft.catalogId, draftId: draft.draftId },
            idempotencyKey: `settings-channel-finalize:${draft.draftId}:${draft.revision}`,
          }),
        (value) => {
          if (
            value.origin.workspaceId !== s.activeWorkspaceId ||
            value.origin.surface !== "settings" ||
            value.request.kind !== "channel_connection" ||
            value.request.draftId !== draft.draftId ||
            value.request.channelKind !== draft.catalogId ||
            value.target.expectedRevision !== draft.revision
          )
            throw new Error(
              "The Change Plan did not bind the exact reviewed channel draft. Inspect its owner evidence before continuing.",
            );
        },
      );
      if (!s.isCurrentDraft() || !currentInput(input) || s.inputEpoch.current !== generation) return;
      s.setNotice({
        tone: "success",
        message: `Change Plan ${plan.planId} is ready for its required action in Chat. Review its current fields, credentials, confirmation, and approval as requested by the Gateway. The draft has not been finalized yet.`,
      });
      onPlanReady(plan);
    });
  };
  const handleAcceptConnectionReview = async () => {
    const draft = s.selectedDraft,
      connection = s.draftConnection;
    if (!draft || !connection || s.connectionReview.loading || s.connectionReview.error) return;
    await run("save", async (op) => {
      await freshDraft(draft, draft.revision);
      if (!s.isCurrentDraft()) return;
      const reviewed = await op.write(
        () =>
          reviewChannelSetupConnection(draft.draftId, {
            expectedRevision: draft.revision,
            expectedConnectionRevision: connection.revision,
          }),
        (value) => {
          assertChannelDraft(value, draft, draft.revision);
          if (value.connectionRevision !== connection.revision)
            throw new Error("Connection review returned a different owner revision.");
        },
        draft.draftId,
      );
      if (!s.isCurrentDraft()) return;
      s.channelDraft.acceptSaved(canonical(reviewed), reviewed.revision, canonical(draft));
      s.mergeDraft(reviewed);
      s.connectionReview.accept();
      s.setValidationResult(null);
      s.setValidationRevision(null);
      s.setNotice({
        tone: "success",
        message: "Connection review saved. Your edits are retained. Save any changes and run the live test again.",
      });
    });
  };
  s.saveRef.current = () => handleSave();
  return {
    handleSave,
    handleValidate: (values?: Record<string, unknown>) => check("validate", values),
    handleTest: (values?: Record<string, unknown>) => check("test", values),
    handleFinalize,
    handleAcceptConnectionReview,
  };
}
