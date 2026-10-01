import { lazy, Suspense, useCallback } from "react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import { DraftLeaveDialog } from "./library/DraftLeaveDialog";

import { getRouteReleaseScope, normalizeAppRoute, routeKicker, type AppRoute } from "@next/app/route-model";
import { useBeforeUnloadGuard, useNavigateGuard } from "./library/use-form-dirty";

import "./native-routes.css";
import { BudgetSection } from "./settings/sections/BudgetSection";
const TrustPolicySection = lazy(() =>
  import("./settings/sections/TrustPolicySection").then((module) => ({ default: module.TrustPolicySection })),
);
const WorkspaceCapabilitiesSection = lazy(() =>
  import("./settings/sections/WorkspaceCapabilitiesSection").then((module) => ({
    default: module.WorkspaceCapabilitiesSection,
  })),
);
const CitadelCapabilitiesSection = lazy(() =>
  import("./settings/sections/CitadelCapabilitiesSection").then((module) => ({
    default: module.CitadelCapabilitiesSection,
  })),
);
import { UnknownSettingsSection } from "./settings/sections/UnknownSettingsSection";
const LocalAiSection = lazy(() =>
  import("./settings/sections/LocalAiSection").then((module) => ({ default: module.LocalAiSection })),
);
const AccessSection = lazy(() =>
  import("./settings/sections/AccessSection").then((module) => ({ default: module.AccessSection })),
);
import { GeneralSection } from "./settings/sections/GeneralSection";
const PersonalitiesSection = lazy(() =>
  import("./settings/sections/PersonalitiesSection").then((module) => ({ default: module.PersonalitiesSection })),
);
const ChannelsSection = lazy(() =>
  import("./settings/sections/ChannelsSection").then((module) => ({ default: module.ChannelsSection })),
);
const ToolsSection = lazy(() =>
  import("./settings/sections/ToolsSection").then((module) => ({ default: module.ToolsSection })),
);
const HooksSection = lazy(() =>
  import("./settings/sections/HooksSection").then((module) => ({ default: module.HooksSection })),
);
const RuntimeSection = lazy(() =>
  import("./settings/sections/RuntimeSection").then((module) => ({ default: module.RuntimeSection })),
);
const WorkspacesSection = lazy(() =>
  import("./settings/sections/WorkspacesSection").then((module) => ({ default: module.WorkspacesSection })),
);
const OnboardingSection = lazy(() =>
  import("./settings/sections/OnboardingSection").then((module) => ({ default: module.OnboardingSection })),
);
const AddonsSection = lazy(() =>
  import("./settings/sections/AddonsSection").then((module) => ({ default: module.AddonsSection })),
);
const PermissionsSection = lazy(() =>
  import("./settings/sections/PermissionsSection").then((module) => ({ default: module.PermissionsSection })),
);
const McpSection = lazy(() =>
  import("./settings/sections/McpSection").then((module) => ({ default: module.McpSection })),
);
const IntegrationsSection = lazy(() =>
  import("./settings/sections/IntegrationsSection").then((module) => ({ default: module.IntegrationsSection })),
);
const ProvidersSection = lazy(() =>
  import("./settings/sections/ProvidersSection").then((module) => ({ default: module.ProvidersSection })),
);
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsCodeBlock,
  SettingsConfigSourceLegend,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  SettingsPageFrame,
  SettingsPosturePanel,
  SettingsSectionShell,
  SettingsStack,
  SettingsWizardSteps,
  descriptionForSettingsSection,
  formatEffectiveConfigSourceLabel,
  getErrorMessage,
  iconForSettingsSection,
  labelForSettingsSection,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
  type LoadState,
  type NativeLoadIssue,
  type NativeLoadResult,
  type Notice,
  type SettingsNativePageProps,
  type SettingsSectionProps,
  type SettingsWizardStepState,
} from "./settings/SettingsShared";

