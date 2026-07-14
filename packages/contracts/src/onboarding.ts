import type { AuthRuntimeSettings, AuthSettingsUpdateInput } from "./integrations.js";
import type { LlmApiStyle, LlmProviderRequestConfig } from "./llm.js";
import type { ToolApprovalMode, ToolProfile } from "./policy.js";

export type OnboardingChecklistStatus = "complete" | "needs_input" | "optional";

export interface OnboardingChecklistItem {
  id: "auth" | "llm" | "runtime" | "mesh";
  label: string;
  status: OnboardingChecklistStatus;
  detail?: string;
}

export type OnboardingFirstRunChecklistItemId =
  | "provider_or_local_runtime"
  | "first_chat"
  | "first_cowork"
  | "first_code"
  | "run_detail";

export interface OnboardingFirstRunProofRef {
  kind: "route" | "verification_lane" | "runtime_evidence";
  label: string;
  ref: string;
}

export interface OnboardingFirstRunChecklistItem {
  id: OnboardingFirstRunChecklistItemId;
  label: string;
  status: OnboardingChecklistStatus;
  detail: string;
  proofRefs: OnboardingFirstRunProofRef[];
}

export type OnboardingReadinessStatus = "ready" | "needs_input" | "blocked" | "unknown";

export interface OnboardingSetupReadinessItem {
  id:
    | "gateway_url"
    | "auth_mode"
    | "remote_posture"
    | "cors"
    | "tailnet"
    | "outbound_allowlist"
    | "storage_root"
    | "provider"
    | "desktop_credentials"
    | "first_run"
    | "release_proof";
  label: string;
  status: OnboardingReadinessStatus;
  value: string;
  detail: string;
  proofRefs?: OnboardingFirstRunProofRef[];
}

export interface OnboardingSetupReadiness {
  generatedAt: string;
  profile: {
    gatewayUrl: string;
    authMode: AuthRuntimeSettings["mode"];
    deploymentPosture: "local_trusted" | "remote_hardened" | "local_network" | "unknown";
    tailnetMode: "enabled" | "disabled" | "not_required" | "unknown";
  };
  summary: {
    ready: number;
    needsInput: number;
    blocked: number;
    unknown: number;
  };
  items: OnboardingSetupReadinessItem[];
}

export interface OnboardingState {
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
  checklist: OnboardingChecklistItem[];
  firstRunChecklist?: OnboardingFirstRunChecklistItem[];
  setupReadiness?: OnboardingSetupReadiness;
  settings: {
    revision: number;
    toolApprovalMode: ToolApprovalMode;
    defaultToolProfile: string;
    budgetMode: "saver" | "balanced" | "power";
    networkAllowlist: string[];
    auth: AuthRuntimeSettings;
    llm: {
      activeProviderId: string;
      activeModel: string;
      providers: Array<{
        providerId: string;
        label: string;
        baseUrl: string;
        apiStyle: LlmApiStyle;
        resolvedApiStyle?: LlmApiStyle;
        defaultModel: string;
        hasApiKey: boolean;
        apiKeySource: "inline" | "env" | "keychain" | "none";
        hasKeychainSecret?: boolean;
        apiKeyRef?: string;
      }>;
    };
    mesh: {
      enabled: boolean;
      mode: "lan" | "wan" | "tailnet";
      nodeId: string;
      mdns: boolean;
      staticPeers: string[];
      requireMtls: boolean;
      tailnetEnabled: boolean;
    };
  };
}

export interface OnboardingStartupState {
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
  setupReadiness?: Pick<OnboardingSetupReadiness, "generatedAt" | "profile" | "summary">;
}

export interface OnboardingBootstrapInput {
  expectedRevision: number;
  toolApprovalMode?: ToolApprovalMode;
  defaultToolProfile?: ToolProfile;
  budgetMode?: "saver" | "balanced" | "power";
  networkAllowlist?: string[];
  auth?: AuthSettingsUpdateInput;
  llm?: {
    activeProviderId?: string;
    activeModel?: string;
    upsertProvider?: {
      providerId: string;
      label?: string;
      baseUrl?: string;
      apiStyle?: LlmApiStyle;
      defaultModel?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      persistSecretToSecureStore?: boolean;
      request?: LlmProviderRequestConfig;
      headers?: Record<string, string>;
    };
  };
  mesh?: {
    enabled?: boolean;
    mode?: "lan" | "wan" | "tailnet";
    nodeId?: string;
    mdns?: boolean;
    staticPeers?: string[];
    requireMtls?: boolean;
    tailnetEnabled?: boolean;
  };
  markComplete?: boolean;
  completedBy?: string;
}

export interface OnboardingBootstrapResult {
  state: OnboardingState;
  appliedAt: string;
}
