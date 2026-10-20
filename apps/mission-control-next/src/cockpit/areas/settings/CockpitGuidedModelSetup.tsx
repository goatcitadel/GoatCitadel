import { useState } from "react";
import { Play, PlugZap } from "lucide-react";
import type { ChatThinkingLevel, OnboardingState } from "@goatcitadel/contracts";
import { ChatChangePlanCard } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { GUIDED_THINKING_LEVELS } from "../../../features/native-routes/settings/sections/guided-model-setup-support";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { MetricList } from "../../ui/MetricList";
import { cockpitInputClass } from "../../ui/input-class";
import { GuidedModelPlanDialog } from "./GuidedModelPlanDialog";
import { GuidedModelSteps } from "./GuidedModelSteps";
import { useGuidedModelSetup } from "./use-guided-model-setup";

const SELECT = cockpitInputClass;

/** The guided chat-model owner, shared by Models settings and first run. It includes the API-key path. */
export function CockpitGuidedModelSetup({
  onboarding,
  reloadOnboarding,
  onEnterChat,
  enterChatLabel = "Enter Chat",
  onNoticeChange,
  showSteps = true,
}: {
  onboarding: OnboardingState;
  reloadOnboarding: () => Promise<void>;
  onEnterChat: () => void;
  /** Overrides the "Enter Chat" button text when the host's next step is not Chat. */
  enterChatLabel?: string;
  /**
   * Given by a host that keeps and shows the notice itself, so it outlives this card: Models settings
   * unmounts the card when the re-read after a change fails. Without it the card shows its own (first run).
   */
  onNoticeChange?: (notice: string | null) => void;
  /** First run lists its own steps, so it hides this card's step list and keeps one flat stepper. */
  showSteps?: boolean;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const [ownNotice, setOwnNotice] = useState<string | null>(null);
  const notice = onNoticeChange ? null : ownNotice;
  const setup = useGuidedModelSetup({
    workspaceId,
    onboarding,
    reloadOnboarding,
    setNotice: onNoticeChange ?? setOwnNotice,
    onEnterChat,
  });
  const { readiness, providerReady, model, models, busy, catalog } = setup;
  const providerLabel = setup.selectedProvider?.label ?? "This provider";
  const primaryLabel =
    setup.primary.kind === "enter"
      ? enterChatLabel
      : setup.primary.kind === "confirm"
        ? "Confirm model"
        : setup.primary.kind === "check"
          ? readiness.state === "checking"
            ? "Checking connection…"
            : "Check connection"
          : (setup.connectionHint?.connectLabel ?? "Connect provider");
  const PrimaryIcon = setup.primary.kind === "enter" ? Play : PlugZap;
  // Offer the better-supported provider as a one-click switch, only when the list has it.
  const alternative = setup.providers.some(
    (provider) => provider.providerId === setup.connectionHint?.alternative?.providerId,
  )
    ? setup.connectionHint?.alternative
    : undefined;
  return (
    <div className="mt-4 grid gap-4">
      {setup.draft.hasRemoteChanges ? (
        <Callout>
          Saved model defaults changed. Your selection is kept; confirming reviews the current saved setup.
        </Callout>
      ) : null}
      {showSteps ? <GuidedModelSteps setup={setup} /> : null}
      <MetricList
        label="Model setup status"
        items={[
          { term: "Connection", value: readiness.label },
          // A template default is only a suggestion until the provider is ready.
          { term: "Model", value: !model ? "Choose one" : providerReady ? model : `Suggested: ${model}` },
          { term: "First response", value: setup.progress.firstResponseLabel },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Provider or local runtime"
          help={
            setup.connectionHint
              ? // Keep a catalog error visible beside the provider hint.
                [setup.connectionHint.note, catalog.error].filter(Boolean).join(" ")
              : (catalog.error ?? "The Gateway checks this connection before Chat can use it.")
          }
        >
          {(fieldProps) => (
            <select
              {...fieldProps}
              className={SELECT}
              value={setup.providerId}
              disabled={busy || catalog.loading}
              onChange={(event) => setup.setProviderId(event.currentTarget.value)}
            >
              {!setup.providerId ? (
                <option value="" disabled>
                  Choose a provider or local runtime
                </option>
              ) : null}
              {setup.providerId && !setup.selectedProvider ? (
                <option value={setup.providerId}>
                  {catalog.loading ? "Loading providers…" : "Saved provider · unavailable"}
                </option>
              ) : null}
              {setup.providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Model"
          help={
            providerReady
              ? "GoatCitadel checks that the model is available when you confirm it."
              : "Connect the provider first to choose from its models."
          }
        >
          {(fieldProps) => (
            <select
              {...fieldProps}
              className={SELECT}
              value={model}
              disabled={busy || !providerReady || models.length === 0}
              onChange={(event) => setup.setModel(event.currentTarget.value)}
            >
              {model && !models.includes(model) ? <option value={model}>{model} · current selection</option> : null}
              {models.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {setup.localGuide && !setup.defaultPlanCompleted ? (
        <section aria-label={setup.localGuide.title} className="grid gap-2 text-sm text-fg-secondary">
          <h3 className="font-semibold text-fg">{setup.localGuide.title}</h3>
          <ol className="list-decimal space-y-1 pl-5">
            {setup.localGuide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {setup.localGuide.command ? (
            <code className="block break-all rounded-md bg-sunken p-2 font-mono text-xs text-fg">
              {setup.localGuide.command}
            </code>
          ) : null}
        </section>
      ) : null}
      <details className="text-sm text-fg-secondary">
        <summary className="cursor-pointer font-medium text-fg">Advanced model settings</summary>
        <div className="mt-3 grid gap-3">
          <Field
            label="Effort"
            help={
              setup.supportedThinkingLevels.length === 1
                ? `${providerLabel} does not report reasoning effort, so effort stays Off.`
                : setup.effortLimited
                  ? `Showing only the effort levels ${providerLabel} supports.`
                  : "Unsupported model-specific effort is rejected before confirmation and valid alternatives are returned."
            }
          >
            {(fieldProps) => (
              <select
                {...fieldProps}
                className={SELECT}
                value={setup.thinkingLevel}
                disabled={busy || !providerReady}
                onChange={(event) => setup.setThinkingLevel(event.currentTarget.value as ChatThinkingLevel)}
              >
                {GUIDED_THINKING_LEVELS.filter((option) => setup.supportedThinkingLevels.includes(option.value)).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            )}
          </Field>
          <div>
            <Button disabled={busy || !setup.providerId} onClick={() => void setup.createProviderPlan()}>
              Verify provider connection
            </Button>
          </div>
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={busy}
          loadingLabel={primaryLabel}
          disabled={!busy && setup.primaryDisabled}
          onClick={() => void setup.primary.run()}
        >
          <PrimaryIcon aria-hidden="true" className="size-4" />
          {primaryLabel}
        </Button>
        {alternative ? (
          <Button disabled={busy} onClick={() => setup.setProviderId(alternative.providerId)}>
            {alternative.label}
          </Button>
        ) : null}
      </div>
      {setup.actionError && !setup.dialogPlan ? <Callout tone="error">{setup.actionError}</Callout> : null}
      {setup.latestPlan ? (
        <ChatChangePlanCard
          plan={setup.latestPlan}
          pending={busy}
          onReview={(plan) => {
            setup.setActionError(null);
            setup.setDialogPlan(plan);
          }}
          onCancel={setup.cancelPlan}
        />
      ) : null}
      <GuidedModelPlanDialog control={setup} workspaceId={workspaceId} />
      {notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