export function SettingsNativePage(props: SettingsNativePageProps) {
  const section = props.route.section ? String(props.route.section) : "general";

  // Ship punchlist H-9 (data integrity) — wire unsaved-state plumbing for the
  // settings surface. The hook registry and beforeunload listener are tracked
  // in ./library/use-form-dirty.ts; sections opt in by calling `useFormDirty`.
  useBeforeUnloadGuard();
  const isSameRoute = useCallback(
    (target: AppRoute) =>
      target.area === props.route.area && (target.section ?? "general") === (props.route.section ?? "general"),
    [props.route.area, props.route.section],
  );
  const {
    navigate: guardedNavigate,
    pending,
    confirmDiscard,
    confirmKeep,
    cancelDiscard,
  } = useNavigateGuard<AppRoute>(props.navigate, isSameRoute);
  const guardedProps: SettingsNativePageProps = { ...props, navigate: guardedNavigate };

  return (
    <SettingsPageFrame
      icon={iconForSettingsSection(section)}
      kicker={routeKicker(normalizeAppRoute(props.route))}
      title={labelForSettingsSection(section)}
      description={descriptionForSettingsSection(section)}
      releaseStatus={getRouteReleaseScope(props.route).status}
    >
      <Suspense
        key={`${section}:${props.activeWorkspaceId}:${props.activeCitadelId ?? "global"}`}
        fallback={<BlocksShuffleLoader label={`Loading ${labelForSettingsSection(section)}`} />}
      >
        {renderSettingsSection({ ...guardedProps, section })}
      </Suspense>
      <DraftLeaveDialog
        open={pending !== null}
        keys={pending?.keys ?? []}
        onContinue={confirmKeep}
        onDiscard={confirmDiscard}
        onCancel={cancelDiscard}
      />
    </SettingsPageFrame>
  );
}

function renderSettingsSection(props: SettingsSectionProps) {
  switch (props.section) {
    case "general":
      return <GeneralSection {...props} />;
    case "onboarding":
      return <OnboardingSection {...props} />;
    case "budget":
      return <BudgetSection {...props} />;
    case "providers":
      return <ProvidersSection {...props} />;
    case "local-ai":
      return <LocalAiSection {...props} />;
    case "personalities":
      return <PersonalitiesSection {...props} />;
    case "access":
      return <AccessSection {...props} />;
    case "permissions":
      return <PermissionsSection {...props} />;
    case "trust-policy":
      return <TrustPolicySection {...props} />;
    case "runtime":
      return <RuntimeSection {...props} />;
    case "workspaces":
      return <WorkspacesSection {...props} />;
    case "integrations":
      return <IntegrationsSection {...props} />;
    case "channels":
      return <ChannelsSection {...props} />;
    case "mcp":
      return <McpSection {...props} />;
    case "tools":
      return <ToolsSection {...props} />;
    case "hooks":
      return <HooksSection {...props} />;
    case "addons":
      return <AddonsSection {...props} />;
    case "workspace-capabilities":
      return <WorkspaceCapabilitiesSection {...props} />;
    case "citadel-capabilities":
      return <CitadelCapabilitiesSection {...props} />;
    default:
      return <UnknownSettingsSection {...props} />;
  }
}

export {
  isLikelyLocalProviderBaseUrl,
  formatProviderProbeStateLabel,
  formatProviderProbeSourceMeta,
  formatProviderModelsMeta,
  formatCheckedAtLabel,
  formatProviderCredentialLabel,
  resolveProviderCredentialReady,
  describeProviderRequestOverrides,
  deriveProviderSmokeEvidenceItems,
  deriveDesktopMobileContinuityItems,
} from "./settings/helpers/provider-format";

