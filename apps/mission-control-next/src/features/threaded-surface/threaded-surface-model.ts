import type { ChatMode } from "@goatcitadel/contracts";
import { Code2, MessageSquareText, Workflow } from "lucide-react";

export const MODE_META: Record<
  ChatMode,
  { label: string; icon: typeof MessageSquareText; helper: string; posture: string; stageLabel: string }
> = {
  chat: {
    label: "Chat",
    icon: MessageSquareText,
    helper: "Conversation, attachments, planning, tools, approvals, and source context in one place.",
    posture: "chat",
    stageLabel: "Chat workspace stage",
  },
  cowork: {
    label: "Chat",
    icon: Workflow,
    helper: "Legacy planning posture now resolves into Chat.",
    posture: "chat",
    stageLabel: "Chat workspace stage",
  },
  code: {
    label: "Chat",
    icon: Code2,
    helper: "Legacy build posture now resolves into Chat with governed code capabilities.",
    posture: "chat",
    stageLabel: "Chat workspace stage",
  },
};

export type EmptyStateGuidance = {
  title: string;
  body: string;
  startLabel: string;
  startHereLabel: string;
  cards: Array<{ title: string; body: string }>;
};

export const EMPTY_STATE_GUIDANCE: Record<ChatMode, EmptyStateGuidance> = {
  chat: {
    title: "Start with the first useful move",
    body: "Ask directly, attach context, or open Start Here when this workspace still needs its first chat.",
    startLabel: "Start chat",
    startHereLabel: "Open Start Here",
    cards: [
      { title: "Fast answer", body: "Draft, compare, summarize, or ask a short question." },
      { title: "Guided setup", body: "Use the sample mission when provider, workspace, or memory context is unclear." },
      {
        title: "Escalate",
        body: "Ask for a plan, use tools, or add source context in the same chat when the work needs structure.",
      },
    ],
  },
  cowork: {
    title: "Set up supervised work",
    body: "Turn a goal into a visible plan with task lanes, approvals, checkpoints, and delegated follow-through.",
    startLabel: "Start plan",
    startHereLabel: "Use Start Here mission",
    cards: [
      { title: "Plan", body: "Frame the work before durable steps begin." },
      { title: "Task board", body: "Track delegation, retries, blockers, and checkpoints." },
      { title: "Approvals", body: "Review human-gated decisions before the run advances." },
    ],
  },
  code: {
    title: "Prepare a governed code pass",
    body: "Bind source context, review diffs, run validation, and keep Code Mode proof visible before handoff.",
    startLabel: "Start build",
    startHereLabel: "Use Start Here mission",
    cards: [
      { title: "Source", body: "Attach files or start from a project-bound thread." },
      { title: "Diffs", body: "Keep implementation changes reviewable in the workbench." },
      { title: "Proof", body: "Pair approvals, artifacts, and validation with the final code pass." },
    ],
  },
};

export interface ThreadedPermissionState {
  loading?: boolean;
  error?: string;
  profileId?: string;
  profileLabel?: string;
  approvalMode?: string;
  localOperatorOverrideId?: string;
  overrideExpiresAt?: string;
}

export function formatThreadedPermissionSummary(state?: ThreadedPermissionState): string {
  if (!state || state.loading) {
    return "Policy loading";
  }
  if (state.error) {
    return "Policy unavailable";
  }
  const profile = state.profileLabel ?? state.profileId ?? "Safe";
  const details = [formatThreadedApprovalMode(state.approvalMode)].filter(Boolean);
  if (state.localOperatorOverrideId) {
    details.push(
      state.overrideExpiresAt
        ? `override until ${formatThreadedOverrideExpiry(state.overrideExpiresAt)}`
        : "local override active",
    );
  }
  return `Policy: ${[profile, ...details].join(" · ")}`;
}

export function formatThreadedApprovalMode(value?: string): string | undefined {
  switch (value) {
    case "approve_all":
      return "asks every time";
    case "approve_risky":
      return "asks on risk";
    case "bypass":
      return "skips normal prompts";
    default:
      return value;
  }
}

export function formatThreadedOverrideExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return `${new Date(timestamp).toISOString().slice(11, 16)} UTC`;
}

export function getArchiveActionLabel(lifecycleStatus: string, pending: boolean) {
  if (pending) return lifecycleStatus === "archived" ? "Restoring..." : "Archiving...";
  return lifecycleStatus === "archived" ? "Restore" : "Archive";
}

export function formatUtilitySnippet(value?: string | null, maxLength = 1200): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "No content yet.";
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trimEnd()}\n...`;
}
