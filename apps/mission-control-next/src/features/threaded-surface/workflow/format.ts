import type { ChatSessionWorkbenchPackageManager, CodeModeRunRecord } from "@goatcitadel/contracts";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";

export type WorkbenchPaneId = "files" | "selected-diff" | "repo-diff" | "output" | "snippets" | "artifact";

export type AgenticControlItem = NonNullable<
  Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }>["props"]["viewModel"]["agenticRuntime"]
>["controls"][number];

export interface CodeModeRunLedgerItem {
  runId: string;
  status?: string;
  language?: string;
  approvalId?: string;
  originSurface?: CodeModeRunRecord["originSurface"];
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  requestedOutputIntent?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ValidationCommandPreset {
  label: string;
  command: string;
}

const PACKAGE_MANAGER_RUN_PREFIXES: Record<ChatSessionWorkbenchPackageManager, (script: string) => string> = {
  pnpm: (script) => `pnpm ${script}`,
  npm: (script) => `npm run ${script}`,
  yarn: (script) => `yarn ${script}`,
  bun: (script) => `bun run ${script}`,
};

const VALIDATION_SCRIPT_LABELS: Array<{ script: string; label: string }> = [
  { script: "typecheck", label: "Typecheck" },
  { script: "test", label: "Test" },
  { script: "lint", label: "Lint" },
  { script: "verify:fast", label: "Fast verify" },
];

export function getValidationCommandPresets(
  packageManager: ChatSessionWorkbenchPackageManager = "pnpm",
): ValidationCommandPreset[] {
  const format = PACKAGE_MANAGER_RUN_PREFIXES[packageManager];
  return VALIDATION_SCRIPT_LABELS.map(({ script, label }) => ({ label, command: format(script) }));
}

export function extractCodeBlocks(content: string): Array<{ id: string; language: string; content: string }> {
  return Array.from(content.matchAll(/```([\w.+-]*)\n([\s\S]*?)```/g))
    .map((match, index) => ({
      id: `code-block-${index}`,
      language: match[1]?.trim() || "text",
      content: (match[2] ?? "").trim(),
    }))
    .filter((block) => block.content.length > 0);
}

export function isPendingPatchBlock(block: { language: string; content: string }): boolean {
  const language = block.language.trim().toLowerCase();
  const content = block.content.trim();
  return (
    (language === "diff" || language === "patch") &&
    (content.startsWith("diff --git ") || /^---\s+\S+/m.test(content)) &&
    /^\+\+\+\s+\S+/m.test(content)
  );
}

export function validationStatusTone(status?: string | null): "success" | "warning" | "critical" {
  if (status === "passed") {
    return "success";
  }
  if (status === "failed") {
    return "critical";
  }
  return "warning";
}

export function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function formatShortHash(value?: string): string {
  return value ? shortId(value) : "missing";
}

export function formatOriginSurface(value?: CodeModeRunRecord["originSurface"]): string {
  if (value === "code") {
    return "Code";
  }
  if (value === "cowork") {
    return "Cowork";
  }
  if (value === "chat") {
    return "Chat";
  }
  return "not recorded";
}

export function formatRunTimestamp(value?: string): string {
  if (!value) {
    return "not recorded";
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export function formatSandboxPosture(value?: CodeModeRunRecord["sandbox"]): string {
  if (!value) {
    return "not recorded";
  }
  const failed = value.checksFailed.length ? ` · failed: ${value.checksFailed.join(", ")}` : "";
  const failClosed = value.failClosedReason ? ` · fail-closed: ${value.failClosedReason}` : "";
  const advisory = value.advisoryUnsandboxedReason ? ` · advisory: ${value.advisoryUnsandboxedReason}` : "";
  return `${value.isolationProfile} on ${value.platform} · ${
    value.required ? "required" : "not required"
  } · ${value.available ? "available" : "unavailable"}${failed}${failClosed}${advisory}`;
}

export function formatRunPermissionProfile(value: CodeModeRunRecord): string {
  const label = value.permissionProfileLabel?.trim();
  const id = value.permissionProfileId?.trim();
  if (label && id && label !== id) {
    return `${label} (${shortId(id)})`;
  }
  return label || id || "not recorded";
}

export function formatArtifactPath(value?: CodeModeRunRecord["codeArtifact"]): string {
  if (!value) {
    return "not recorded";
  }
  return `${value.relPath} · ${formatShortHash(value.sha256)}`;
}

export function describeAgenticControlCopy(control: AgenticControlItem): { buttonLabel: string; intentNote?: string } {
  if (control.runtimeEffect !== "state_only") {
    return { buttonLabel: control.title };
  }
  const actionLabel =
    control.action === "pause"
      ? "Record pause intent"
      : control.action === "kill_child"
        ? "Record kill intent"
        : `Record ${control.title.toLowerCase()} intent`;
  return {
    buttonLabel: actionLabel,
    intentNote: "State-only: records intent in GoatCitadel state; it is not a live pause or kill signal by itself.",
  };
}