export {
  SettingsActionList,
  SettingsButtonRow,
  SettingsCodeBlock,
  SettingsConfigSourceLegend,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  SettingsPageFrame,
  SettingsPosturePanel,
  SettingsSectionShell,
  SettingsStack,
  SettingsWizardSteps,
  descriptionForSettingsSection,
  formatEffectiveConfigSourceLabel,
  getErrorMessage,
  iconForSettingsSection,
  labelForSettingsSection,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
};
export type {
  LoadState,
  NativeLoadIssue,
  NativeLoadResult,
  Notice,
  SettingsNativePageProps,
  SettingsSectionProps,
  SettingsWizardStepState,
};

export {
  parseJsonObject,
  splitCommaList,
  splitLineList,
  splitLineOrCommaList,
  readDraftString,
  readConnectionConfigString,
  delay,
  formatJson,
  formatCapabilities,
  deriveLlamaCppAlias,
  formatDateTime,
} from "./settings/helpers/input-format";
export {
  BUDGET_MODE_OPTIONS,
  normalizeBudgetMode,
  describeBudgetMode,
  labelForBudgetMode,
} from "./settings/helpers/budget-preferences";
export {
  type ProviderEditorDraft,
  createEmptyProviderEditorDraft,
  buildProviderEditorDraft,
  buildChatGptOAuthProviderDraft,
  getProviderApiStyleWarning,
} from "./settings/helpers/provider-drafts";
export {
  OPENAI_CODEX_MIN_POLL_MS,
  isTrustedOpenAICodexVerificationUrl,
  normalizeOpenAICodexPollDelayMs,
  isStoredOpenAICodexOAuthFlow,
  removeStoredOpenAICodexOAuthFlow,
  readStoredOpenAICodexOAuthFlowFrom,
  readStoredOpenAICodexOAuthFlow,
  writeStoredOpenAICodexOAuthFlow,
  clearStoredOpenAICodexOAuthFlow,
  formatOpenAICodexOAuthExpiry,
} from "./settings/helpers/provider-oauth";
export {
  TOOL_APPROVAL_MODE_OPTIONS,
  type PermissionProfileEditorDraft,
  matchesToolGrant,
  isToolGrantAvailable,
  describeToolGrantAvailability,
  defaultToolGrantExpiry,
  createEmptyPermissionProfileDraft,
  createPermissionProfileDraftFromRecord,
  permissionProfileDraftToMutation,
  togglePermissionProfileSurface,
  normalizeToolApprovalMode,
  describeToolApprovalMode,
  describeToolApprovalModeHelp,
  describePermissionProfile,
  labelForPermissionProfile,
  labelForLocalOperatorOverrideScope,
  resolveLocalOperatorOverrideScopeRef,
  resetLocalOperatorOverrideScopeRefForScope,
} from "./settings/helpers/permission-helpers";
export {
  collectDefinitionFieldHints,
  applyIntegrationDefaults,
  preferredChannelDefinition,
} from "./settings/helpers/channel-helpers";
export {
  isRuntimeInvokableMcpServer,
  createEmptyMcpRemotePreview,
  createEmptyMcpServerModeManifest,
  formatMcpRemotePreviewItem,
  formatMcpElicitationMeta,
  parseMcpElicitationDraft,
} from "./settings/helpers/mcp-helpers";
export {
  deriveSetupCenterItems,
  deriveEcosystemProofLaneItems,
  deriveOnboardingProviderSmokeEvidenceItems,
  describeProviderReadinessFailure,
  wizardStateForChecklist,
  setupMeta,
} from "./settings/helpers/onboarding-readiness";
export {
  type FirstRunEvidenceSnapshot,
  buildFirstRunEvidenceSnapshot,
  type FirstRunGovernedJobState,
  deriveFirstOutcomePathItems,
  deriveFirstRunGovernedJobState,
} from "./settings/helpers/first-run-evidence";
export {
  type PersonalityEditorDraft,
  createEmptyPersonalityEditorDraft,
  createPersonalityEditorDraft,
  personalityDraftToMutationInput,
  arePersonalityDraftsEqual,
  formatPersonalityStatus,
  formatPersonalityCategoryLabel,
  normalizePersonalityEditorId,
} from "./settings/helpers/personality-helpers";
