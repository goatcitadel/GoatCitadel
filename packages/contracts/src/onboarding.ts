import type { AuthRuntimeSettings, AuthSettingsUpdateInput } from "./integrations.js";
import type { LlmApiStyle } from "./llm.js";
import type { ToolProfile } from "./policy.js";

export type OnboardingChecklistStatus = "complete" | "needs_input" | "optional";

export interface OnboardingChecklistItem {
  id: "auth" | "llm" | "runtime" | "mesh";
  label: string;
  status: OnboardingChecklistStatus;
  detail?: string;
}

export interface OnboardingState {
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
  checklist: OnboardingChecklistItem[];
  settings: {
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

export interface OnboardingBootstrapInput {
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
