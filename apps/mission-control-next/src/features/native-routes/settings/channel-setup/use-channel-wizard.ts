import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import {
  isStepVisible,
  formatJson,
  findMissingFieldLabels,
  type ChannelSetupWizardProps,
} from "./channel-wizard-model";
export function useChannelWizard({
  scopeId = "global",
  advancedValue,
  onAdvancedValueChange,
  definition,
  draft,
  values,
  dirty,
  reviewRequired = false,
  busyAction = null,
  feedback,
  onValuesChange,
  onSave,
  onValidate,
  onTest,
  onFinalize,
}: ChannelSetupWizardProps) {
  const visibleSteps = useMemo(
    () => definition.wizard.steps.filter((step) => isStepVisible(step, values)),
    [definition.wizard.steps, values],
  );
  const viewKey = "channel:" + scopeId + ":" + draft.draftId;
  const [activeStepId, setActiveStepId] = useSessionViewState(viewKey + ":step", visibleSteps[0]?.id ?? "");
  const [visitedStepIds, setVisitedStepIds] = useSessionViewState<Record<string, boolean>>(viewKey + ":visited", {});
  const [checkedItems, setCheckedItems] = useSessionViewState<Record<string, boolean>>(viewKey + ":checklist", {});
  const [advancedMode, setAdvancedMode] = useSessionViewState(viewKey + ":advanced-mode", false);
  const [localAdvancedJson, setLocalAdvancedJson] = useState(() => formatJson(values));
  const advancedJson = advancedValue ?? localAdvancedJson;
  const setAdvancedJson = (value: string) => {
    if (onAdvancedValueChange) onAdvancedValueChange(value);
    else setLocalAdvancedJson(value);
  };
  const [localError, setLocalError] = useState<string | null>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusStepRef = useRef(false);

  const activeStepIndex = Math.max(
    0,
    visibleSteps.findIndex((step) => step.id === activeStepId),
  );
  const activeStep = visibleSteps[activeStepIndex] ?? visibleSteps[0];
  const anyBusy = busyAction !== null;

  useEffect(() => {
    setLocalError(null);
  }, [draft.draftId]);

  useEffect(() => {
    if (!visibleSteps.some((step) => step.id === activeStepId)) {
      setActiveStepId(visibleSteps[0]?.id ?? "");
    }
  }, [activeStepId, visibleSteps, setActiveStepId]);

  useEffect(() => {
    if (!shouldFocusStepRef.current) {
      return;
    }
    shouldFocusStepRef.current = false;
    stepHeadingRef.current?.focus();
  }, [activeStepId]);

  useEffect(() => {
    if (advancedValue === undefined && (!advancedMode || !dirty)) {
      setLocalAdvancedJson(formatJson(values));
    }
  }, [advancedValue, advancedMode, dirty, values]);

  useEffect(() => {
    const firstFieldIssue = feedback?.issues.find((issue) => issue.fieldKey)?.fieldKey;
    if (!firstFieldIssue || feedback?.status === "ok") {
      return;
    }
    const targetStep = visibleSteps.find((step) => step.fields?.some((field) => field.key === firstFieldIssue));
    if (targetStep) {
      setAdvancedMode(false);
      setActiveStepId(targetStep.id);
    }
  }, [feedback, visibleSteps, setActiveStepId, setAdvancedMode]);

  const selectStep = (stepId: string) => {
    if (activeStep) {
      setVisitedStepIds((current) => ({ ...current, [activeStep.id]: true }));
    }
    shouldFocusStepRef.current = true;
    setActiveStepId(stepId);
    setLocalError(null);
  };

  const prepareValues = (): Record<string, unknown> | undefined => {
    if (!advancedMode) {
      return values;
    }
    try {
      const parsed = JSON.parse(advancedJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setLocalError("Advanced JSON must contain one object at the top level.");
        return undefined;
      }
      const next = parsed as Record<string, unknown>;
      if (formatJson(next) !== formatJson(values)) {
        onValuesChange(next);
      }
      setAdvancedJson(formatJson(next));
      setLocalError(null);
      return next;
    } catch (error) {
      setLocalError(
        error instanceof Error ? `Advanced JSON is invalid: ${error.message}` : "Advanced JSON is invalid.",
      );
      return undefined;
    }
  };

  const switchToGuidedMode = () => {
    const next = prepareValues();
    if (!next) {
      return;
    }
    setAdvancedMode(false);
  };

  const handleSave = async () => {
    const next = prepareValues();
    if (!next) {
      return false;
    }
    return onSave(next);
  };

  const handleValidate = async () => {
    if (reviewRequired) return;
    const next = prepareValues();
    if (next) {
      await onValidate(next);
    }
  };

  const handleTest = async () => {
    if (reviewRequired) return;
    const next = prepareValues();
    if (next) {
      await onTest(next);
    }
  };

  const handleFinalize = async () => {
    if (reviewRequired) return;
    const next = prepareValues();
    if (next) {
      await onFinalize(next);
    }
  };

  const moveForward = async () => {
    if (!activeStep) {
      return;
    }
    const missing = findMissingFieldLabels(definition, draft, activeStep, values);
    if (missing.length > 0) {
      setLocalError(`Complete the required setup values before continuing: ${missing.join(", ")}.`);
      return;
    }
    if ((activeStep.fields?.length ?? 0) > 0 && !(await handleSave())) {
      return;
    }
    setVisitedStepIds((current) => ({ ...current, [activeStep.id]: true }));
    const next = visibleSteps[activeStepIndex + 1];
    if (next) {
      setActiveStepId(next.id);
      setLocalError(null);
    }
  };

  return {
    visibleSteps,
    activeStepId,
    activeStepIndex,
    activeStep,
    anyBusy,
    visitedStepIds,
    checkedItems,
    setCheckedItems,
    advancedMode,
    setAdvancedMode,
    advancedJson,
    setAdvancedJson,
    localError,
    setLocalError,
    stepHeadingRef,
    selectStep,
    switchToGuidedMode,
    handleSave,
    handleValidate,
    handleTest,
    handleFinalize,
    moveForward,
  };
}
