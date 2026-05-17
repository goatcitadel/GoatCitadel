# Operator UX Polish Implementation Plan

> Implementation-plan artifact only. This document may name proposed files, commands, tests, and runtime behavior; treat those as plan intent, not shipped 1.0 truth, unless the current implementation and release evidence prove them.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the operator-UX-polish bundle (O19 shell explainer, O17 bot-loop guard, operator diagnostics, plus follow-ups) in a single PR on the worktree branch.

**Architecture:** Three phases — O19 first (shell command explainer + contract/storage/UI + i18n + policy + doctor backfill), O17 second (participant-role inference + bot-loop guard + integration across 4 dispatch paths), diagnostics third (startup phases + stale session markers + plugin doctor rollup + supervisor handoff + sessions CLI). Pure parser lives in `packages/mission-control-shared`; gateway services in `apps/gateway/src/services/`; diagnostics in `apps/gateway/src/diagnostics/`.

**Tech Stack:** TypeScript, Vitest, Fastify, React, `shell-quote` (new dep), pino logger.

**Spec:** [docs/superpowers/specs/2026-05-15-operator-ux-polish-design.md](../specs/2026-05-15-operator-ux-polish-design.md)

**Original workstream label:** `goatrocity/zen-chatelet-e8461d`; historical plan metadata, not the current release branch.

---

## File Structure

### New files

```
packages/mission-control-shared/src/content/
  shell-command-explainer.ts          # pure parser, public API
  shell-command-explainer.test.ts
  shell-command-handlers.ts           # per-command handlers (split for file-size discipline)
  shell-command-handlers.test.ts
  shell-command-prescreen.ts          # string-level risk patterns
  shell-command-prescreen.test.ts
  i18n.ts                             # localization shim + English bundle
  i18n.test.ts

apps/gateway/src/services/
  shell-command-explainer.ts          # thin gateway re-export + storage hook
  shell-command-explainer.test.ts
  channel-participant-role.ts         # bot-vs-human inference
  channel-participant-role.test.ts
  channel-bot-loop-guard.ts           # per-pair rate cap + cooldown
  channel-bot-loop-guard.test.ts

apps/gateway/src/diagnostics/
  startup-phases.ts                   # phase recorder + snapshot
  startup-phases.test.ts
  stale-session-markers.ts            # generic stale-state computation
  stale-session-markers.test.ts

apps/mission-control-next/src/features/native-routes/ops/
  ShellExplanationList.tsx            # new component (extracted)
  ShellExplanationList.test.tsx
```

### Modified files

```
packages/contracts/src/approvals.ts
  + ShellRiskLevel, ShellRiskFinding, ShellExplanationDetail, ShellCommandExplanation types
  + ApprovalRequest.shellExplanations?: readonly ShellCommandExplanation[]

packages/storage/src/approval-repo.ts
  + ApprovalRow.shell_explanations_json
  + ApprovalRepository.setShellExplanations(approvalId, explanations): boolean
  + read path includes shell_explanations_json
  + sql migration

apps/gateway/src/config.ts
  + ShellExplainerPolicyConfig section
  + channelBotLoopGuard section

apps/gateway/src/app.ts
  + StartupPhaseRecorder wired through buildApp

apps/gateway/src/main.ts
  - (no direct changes; app.ts handles phases)

apps/gateway/src/services/channel-delivery-runtime-service.ts
  + bot-loop guard call site
  + computes shellExplanations on relevant approval creation
  + stale runtime state in diagnostics output

apps/gateway/src/services/channel-bot-live-probes.ts
  + bot-loop guard call site

apps/gateway/src/services/agentic-improvement-bridge-service.ts
  + bot-loop guard call site

apps/gateway/src/services/chat-agent-orchestrator.ts
  + bot-loop guard call site

apps/gateway/src/doctor/engine.ts
  + plugin rollup logic
  + approvals-shell-explanations-backfill check + repair
  + runtime-sessions stale check
  + supervisor-handoff surfacing

apps/gateway/src/dev-supervisor.ts
  + write supervisor-handoffs.jsonl on clean restart

apps/gateway/src/routes/sessions-list.ts
  + agentRuntime + harness fields surfaced

apps/gateway/src/tui/main.ts (and TUI helpers)
  + render runtime + harness columns

apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx
  + replace <ul mc-next-approvals-compact-list> with <ShellExplanationList />

apps/mission-control-next/src/features/native-routes/native-routes.css
  + mc-next-approvals-shell-* classes
```

### Test files referenced (existing, extended)

```
packages/contracts/src/approvals.test.ts            (extend if exists; else create)
packages/storage/src/approval-repo.test.ts
apps/gateway/src/doctor/engine.test.ts
apps/gateway/src/services/channel-delivery-runtime-service.test.ts
apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx
```

---

## Phase 1 — O19 Shell Command Explainer

### Task 1: Add `shell-quote` dependency to mission-control-shared

**Files:**
- Modify: `packages/mission-control-shared/package.json`
- Modify: `pnpm-lock.yaml` (regenerated)

- [ ] **Step 1: Inspect current dependencies**

Read `packages/mission-control-shared/package.json`. Confirm `shell-quote` is not present.

- [ ] **Step 2: Add the dependency**

Add to `dependencies`:

```json
"shell-quote": "^1.8.1"
```

Also add `@types/shell-quote` to `devDependencies`:

```json
"@types/shell-quote": "^1.7.5"
```

- [ ] **Step 3: Install**

Run: `pnpm install --filter @goatcitadel/mission-control-shared`
Expected: `+ shell-quote 1.8.x` and `+ @types/shell-quote 1.7.x` in output, lockfile updated.

- [ ] **Step 4: Confirm typecheck still passes**

Run: `pnpm --filter @goatcitadel/mission-control-shared typecheck`
Expected: exit code 0, no new errors.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/package.json pnpm-lock.yaml
git commit -m "feat(o19-explainer-shared): add shell-quote dependency"
```

---

### Task 2: i18n shim + English bundle

**Files:**
- Create: `packages/mission-control-shared/src/content/i18n.ts`
- Create: `packages/mission-control-shared/src/content/i18n.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mission-control-shared/src/content/i18n.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { t } from "./i18n.js";

describe("t", () => {
  it("returns English string for known key without params", () => {
    expect(t("shell.summary.empty")).toBe("Empty shell command");
  });

  it("interpolates params into a known key", () => {
    expect(t("shell.git_push.force_summary", { branch: "main", remote: "origin" })).toBe(
      "Force-push branch 'main' to remote 'origin'",
    );
  });

  it("returns the key itself when missing (fail-safe)", () => {
    // @ts-expect-error - intentionally passing an unknown key
    expect(t("shell.does_not_exist")).toBe("shell.does_not_exist");
  });

  it("ignores unused params", () => {
    expect(t("shell.summary.empty", { extra: "ignored" })).toBe("Empty shell command");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/i18n.test.ts`
Expected: FAIL — cannot find module `./i18n.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/mission-control-shared/src/content/i18n.ts`:

```typescript
type I18nParams = Readonly<Record<string, string | number>>;

type BundleEntry = (params: I18nParams) => string;

const ENGLISH: Readonly<Record<string, BundleEntry>> = Object.freeze({
  "shell.summary.empty": () => "Empty shell command",
  "shell.summary.unparsed": () => "Unparsed shell command",
  "shell.summary.generic": ({ program, count }) =>
    `Run ${program} with ${count} argument${count === 1 ? "" : "s"}`,

  "shell.action.git_push": () => "git push",
  "shell.action.git_reset": () => "git reset",
  "shell.action.rm": () => "rm",
  "shell.action.curl": () => "curl",
  "shell.action.wget": () => "wget",
  "shell.action.pnpm_install": () => "pnpm install",
  "shell.action.npm_install": () => "npm install",
  "shell.action.yarn_install": () => "yarn install",
  "shell.action.sudo": () => "sudo",
  "shell.action.chmod": () => "chmod",
  "shell.action.mv": () => "mv",
  "shell.action.ssh": () => "ssh",

  "shell.detail.action": () => "Action",
  "shell.detail.target": () => "Target",
  "shell.detail.force": () => "Force",
  "shell.detail.recursive": () => "Recursive",
  "shell.detail.url": () => "URL",
  "shell.detail.scope": () => "Scope",
  "shell.detail.flags": () => "Flags",
  "shell.detail.host": () => "Host",
  "shell.detail.mode": () => "Mode",
  "shell.detail.source": () => "Source",
  "shell.detail.destination": () => "Destination",

  "shell.git_push.force_summary": ({ branch, remote }) =>
    `Force-push branch '${branch}' to remote '${remote}'`,
  "shell.git_push.force_with_lease_summary": ({ branch, remote }) =>
    `Force-push (with lease) branch '${branch}' to remote '${remote}'`,
  "shell.git_push.normal_summary": ({ branch, remote }) =>
    `Push branch '${branch}' to remote '${remote}'`,
  "shell.git_reset.hard_summary": ({ target }) => `Discard work and reset to ${target}`,

  "shell.rm.recursive_summary": ({ target }) => `Recursively delete ${target}`,
  "shell.rm.root_summary": () => "Recursively delete from filesystem root",

  "shell.curl.pipe_summary": ({ url }) => `Download ${url} and execute as shell script`,
  "shell.curl.fetch_summary": ({ url }) => `Fetch ${url}`,

  "shell.pnpm.install_summary": () => "Install workspace dependencies",
  "shell.pnpm.add_summary": ({ packages }) => `Install npm package ${packages}`,

  "shell.ssh.summary": ({ host }) => `Open shell on ${host}`,
  "shell.chmod.summary": ({ mode, target }) => `Set permissions ${mode} on ${target}`,
  "shell.mv.summary": ({ source, destination }) => `Rename ${source} to ${destination}`,

  "shell.risk.force_push.label": () => "Force-push",
  "shell.risk.force_push.explanation": () => "rewrites remote branch history",
  "shell.risk.force_with_lease.label": () => "Force-push with lease",
  "shell.risk.force_with_lease.explanation": () =>
    "rewrites remote branch history; lease still allows destruction",
  "shell.risk.hard_reset.label": () => "Hard reset",
  "shell.risk.hard_reset.explanation": () => "discards uncommitted work",
  "shell.risk.recursive_delete.label": () => "Recursive delete",
  "shell.risk.recursive_delete.explanation": () => "deletes directories",
  "shell.risk.force_delete.label": () => "Force delete",
  "shell.risk.force_delete.explanation": () => "no confirmation, ignores missing",
  "shell.risk.filesystem_root.label": () => "Filesystem root",
  "shell.risk.filesystem_root.explanation": () => "deletes from filesystem root",
  "shell.risk.pipe_to_shell.label": () => "Pipe-to-shell",
  "shell.risk.pipe_to_shell.explanation": () =>
    "executes remote content as a shell script",
  "shell.risk.insecure_tls.label": () => "Skip TLS verification",
  "shell.risk.insecure_tls.explanation": () => "ignores certificate validity",
  "shell.risk.global_install.label": () => "Global install",
  "shell.risk.global_install.explanation": () => "modifies system-wide packages",
  "shell.risk.sudo.label": () => "Sudo",
  "shell.risk.sudo.explanation": () => "runs as root",
  "shell.risk.world_writable.label": () => "World-writable",
  "shell.risk.world_writable.explanation": () =>
    "any user can read, write, and execute",
  "shell.risk.system_path_write.label": () => "System path write",
  "shell.risk.system_path_write.explanation": () => "overwrites system file",
  "shell.risk.root_login.label": () => "Root login",
  "shell.risk.root_login.explanation": () => "interactive shell as root",
});

export type I18nKey = keyof typeof ENGLISH;

export function t(key: I18nKey, params: I18nParams = {}): string {
  const entry = ENGLISH[key];
  if (!entry) {
    return key;
  }
  return entry(params);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/i18n.test.ts`
Expected: PASS — all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/content/i18n.ts packages/mission-control-shared/src/content/i18n.test.ts
git commit -m "feat(o19-i18n): add localization shim with English bundle"
```

---

### Task 3: Shell-command pre-screen (string-level risk patterns)

**Files:**
- Create: `packages/mission-control-shared/src/content/shell-command-prescreen.ts`
- Create: `packages/mission-control-shared/src/content/shell-command-prescreen.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mission-control-shared/src/content/shell-command-prescreen.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { prescreenShellRisks } from "./shell-command-prescreen.js";

describe("prescreenShellRisks", () => {
  it("flags pipe-to-sh", () => {
    const risks = prescreenShellRisks("curl https://example.com | sh");
    expect(risks.some((r) => r.label === "Pipe-to-shell" && r.level === "danger")).toBe(true);
  });

  it("flags pipe-to-bash", () => {
    const risks = prescreenShellRisks("wget -qO- https://e.com | bash");
    expect(risks.some((r) => r.label === "Pipe-to-shell")).toBe(true);
  });

  it("flags sudo prefix", () => {
    const risks = prescreenShellRisks("sudo systemctl restart nginx");
    expect(risks.some((r) => r.label === "Sudo" && r.level === "caution")).toBe(true);
  });

  it("flags system path write (single >)", () => {
    const risks = prescreenShellRisks("echo hi > /etc/hosts");
    expect(risks.some((r) => r.label === "System path write" && r.level === "danger")).toBe(true);
  });

  it("flags system path append (>>)", () => {
    const risks = prescreenShellRisks("echo hi >> /usr/local/bin/foo");
    expect(risks.some((r) => r.label === "System path write")).toBe(true);
  });

  it("flags chmod 777", () => {
    const risks = prescreenShellRisks("chmod -R 777 /var/www");
    expect(risks.some((r) => r.label === "World-writable" && r.level === "caution")).toBe(true);
  });

  it("returns empty array for safe commands", () => {
    expect(prescreenShellRisks("pnpm install")).toEqual([]);
  });

  it("does not flag pipes that are not to sh/bash", () => {
    expect(prescreenShellRisks("ps aux | grep node")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/shell-command-prescreen.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `packages/mission-control-shared/src/content/shell-command-prescreen.ts`:

```typescript
import { t } from "./i18n.js";

export type ShellRiskLevel = "info" | "caution" | "danger";

export interface ShellRiskFinding {
  readonly level: ShellRiskLevel;
  readonly label: string;
  readonly explanation: string;
}

const SYSTEM_PATH_WRITE = /(^|\s)>{1,2}\s*\/(etc|usr|var|bin|sbin|boot|lib|lib64)(\/|\s|$)/;
const PIPE_TO_SHELL = /\|\s*(sh|bash)(\s|$)/;
const SUDO_PREFIX = /(^|\s)sudo(\s|$)/;
const CHMOD_WORLD = /\bchmod\b[^|;&]*\b777\b/;

export function prescreenShellRisks(command: string): readonly ShellRiskFinding[] {
  const findings: ShellRiskFinding[] = [];

  if (PIPE_TO_SHELL.test(command)) {
    findings.push({
      level: "danger",
      label: t("shell.risk.pipe_to_shell.label"),
      explanation: t("shell.risk.pipe_to_shell.explanation"),
    });
  }

  if (SUDO_PREFIX.test(command)) {
    findings.push({
      level: "caution",
      label: t("shell.risk.sudo.label"),
      explanation: t("shell.risk.sudo.explanation"),
    });
  }

  if (SYSTEM_PATH_WRITE.test(command)) {
    findings.push({
      level: "danger",
      label: t("shell.risk.system_path_write.label"),
      explanation: t("shell.risk.system_path_write.explanation"),
    });
  }

  if (CHMOD_WORLD.test(command)) {
    findings.push({
      level: "caution",
      label: t("shell.risk.world_writable.label"),
      explanation: t("shell.risk.world_writable.explanation"),
    });
  }

  return findings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/shell-command-prescreen.test.ts`
Expected: PASS — all 8 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/content/shell-command-prescreen.ts packages/mission-control-shared/src/content/shell-command-prescreen.test.ts
git commit -m "feat(o19-explainer-shared): pre-screen for string-level shell risks"
```

---

### Task 4: Per-command handlers (git, rm, curl, wget, pnpm, npm, yarn, ssh, chmod, mv, generic)

**Files:**
- Create: `packages/mission-control-shared/src/content/shell-command-handlers.ts`
- Create: `packages/mission-control-shared/src/content/shell-command-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mission-control-shared/src/content/shell-command-handlers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { handleCommand } from "./shell-command-handlers.js";

describe("handleCommand: git", () => {
  it("decodes git push --force origin main", () => {
    const r = handleCommand(["git", "push", "--force", "origin", "main"]);
    expect(r.program).toBe("git");
    expect(r.summary).toContain("Force-push");
    expect(r.summary).toContain("main");
    expect(r.summary).toContain("origin");
    expect(r.details.some((d) => d.label === "Force" && d.value === "true")).toBe(true);
    expect(r.risks.some((x) => x.label === "Force-push")).toBe(true);
  });

  it("decodes git push --force-with-lease distinctly", () => {
    const r = handleCommand(["git", "push", "--force-with-lease", "origin", "main"]);
    expect(r.summary).toContain("with lease");
    expect(r.risks.some((x) => x.label === "Force-push with lease")).toBe(true);
  });

  it("decodes plain git push without force risk", () => {
    const r = handleCommand(["git", "push", "origin", "main"]);
    expect(r.risks.find((x) => x.label === "Force-push")).toBeUndefined();
  });

  it("flags git reset --hard", () => {
    const r = handleCommand(["git", "reset", "--hard", "HEAD~1"]);
    expect(r.risks.some((x) => x.label === "Hard reset")).toBe(true);
  });
});

describe("handleCommand: rm", () => {
  it("decodes rm -rf with target", () => {
    const r = handleCommand(["rm", "-rf", "/tmp/test"]);
    expect(r.details.some((d) => d.label === "Recursive" && d.value === "true")).toBe(true);
    expect(r.details.some((d) => d.label === "Force" && d.value === "true")).toBe(true);
    expect(r.details.some((d) => d.label === "Target" && d.value === "/tmp/test")).toBe(true);
    expect(r.risks.some((x) => x.label === "Recursive delete")).toBe(true);
  });

  it("flags rm -rf / with filesystem-root finding", () => {
    const r = handleCommand(["rm", "-rf", "/"]);
    expect(r.risks.some((x) => x.label === "Filesystem root")).toBe(true);
  });

  it("accepts combined and split flag forms", () => {
    const r1 = handleCommand(["rm", "-rf", "x"]);
    const r2 = handleCommand(["rm", "-r", "-f", "x"]);
    const r3 = handleCommand(["rm", "-fr", "x"]);
    for (const r of [r1, r2, r3]) {
      expect(r.details.some((d) => d.label === "Recursive")).toBe(true);
      expect(r.details.some((d) => d.label === "Force")).toBe(true);
    }
  });
});

describe("handleCommand: curl", () => {
  it("flags -k insecure", () => {
    const r = handleCommand(["curl", "-k", "https://e.com"]);
    expect(r.risks.some((x) => x.label === "Skip TLS verification")).toBe(true);
  });

  it("extracts URL into details", () => {
    const r = handleCommand(["curl", "https://example.com/x"]);
    expect(r.details.some((d) => d.label === "URL" && d.value === "https://example.com/x")).toBe(true);
  });
});

describe("handleCommand: pnpm", () => {
  it("recognizes pnpm install with no args as workspace install", () => {
    const r = handleCommand(["pnpm", "install"]);
    expect(r.summary).toContain("workspace dependencies");
    expect(r.risks).toEqual([]);
  });

  it("flags pnpm add --global as caution", () => {
    const r = handleCommand(["pnpm", "add", "lodash", "--global"]);
    expect(r.risks.some((x) => x.label === "Global install")).toBe(true);
  });
});

describe("handleCommand: ssh", () => {
  it("flags root login", () => {
    const r = handleCommand(["ssh", "root@host"]);
    expect(r.risks.some((x) => x.label === "Root login")).toBe(true);
  });
});

describe("handleCommand: generic fallback", () => {
  it("returns Action/Args for unknown program", () => {
    const r = handleCommand(["my-tool", "--flag", "value"]);
    expect(r.program).toBe("my-tool");
    expect(r.summary).toContain("Run my-tool");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/shell-command-handlers.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `packages/mission-control-shared/src/content/shell-command-handlers.ts`:

```typescript
import { t } from "./i18n.js";
import type { ShellRiskFinding, ShellRiskLevel } from "./shell-command-prescreen.js";

export interface ShellExplanationDetail {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly noteLevel?: ShellRiskLevel;
}

export interface HandlerResult {
  readonly program: string;
  readonly summary: string;
  readonly details: readonly ShellExplanationDetail[];
  readonly risks: readonly ShellRiskFinding[];
}

type Tokens = readonly string[];
type Handler = (tokens: Tokens) => HandlerResult;

function isFlag(token: string): boolean {
  return token.startsWith("-");
}

function nonFlagTokens(tokens: Tokens): string[] {
  return tokens.filter((t) => !isFlag(t));
}

function findFlag(tokens: Tokens, ...candidates: string[]): boolean {
  return tokens.some((tk) => candidates.includes(tk));
}

function findCombinedShortFlag(tokens: Tokens, char: string): boolean {
  return tokens.some((tk) => /^-[a-zA-Z]+$/.test(tk) && tk.includes(char));
}

function risk(level: ShellRiskLevel, labelKey: string, explanationKey: string): ShellRiskFinding {
  return {
    level,
    label: t(labelKey as never),
    explanation: t(explanationKey as never),
  };
}

const gitPush: Handler = (tokens) => {
  const flagsAfter = tokens.slice(2);
  const force = findFlag(flagsAfter, "--force", "-f");
  const forceLease = findFlag(flagsAfter, "--force-with-lease");
  const positional = nonFlagTokens(flagsAfter);
  const remote = positional[0] ?? "origin";
  const branch = positional[1] ?? "current branch";

  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: t("shell.action.git_push") },
    { label: t("shell.detail.target"), value: `branch '${branch}' on remote '${remote}'` },
  ];
  if (forceLease) {
    details.push({
      label: t("shell.detail.force"),
      value: "true",
      note: t("shell.risk.force_with_lease.explanation"),
      noteLevel: "danger",
    });
  } else if (force) {
    details.push({
      label: t("shell.detail.force"),
      value: "true",
      note: t("shell.risk.force_push.explanation"),
      noteLevel: "danger",
    });
  }

  const risks: ShellRiskFinding[] = [];
  if (forceLease) {
    risks.push(risk("danger", "shell.risk.force_with_lease.label", "shell.risk.force_with_lease.explanation"));
  } else if (force) {
    risks.push(risk("danger", "shell.risk.force_push.label", "shell.risk.force_push.explanation"));
  }

  const summaryKey = forceLease
    ? "shell.git_push.force_with_lease_summary"
    : force
      ? "shell.git_push.force_summary"
      : "shell.git_push.normal_summary";
  return {
    program: "git",
    summary: t(summaryKey as never, { branch, remote }),
    details,
    risks,
  };
};

const gitReset: Handler = (tokens) => {
  const flagsAfter = tokens.slice(2);
  const hard = findFlag(flagsAfter, "--hard");
  const positional = nonFlagTokens(flagsAfter);
  const target = positional[0] ?? "HEAD";
  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: t("shell.action.git_reset") },
    { label: t("shell.detail.target"), value: target },
  ];
  const risks: ShellRiskFinding[] = [];
  if (hard) {
    details.push({
      label: "Mode",
      value: "--hard",
      note: t("shell.risk.hard_reset.explanation"),
      noteLevel: "danger",
    });
    risks.push(risk("danger", "shell.risk.hard_reset.label", "shell.risk.hard_reset.explanation"));
  }
  return {
    program: "git",
    summary: hard ? t("shell.git_reset.hard_summary", { target }) : `git reset to ${target}`,
    details,
    risks,
  };
};

const git: Handler = (tokens) => {
  const sub = tokens[1];
  if (sub === "push") return gitPush(tokens);
  if (sub === "reset") return gitReset(tokens);
  // generic fallback for other git subcommands
  return genericGit(tokens);
};

const genericGit: Handler = (tokens) => ({
  program: "git",
  summary: `git ${tokens.slice(1).join(" ")}`,
  details: [{ label: t("shell.detail.action"), value: `git ${tokens[1] ?? ""}`.trim() }],
  risks: [],
});

const rm: Handler = (tokens) => {
  const after = tokens.slice(1);
  const recursive =
    findFlag(after, "-r", "-R", "--recursive") ||
    findCombinedShortFlag(after, "r") ||
    findCombinedShortFlag(after, "R");
  const force =
    findFlag(after, "-f", "--force") || findCombinedShortFlag(after, "f");
  const targets = nonFlagTokens(after);

  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: t("shell.action.rm") },
  ];
  const risks: ShellRiskFinding[] = [];
  if (recursive) {
    details.push({
      label: t("shell.detail.recursive"),
      value: "true",
      note: t("shell.risk.recursive_delete.explanation"),
      noteLevel: "danger",
    });
    risks.push(risk("danger", "shell.risk.recursive_delete.label", "shell.risk.recursive_delete.explanation"));
  }
  if (force) {
    details.push({
      label: t("shell.detail.force"),
      value: "true",
      note: t("shell.risk.force_delete.explanation"),
      noteLevel: "danger",
    });
    risks.push(risk("danger", "shell.risk.force_delete.label", "shell.risk.force_delete.explanation"));
  }
  for (const target of targets) {
    details.push({ label: t("shell.detail.target"), value: target });
    if (target === "/") {
      risks.push(risk("danger", "shell.risk.filesystem_root.label", "shell.risk.filesystem_root.explanation"));
    }
  }

  const summary = recursive
    ? targets[0] === "/"
      ? t("shell.rm.root_summary")
      : t("shell.rm.recursive_summary", { target: targets.join(" ") || "(no target)" })
    : `Delete ${targets.join(" ") || "(no target)"}`;

  return { program: "rm", summary, details, risks };
};

const curlOrWget: Handler = (tokens) => {
  const program = tokens[0];
  const after = tokens.slice(1);
  const insecure = findFlag(after, "-k", "--insecure");
  const url = after.find((tk) => /^https?:\/\//.test(tk)) ?? "(no URL)";
  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: program },
    { label: t("shell.detail.url"), value: url },
  ];
  const risks: ShellRiskFinding[] = [];
  if (insecure) {
    risks.push(risk("caution", "shell.risk.insecure_tls.label", "shell.risk.insecure_tls.explanation"));
  }
  return {
    program,
    summary: t("shell.curl.fetch_summary", { url }),
    details,
    risks,
  };
};

const packageManager: Handler = (tokens) => {
  const program = tokens[0];
  const sub = tokens[1];
  const after = tokens.slice(2);
  const global = findFlag(after, "--global", "-g");
  const positional = nonFlagTokens(after);

  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: `${program} ${sub ?? ""}`.trim() },
  ];
  const risks: ShellRiskFinding[] = [];

  if (sub === "install" && positional.length === 0) {
    return {
      program,
      summary: t("shell.pnpm.install_summary"),
      details: [
        ...details,
        { label: t("shell.detail.scope"), value: "all workspace dependencies (no package args)" },
      ],
      risks,
    };
  }
  if (sub === "add" || (sub === "install" && positional.length > 0)) {
    if (global) {
      risks.push(risk("caution", "shell.risk.global_install.label", "shell.risk.global_install.explanation"));
      details.push({
        label: t("shell.detail.scope"),
        value: "global",
        note: t("shell.risk.global_install.explanation"),
        noteLevel: "caution",
      });
    }
    return {
      program,
      summary: t("shell.pnpm.add_summary", { packages: positional.join(", ") }),
      details,
      risks,
    };
  }

  return {
    program,
    summary: `Run ${program} ${tokens.slice(1).join(" ")}`,
    details,
    risks,
  };
};

const ssh: Handler = (tokens) => {
  const after = tokens.slice(1);
  const target = after.find((tk) => !isFlag(tk)) ?? "(no host)";
  const isRoot = target.startsWith("root@");
  const risks: ShellRiskFinding[] = [];
  if (isRoot) {
    risks.push(risk("caution", "shell.risk.root_login.label", "shell.risk.root_login.explanation"));
  }
  return {
    program: "ssh",
    summary: t("shell.ssh.summary", { host: target }),
    details: [
      { label: t("shell.detail.action"), value: t("shell.action.ssh") },
      { label: t("shell.detail.host"), value: target },
    ],
    risks,
  };
};

const chmod: Handler = (tokens) => {
  const after = tokens.slice(1);
  const positional = nonFlagTokens(after);
  const mode = positional[0] ?? "(no mode)";
  const target = positional.slice(1).join(" ") || "(no target)";
  return {
    program: "chmod",
    summary: t("shell.chmod.summary", { mode, target }),
    details: [
      { label: t("shell.detail.action"), value: t("shell.action.chmod") },
      { label: t("shell.detail.mode"), value: mode },
      { label: t("shell.detail.target"), value: target },
    ],
    risks: [],
  };
};

const mv: Handler = (tokens) => {
  const after = tokens.slice(1);
  const positional = nonFlagTokens(after);
  const [source, destination] = [positional[0] ?? "(no source)", positional[1] ?? "(no destination)"];
  return {
    program: "mv",
    summary: t("shell.mv.summary", { source, destination }),
    details: [
      { label: t("shell.detail.action"), value: t("shell.action.mv") },
      { label: t("shell.detail.source"), value: source },
      { label: t("shell.detail.destination"), value: destination },
    ],
    risks: [],
  };
};

const generic: Handler = (tokens) => {
  const program = tokens[0] ?? "";
  const args = tokens.slice(1);
  return {
    program,
    summary: t("shell.summary.generic", { program, count: args.length }),
    details: [
      { label: t("shell.detail.action"), value: program },
      ...(args.length > 0 ? [{ label: t("shell.detail.flags"), value: args.join(" ") }] : []),
    ],
    risks: [],
  };
};

const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze({
  git,
  rm,
  curl: curlOrWget,
  wget: curlOrWget,
  npm: packageManager,
  pnpm: packageManager,
  yarn: packageManager,
  ssh,
  chmod,
  mv,
});

export function handleCommand(tokens: readonly string[]): HandlerResult {
  if (tokens.length === 0) {
    return generic(tokens);
  }
  const program = tokens[0];
  const handler = HANDLERS[program] ?? generic;
  return handler(tokens);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/shell-command-handlers.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/content/shell-command-handlers.ts packages/mission-control-shared/src/content/shell-command-handlers.test.ts
git commit -m "feat(o19-explainer-shared): per-command handlers for git/rm/curl/pkg/ssh/chmod/mv"
```

---

### Task 5: `explainShellCommand` orchestrator + full data model

**Files:**
- Create: `packages/mission-control-shared/src/content/shell-command-explainer.ts`
- Create: `packages/mission-control-shared/src/content/shell-command-explainer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mission-control-shared/src/content/shell-command-explainer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { explainShellCommand } from "./shell-command-explainer.js";

describe("explainShellCommand — verification cases", () => {
  it("git push --force origin main → danger, force-push detail", () => {
    const r = explainShellCommand("git push --force origin main");
    expect(r.parsed).toBe(true);
    expect(r.highestRisk).toBe("danger");
    expect(r.summary).toMatch(/force-push/i);
    expect(r.details.some((d) => d.label === "Force")).toBe(true);
    expect(r.risks.some((x) => x.label === "Force-push")).toBe(true);
  });

  it("rm -rf /tmp/test → danger", () => {
    const r = explainShellCommand("rm -rf /tmp/test");
    expect(r.highestRisk).toBe("danger");
    expect(r.details.some((d) => d.label === "Recursive")).toBe(true);
    expect(r.details.some((d) => d.label === "Force")).toBe(true);
    expect(r.details.some((d) => d.label === "Target" && d.value === "/tmp/test")).toBe(true);
  });

  it("curl https://example.com | sh → danger pipe-to-shell, URL extracted", () => {
    const r = explainShellCommand("curl https://example.com | sh");
    expect(r.highestRisk).toBe("danger");
    expect(r.risks.some((x) => x.label === "Pipe-to-shell")).toBe(true);
    expect(r.details.some((d) => d.label === "URL" && d.value === "https://example.com")).toBe(true);
  });

  it("pnpm install → info, workspace dependencies", () => {
    const r = explainShellCommand("pnpm install");
    expect(r.highestRisk).toBe("info");
    expect(r.summary).toMatch(/workspace dependencies/i);
    expect(r.risks).toEqual([]);
  });
});

describe("explainShellCommand — extra cases", () => {
  it("git push --force-with-lease origin main → danger w/ lease distinction", () => {
    const r = explainShellCommand("git push --force-with-lease origin main");
    expect(r.summary).toContain("with lease");
    expect(r.risks.some((x) => x.label === "Force-push with lease")).toBe(true);
  });

  it("git push origin main → info, no force", () => {
    const r = explainShellCommand("git push origin main");
    expect(r.highestRisk).toBe("info");
  });

  it("git reset --hard HEAD~1 → danger hard-reset", () => {
    const r = explainShellCommand("git reset --hard HEAD~1");
    expect(r.highestRisk).toBe("danger");
  });

  it("rm -rf / → filesystem-root finding", () => {
    const r = explainShellCommand("rm -rf /");
    expect(r.risks.some((x) => x.label === "Filesystem root")).toBe(true);
  });

  it("curl -k https://example.com → caution insecure", () => {
    const r = explainShellCommand("curl -k https://example.com");
    expect(r.highestRisk).toBe("caution");
  });

  it("pnpm add lodash --global → caution global", () => {
    const r = explainShellCommand("pnpm add lodash --global");
    expect(r.highestRisk).toBe("caution");
  });

  it("sudo systemctl restart nginx → caution sudo", () => {
    const r = explainShellCommand("sudo systemctl restart nginx");
    expect(r.highestRisk).toBe("caution");
    expect(r.risks.some((x) => x.label === "Sudo")).toBe(true);
  });

  it("echo hi > /etc/hosts → danger system-path-write", () => {
    const r = explainShellCommand("echo hi > /etc/hosts");
    expect(r.highestRisk).toBe("danger");
    expect(r.risks.some((x) => x.label === "System path write")).toBe(true);
  });

  it("chmod -R 777 /var/www → caution world-writable", () => {
    const r = explainShellCommand("chmod -R 777 /var/www");
    expect(r.highestRisk).toBe("caution");
  });

  it("empty string → parsed:false, empty", () => {
    const r = explainShellCommand("");
    expect(r.parsed).toBe(false);
    expect(r.summary).toMatch(/empty/i);
    expect(r.risks).toEqual([]);
  });

  it("unmatched quote → parsed:false fallback", () => {
    const r = explainShellCommand('git commit -m "oops');
    expect(r.parsed).toBe(false);
    expect(r.command).toBe('git commit -m "oops');
  });

  it("generic fallback for unknown program", () => {
    const r = explainShellCommand("unknown-cmd --foo bar");
    expect(r.parsed).toBe(true);
    expect(r.program).toBe("unknown-cmd");
    expect(r.summary).toMatch(/Run unknown-cmd with 2 argument/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/shell-command-explainer.test.ts`
Expected: FAIL — cannot find module `./shell-command-explainer.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/mission-control-shared/src/content/shell-command-explainer.ts`:

```typescript
import { parse as shellParse } from "shell-quote";
import { t } from "./i18n.js";
import { handleCommand } from "./shell-command-handlers.js";
import {
  prescreenShellRisks,
  type ShellRiskFinding,
  type ShellRiskLevel,
} from "./shell-command-prescreen.js";

export type { ShellRiskFinding, ShellRiskLevel } from "./shell-command-prescreen.js";
export type { ShellExplanationDetail } from "./shell-command-handlers.js";

export interface ShellCommandExplanation {
  readonly command: string;
  readonly parsed: boolean;
  readonly program?: string;
  readonly summary: string;
  readonly details: readonly import("./shell-command-handlers.js").ShellExplanationDetail[];
  readonly risks: readonly ShellRiskFinding[];
  readonly highestRisk: ShellRiskLevel;
}

const RISK_ORDER: ShellRiskLevel[] = ["info", "caution", "danger"];

function highest(risks: readonly ShellRiskFinding[]): ShellRiskLevel {
  let best: ShellRiskLevel = "info";
  for (const r of risks) {
    if (RISK_ORDER.indexOf(r.level) > RISK_ORDER.indexOf(best)) {
      best = r.level;
    }
  }
  return best;
}

function dedupeRisks(risks: readonly ShellRiskFinding[]): ShellRiskFinding[] {
  const seen = new Set<string>();
  const out: ShellRiskFinding[] = [];
  for (const r of risks) {
    const key = `${r.level}:${r.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function tokenize(command: string): readonly string[] | undefined {
  try {
    const parsed = shellParse(command);
    const tokens: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        tokens.push(item);
      } else {
        // operator object — stop tokenizing the head command at operators
        break;
      }
    }
    return tokens;
  } catch {
    return undefined;
  }
}

export function explainShellCommand(command: string): ShellCommandExplanation {
  const preRisks = prescreenShellRisks(command);

  if (command.trim().length === 0) {
    return {
      command,
      parsed: false,
      summary: t("shell.summary.empty"),
      details: [],
      risks: [],
      highestRisk: "info",
    };
  }

  const tokens = tokenize(command);
  if (!tokens || tokens.length === 0) {
    const risks = dedupeRisks(preRisks);
    return {
      command,
      parsed: false,
      summary: t("shell.summary.unparsed"),
      details: [],
      risks,
      highestRisk: highest(risks),
    };
  }

  const handled = handleCommand(tokens);
  const allRisks = dedupeRisks([...handled.risks, ...preRisks]);

  return {
    command,
    parsed: true,
    program: handled.program,
    summary: handled.summary,
    details: handled.details,
    risks: allRisks,
    highestRisk: highest(allRisks),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/shell-command-explainer.test.ts`
Expected: PASS — all 16 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/content/shell-command-explainer.ts packages/mission-control-shared/src/content/shell-command-explainer.test.ts
git commit -m "feat(o19-explainer-shared): explainShellCommand orchestrator with 16 cases"
```

---

### Task 6: Export the explainer from the package barrel

**Files:**
- Modify: `packages/mission-control-shared/src/index.ts` (read it first)

- [ ] **Step 1: Read existing barrel**

Run: `cat packages/mission-control-shared/src/index.ts`
Look for the pattern used for exporting `content/approval-helpers`.

- [ ] **Step 2: Add the export**

Append to the barrel (or in alphabetical order with sibling content exports):

```typescript
export {
  explainShellCommand,
  type ShellCommandExplanation,
  type ShellExplanationDetail,
  type ShellRiskFinding,
  type ShellRiskLevel,
} from "./content/shell-command-explainer.js";
```

- [ ] **Step 3: Confirm consumers can import**

Run: `pnpm --filter @goatcitadel/mission-control-shared typecheck`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add packages/mission-control-shared/src/index.ts
git commit -m "feat(o19-explainer-shared): export explainer from package barrel"
```

---

### Task 7: Gateway wrapper service

**Files:**
- Create: `apps/gateway/src/services/shell-command-explainer.ts`
- Create: `apps/gateway/src/services/shell-command-explainer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/services/shell-command-explainer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { explainCommandsForApproval } from "./shell-command-explainer.js";

describe("explainCommandsForApproval", () => {
  it("returns explanations matching the shared parser", () => {
    const out = explainCommandsForApproval(["git push --force origin main", "pnpm install"]);
    expect(out).toHaveLength(2);
    expect(out[0].highestRisk).toBe("danger");
    expect(out[1].highestRisk).toBe("info");
  });

  it("returns empty array for empty input", () => {
    expect(explainCommandsForApproval([])).toEqual([]);
  });

  it("preserves command order", () => {
    const out = explainCommandsForApproval(["pnpm install", "rm -rf /tmp/x"]);
    expect(out[0].command).toBe("pnpm install");
    expect(out[1].command).toBe("rm -rf /tmp/x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/shell-command-explainer.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `apps/gateway/src/services/shell-command-explainer.ts`:

```typescript
import {
  explainShellCommand,
  type ShellCommandExplanation,
} from "@goatcitadel/mission-control-shared";

export {
  explainShellCommand,
  type ShellCommandExplanation,
  type ShellExplanationDetail,
  type ShellRiskFinding,
  type ShellRiskLevel,
} from "@goatcitadel/mission-control-shared";

export function explainCommandsForApproval(
  commands: readonly string[],
): readonly ShellCommandExplanation[] {
  return commands.map((cmd) => explainShellCommand(cmd));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/shell-command-explainer.test.ts`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/shell-command-explainer.ts apps/gateway/src/services/shell-command-explainer.test.ts
git commit -m "feat(o19-explainer-gateway): gateway wrapper for batch approval explainer"
```

---

### Task 8: Contract field — `ApprovalRequest.shellExplanations`

**Files:**
- Modify: `packages/contracts/src/approvals.ts` (after line 60, before `ApprovalCreateInput`)
- Test: `packages/contracts/src/approvals.test.ts` (create if absent)

- [ ] **Step 1: Read current approvals.ts**

Run: `head -65 packages/contracts/src/approvals.ts`. Confirm `ApprovalRequest` ends at line 60.

- [ ] **Step 2: Write failing type test**

Create or extend `packages/contracts/src/approvals.test.ts`:

```typescript
import { describe, expectTypeOf, it } from "vitest";
import type { ApprovalRequest, ShellCommandExplanation } from "./index.js";

describe("ApprovalRequest types", () => {
  it("has optional readonly shellExplanations array", () => {
    expectTypeOf<ApprovalRequest["shellExplanations"]>().toEqualTypeOf<
      readonly ShellCommandExplanation[] | undefined
    >();
  });

  it("ShellCommandExplanation has command and highestRisk fields", () => {
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("command");
    expectTypeOf<ShellCommandExplanation>().toHaveProperty("highestRisk");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/contracts vitest run src/approvals.test.ts`
Expected: FAIL — `ShellCommandExplanation` not exported.

- [ ] **Step 4: Add the types and field**

In `packages/contracts/src/approvals.ts`, add these types above `ApprovalRequest`:

```typescript
export type ShellRiskLevel = "info" | "caution" | "danger";

export interface ShellRiskFinding {
  readonly level: ShellRiskLevel;
  readonly label: string;
  readonly explanation: string;
}

export interface ShellExplanationDetail {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly noteLevel?: ShellRiskLevel;
}

export interface ShellCommandExplanation {
  readonly command: string;
  readonly parsed: boolean;
  readonly program?: string;
  readonly summary: string;
  readonly details: readonly ShellExplanationDetail[];
  readonly risks: readonly ShellRiskFinding[];
  readonly highestRisk: ShellRiskLevel;
}
```

Modify `ApprovalRequest` to add the field (insert before the closing `}`):

```typescript
  shellExplanations?: readonly ShellCommandExplanation[];
```

- [ ] **Step 5: Ensure `index.ts` re-exports the new types**

Run: `grep -n "approvals" packages/contracts/src/index.ts`. If `export * from "./approvals.js"` exists, no change needed. Else add it.

- [ ] **Step 6: Update `mission-control-shared` to reuse contract types instead of its own**

Modify `packages/mission-control-shared/src/content/shell-command-explainer.ts` and the handlers/prescreen files: replace the local `ShellCommandExplanation`, `ShellRiskFinding`, `ShellExplanationDetail`, `ShellRiskLevel` types with re-imports from `@goatcitadel/contracts`. This avoids the two packages defining structurally-identical-but-distinct types.

```typescript
import type {
  ShellCommandExplanation,
  ShellExplanationDetail,
  ShellRiskFinding,
  ShellRiskLevel,
} from "@goatcitadel/contracts";

export type {
  ShellCommandExplanation,
  ShellExplanationDetail,
  ShellRiskFinding,
  ShellRiskLevel,
} from "@goatcitadel/contracts";
```

Adjust the same in `shell-command-handlers.ts` and `shell-command-prescreen.ts`.

- [ ] **Step 7: Run all affected tests**

Run: `pnpm --filter @goatcitadel/contracts vitest run` and `pnpm --filter @goatcitadel/mission-control-shared vitest run src/content/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/approvals.ts packages/contracts/src/approvals.test.ts packages/mission-control-shared/src/content/shell-command-explainer.ts packages/mission-control-shared/src/content/shell-command-handlers.ts packages/mission-control-shared/src/content/shell-command-prescreen.ts
git commit -m "feat(o19-contracts): add ShellCommandExplanation type + ApprovalRequest.shellExplanations"
```

---

### Task 9: Storage mutator — `setShellExplanations`

**Files:**
- Modify: `packages/storage/src/approval-repo.ts`
- Modify: storage SQL schema (find it via `grep -r "CREATE TABLE approvals" packages/storage/`)
- Modify: `packages/storage/src/approval-repo.test.ts`

- [ ] **Step 1: Locate the schema file**

Run: `grep -r "CREATE TABLE approvals" packages/storage/src/`. Capture the file path; it should contain a `CREATE TABLE approvals (...)` statement.

- [ ] **Step 2: Add the column to the schema**

In the schema file, add `shell_explanations_json TEXT` to the `approvals` table definition. If the file uses migrations, create a new migration adding the column rather than mutating the original CREATE.

- [ ] **Step 3: Write the failing repo test**

Add to `packages/storage/src/approval-repo.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ApprovalRepository } from "./approval-repo.js";
import { openTestDb } from "./test-helpers.js"; // use whatever existing helper opens an in-memory DB

describe("ApprovalRepository.setShellExplanations", () => {
  it("persists explanations and round-trips on read", () => {
    const db = openTestDb();
    const repo = new ApprovalRepository(db);
    const approval = repo.create({
      kind: "shell.run",
      riskLevel: "caution",
      payload: { commands: ["rm -rf /tmp/x"] },
      preview: { commands: ["rm -rf /tmp/x"] },
    });

    const updated = repo.setShellExplanations(approval.approvalId, [
      {
        command: "rm -rf /tmp/x",
        parsed: true,
        program: "rm",
        summary: "Recursively delete /tmp/x",
        details: [],
        risks: [{ level: "danger", label: "Recursive delete", explanation: "deletes directories" }],
        highestRisk: "danger",
      },
    ]);
    expect(updated).toBe(true);

    const fetched = repo.get(approval.approvalId);
    expect(fetched?.shellExplanations).toHaveLength(1);
    expect(fetched?.shellExplanations?.[0].highestRisk).toBe("danger");
  });

  it("returns false for unknown approval id", () => {
    const db = openTestDb();
    const repo = new ApprovalRepository(db);
    expect(repo.setShellExplanations("missing", [])).toBe(false);
  });
});
```

If `openTestDb` does not exist under that name, find the existing test helper in `packages/storage/src/` (likely something like `createInMemoryDatabase`, `openMemoryDb`, or test setup inside the existing approval-repo.test.ts) and reuse that pattern.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @goatcitadel/storage vitest run src/approval-repo.test.ts`
Expected: FAIL — `setShellExplanations` does not exist OR column does not exist.

- [ ] **Step 5: Implement the mutator**

In `packages/storage/src/approval-repo.ts`:

1. Add a new prepared statement in the constructor:
```typescript
this.setShellExplanationsStmt = db.prepare(`
  UPDATE approvals SET shell_explanations_json = @shellExplanationsJson
  WHERE approval_id = @approvalId
`);
```

2. Add the field to `ApprovalRow`:
```typescript
shell_explanations_json: string | null;
```

3. Add the public method:
```typescript
public setShellExplanations(
  approvalId: string,
  explanations: readonly ShellCommandExplanation[],
): boolean {
  const result = this.setShellExplanationsStmt.run({
    approvalId,
    shellExplanationsJson: JSON.stringify(explanations),
  });
  return result.changes > 0;
}
```

4. In the existing row→record mapping (search for `payload_json` to find the function), parse `shell_explanations_json` and add to the returned `ApprovalRequest`:
```typescript
shellExplanations: row.shell_explanations_json
  ? (safeJsonParse(row.shell_explanations_json) as ShellCommandExplanation[])
  : undefined,
```

5. Import `ShellCommandExplanation` at the top.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @goatcitadel/storage vitest run src/approval-repo.test.ts`
Expected: PASS — both cases green.

- [ ] **Step 7: Commit**

```bash
git add packages/storage/src/approval-repo.ts packages/storage/src/approval-repo.test.ts packages/storage/src/<schema-file>
git commit -m "feat(o19-storage): persist ShellCommandExplanation[] on approvals"
```

---

### Task 10: Wire explainer into approval creation + policy gating

**Files:**
- Modify: `apps/gateway/src/config.ts` (add `ShellExplainerPolicyConfig`)
- Modify: gateway approval creation flow (find via `grep -r "storage.approvals.create" apps/gateway/src/`)
- Test: appropriate existing test in `apps/gateway/src/services/`

- [ ] **Step 1: Locate approval creation call sites**

Run: `grep -rn "storage.approvals.create\|approvals\.create(" apps/gateway/src/`. Identify the central wrapper (likely in a service like `approval-lifecycle-service.ts` or `approval-runtime-service.ts`).

- [ ] **Step 2: Read the central wrapper**

Read the file. Find where the approval is created and the input payload is shaped.

- [ ] **Step 3: Add policy config schema**

In `apps/gateway/src/config.ts`, add (alongside existing `ApprovalExplainerConfig`):

```typescript
export interface ShellExplainerPolicyConfig {
  enabled: boolean;
  elevateOnDanger?: "caution" | "danger" | "nuclear";
  autoRejectOnDanger?: boolean;
}

export const DEFAULT_SHELL_EXPLAINER_POLICY: ShellExplainerPolicyConfig = {
  enabled: true,
  elevateOnDanger: "danger",
  autoRejectOnDanger: false,
};
```

Add a `shellExplainerPolicy: ShellExplainerPolicyConfig` field to whatever the top-level config shape is, defaulting to `DEFAULT_SHELL_EXPLAINER_POLICY`.

- [ ] **Step 4: Write failing test**

In the approval-lifecycle-service test (e.g. `approval-lifecycle-service.test.ts`), add a case:

```typescript
it("computes shellExplanations and elevates riskLevel when policy is on", () => {
  const service = makeServiceWithPolicy({ enabled: true, elevateOnDanger: "danger" });
  const approval = service.createApproval({
    kind: "shell.run",
    riskLevel: "safe",
    payload: { commands: ["rm -rf /tmp/x"] },
    preview: { commands: ["rm -rf /tmp/x"] },
  });
  expect(approval.shellExplanations).toHaveLength(1);
  expect(approval.shellExplanations?.[0].highestRisk).toBe("danger");
  expect(approval.riskLevel).toBe("danger");
});

it("does NOT elevate when policy is off", () => {
  const service = makeServiceWithPolicy({ enabled: false });
  const approval = service.createApproval({
    kind: "shell.run",
    riskLevel: "safe",
    payload: { commands: ["rm -rf /tmp/x"] },
    preview: { commands: ["rm -rf /tmp/x"] },
  });
  expect(approval.riskLevel).toBe("safe");
});
```

The `makeServiceWithPolicy` helper is local to the test — follow the existing pattern in the same file for constructing the service under test.

- [ ] **Step 5: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/approval-lifecycle-service.test.ts`
Expected: FAIL.

- [ ] **Step 6: Implement**

In the service:
1. Inject `ShellExplainerPolicyConfig` via constructor.
2. After creating the approval (before returning), extract `commands` from `payload`/`preview` using the same traversal that `buildApprovalEvidenceModel` does (reuse the helper — re-export it from `@goatcitadel/mission-control-shared` if needed).
3. Compute `explainCommandsForApproval(commands)`.
4. Call `storage.approvals.setShellExplanations(approvalId, explanations)`.
5. If policy is enabled and any explanation has `highestRisk === "danger"` and the configured `elevateOnDanger` is higher than current, update `approval.riskLevel`. Use whatever existing risk-level update mutator exists; if none, add `setRiskLevel(approvalId, newLevel)` in `approval-repo.ts` mirroring the `setShellExplanations` pattern.
6. Return the updated approval (re-fetch from repo).

If `autoRejectOnDanger` is true, also resolve the approval with `resolutionNote: "Auto-rejected: shell command <X> triggered danger policy"`.

- [ ] **Step 7: Run tests to verify pass**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/approval-lifecycle-service.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/config.ts apps/gateway/src/services/approval-lifecycle-service.ts apps/gateway/src/services/approval-lifecycle-service.test.ts
# plus any other files modified
git commit -m "feat(o19-policy): compute shell explanations on approval create + danger elevation policy"
```

---

### Task 11: `ShellExplanationList.tsx` component

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/ops/ShellExplanationList.tsx`
- Create: `apps/mission-control-next/src/features/native-routes/ops/ShellExplanationList.test.tsx`
- Modify: `apps/mission-control-next/src/features/native-routes/native-routes.css` (append CSS)

- [ ] **Step 1: Write the failing test**

Create the test file:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ShellExplanationList } from "./ShellExplanationList.js";

describe("ShellExplanationList", () => {
  it("renders nothing when commands list is empty", () => {
    const { container } = render(<ShellExplanationList commands={[]} explanations={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a Danger chip for git push --force", () => {
    render(<ShellExplanationList commands={["git push --force origin main"]} explanations={undefined} />);
    expect(screen.getByText(/Force-push/)).toBeInTheDocument();
    expect(screen.getByText(/Danger/i)).toBeInTheDocument();
    expect(screen.getByText(/git push --force origin main/)).toBeInTheDocument();
  });

  it("uses server-side explanations when provided", () => {
    render(
      <ShellExplanationList
        commands={["pnpm install"]}
        explanations={[
          {
            command: "pnpm install",
            parsed: true,
            program: "pnpm",
            summary: "Server-provided summary",
            details: [],
            risks: [],
            highestRisk: "info",
          },
        ]}
      />,
    );
    expect(screen.getByText("Server-provided summary")).toBeInTheDocument();
  });
});
```

Use whatever test-library/jest-dom helper pattern already exists in the route's `*.test.tsx` files for the render setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next vitest run src/features/native-routes/ops/ShellExplanationList.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/features/native-routes/ops/ShellExplanationList.tsx`:

```typescript
import { useMemo } from "react";
import type { ShellCommandExplanation } from "@goatcitadel/contracts";
import { explainShellCommand } from "@goatcitadel/mission-control-shared";

export interface ShellExplanationListProps {
  readonly commands: readonly string[];
  readonly explanations?: readonly ShellCommandExplanation[];
}

export function ShellExplanationList({ commands, explanations }: ShellExplanationListProps) {
  const resolved = useMemo<readonly ShellCommandExplanation[]>(() => {
    if (commands.length === 0) {
      return [];
    }
    if (explanations && explanations.length === commands.length) {
      return explanations;
    }
    return commands.map((cmd) => explainShellCommand(cmd));
  }, [commands, explanations]);

  if (resolved.length === 0) {
    return null;
  }

  return (
    <div className="mc-next-approvals-shell-list">
      {resolved.map((exp, idx) => (
        <ShellExplanationCard key={`${exp.command}-${idx}`} explanation={exp} />
      ))}
    </div>
  );
}

function ShellExplanationCard({ explanation }: { readonly explanation: ShellCommandExplanation }) {
  const riskClass = `mc-next-approvals-shell-card-risk-${explanation.highestRisk}`;
  return (
    <div className={`mc-next-approvals-shell-card ${riskClass}`}>
      <div className="mc-next-approvals-shell-head">
        <span className="mc-next-approvals-shell-summary">{explanation.summary}</span>
        {explanation.highestRisk !== "info" ? (
          <span className={`mc-next-approvals-shell-chip mc-next-approvals-shell-chip-${explanation.highestRisk}`}>
            {explanation.highestRisk}
          </span>
        ) : null}
      </div>
      {explanation.details.length > 0 ? (
        <dl className="mc-next-approvals-shell-details">
          {explanation.details.map((d) => (
            <div className="mc-next-approvals-shell-detail-row" key={`${d.label}-${d.value}`}>
              <dt>{d.label}</dt>
              <dd>
                {d.value}
                {d.note ? (
                  <span className={`mc-next-approvals-shell-note mc-next-approvals-shell-note-${d.noteLevel ?? "info"}`}>
                    {d.note}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <code className="mc-next-approvals-shell-raw">{explanation.command}</code>
    </div>
  );
}
```

- [ ] **Step 4: Append CSS**

Append to `apps/mission-control-next/src/features/native-routes/native-routes.css`:

```css
.mc-next-approvals-shell-list { display: flex; flex-direction: column; gap: 10px; }
.mc-next-approvals-shell-card { background: rgba(255,255,255,0.025); border: 1px solid var(--mc-next-border, #2c3145); border-left: 3px solid #4b5772; border-radius: 6px; padding: 10px 12px; }
.mc-next-approvals-shell-card-risk-danger  { border-left-color: #f87171; background: rgba(248,113,113,0.06); }
.mc-next-approvals-shell-card-risk-caution { border-left-color: #fbbf24; background: rgba(251,191,36,0.05); }
.mc-next-approvals-shell-card-risk-info    { border-left-color: #4ade80; }
.mc-next-approvals-shell-head { display: flex; align-items: flex-start; gap: 8px; }
.mc-next-approvals-shell-summary { flex: 1; font-size: 13px; line-height: 1.4; }
.mc-next-approvals-shell-chip { font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.mc-next-approvals-shell-chip-danger  { background: rgba(248,113,113,0.18); color: #fca5a5; }
.mc-next-approvals-shell-chip-caution { background: rgba(251,191,36,0.18); color: #fcd34d; }
.mc-next-approvals-shell-details { margin: 8px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 12px; }
.mc-next-approvals-shell-details dt { color: var(--mc-next-muted, #9aa3b6); }
.mc-next-approvals-shell-details dd { margin: 0; }
.mc-next-approvals-shell-note { margin-left: 6px; font-size: 11px; }
.mc-next-approvals-shell-note-danger  { color: #fca5a5; }
.mc-next-approvals-shell-note-caution { color: #fcd34d; }
.mc-next-approvals-shell-raw { display: block; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--mc-next-border, #2c3145); font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--mc-next-muted, #9aa3b6); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-next vitest run src/features/native-routes/ops/ShellExplanationList.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/ops/ShellExplanationList.tsx apps/mission-control-next/src/features/native-routes/ops/ShellExplanationList.test.tsx apps/mission-control-next/src/features/native-routes/native-routes.css
git commit -m "feat(o19-ui): ShellExplanationList component with risk-coded cards"
```

---

### Task 12: Integrate `ShellExplanationList` into `ApprovalsRoutePage`

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx` (around lines 409-415)
- Modify: `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx`

- [ ] **Step 1: Re-read the target region**

Run: `sed -n '405,420p' apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx`

Confirm the current bullet list:

```tsx
{evidence.commands.length > 0 ? (
  <ul className="mc-next-approvals-compact-list">
    {evidence.commands.map((line) => (
      <li key={`${approval.approvalId}-command-${line}`}>{line}</li>
    ))}
  </ul>
) : null}
```

- [ ] **Step 2: Write the failing integration test**

Add to `ApprovalsRoutePage.test.tsx`:

```typescript
it("renders ShellExplanationList for approval commands", () => {
  const approval = makeApproval({
    preview: { commands: ["git push --force origin main"] },
  });
  renderApprovalsRouteWith({ approvals: [approval] });
  expect(screen.getByText(/Force-push/)).toBeInTheDocument();
  expect(screen.getByText(/Danger/i)).toBeInTheDocument();
});
```

Reuse the existing `makeApproval` / `renderApprovalsRouteWith` (or equivalent) test helpers in the file. If absent, follow the pattern of any other approval-shaped test in the same file.

- [ ] **Step 3: Verify test fails**

Run: `pnpm --filter @goatcitadel/mission-control-next vitest run src/features/native-routes/ops/ApprovalsRoutePage.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Replace the bullet list with the component**

Replace lines 409-415 with:

```tsx
<ShellExplanationList
  commands={evidence.commands}
  explanations={approval.shellExplanations}
/>
```

Add to imports at top:

```tsx
import { ShellExplanationList } from "./ShellExplanationList.js";
```

- [ ] **Step 5: Verify tests pass**

Run: `pnpm --filter @goatcitadel/mission-control-next vitest run src/features/native-routes/ops/ApprovalsRoutePage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Confirm file size**

Run: `wc -l apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx`
Expected: under 800.

- [ ] **Step 7: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx
git commit -m "feat(o19-ui): wire ShellExplanationList into ApprovalsRoutePage"
```

---

### Task 13: Doctor backfill repair — `approvals-shell-explanations-backfill`

**Files:**
- Modify: `apps/gateway/src/doctor/engine.ts`
- Modify: `apps/gateway/src/doctor/engine.test.ts`

- [ ] **Step 1: Read existing check pattern**

Read `apps/gateway/src/doctor/engine.ts`, find an existing check function (e.g. `checkConfigIntegrity`). Note the signature: `async (context, repairs): Promise<DoctorCheckResult>`.

- [ ] **Step 2: Write the failing test**

In `engine.test.ts`:

```typescript
it("approvals-shell-explanations-backfill: warns when approvals are missing explanations, repairs by computing them", async () => {
  const ctx = makeDoctorContextWithApprovals([
    {
      approvalId: "a1",
      preview: { commands: ["rm -rf /tmp/x"] },
      shellExplanations: undefined,
    },
  ]);
  // audit-only mode → warn
  const audit = await runDoctor({ ...ctx, auditOnly: true });
  expect(audit.checks.find((c) => c.id === "approvals-shell-explanations-backfill")?.status).toBe("warn");

  // repair mode → fixed
  const repair = await runDoctor({ ...ctx, auditOnly: false });
  expect(repair.checks.find((c) => c.id === "approvals-shell-explanations-backfill")?.status).toBe("fixed");

  const approval = ctx.storage.approvals.get("a1");
  expect(approval?.shellExplanations).toHaveLength(1);
});
```

The `makeDoctorContextWithApprovals` helper may not exist — base it on the existing helper that builds a context for `runDoctor` tests. Inspect the existing tests in `engine.test.ts` and `engine.loop23.test.ts` for the right pattern.

- [ ] **Step 3: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/doctor/engine.test.ts`
Expected: FAIL.

- [ ] **Step 4: Add the check function**

In `engine.ts`, add a new function:

```typescript
async function checkApprovalsShellExplanationsBackfill(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const storage = context.storage; // adjust based on how storage is exposed in context
  const pending = storage.approvals.listByStatus({ status: "pending", limit: 1000 });
  const missing = pending.filter(
    (a) => extractCommands(a).length > 0 && (!a.shellExplanations || a.shellExplanations.length === 0),
  );

  if (missing.length === 0) {
    return {
      id: "approvals-shell-explanations-backfill",
      group: "approvals",
      title: "Shell explanations backfilled",
      status: "ok",
      severity: "info",
      detail: "All pending approvals with commands have shell explanations.",
      repairable: false,
    };
  }

  if (!context.repairEnabled) {
    return {
      id: "approvals-shell-explanations-backfill",
      group: "approvals",
      title: "Shell explanations missing",
      status: "warn",
      severity: "warning",
      detail: `${missing.length} pending approval(s) missing shell explanations.`,
      repairable: true,
      repairAction: "Compute and persist explanations for each missing approval.",
    };
  }

  for (const approval of missing) {
    const commands = extractCommands(approval);
    const explanations = explainCommandsForApproval(commands);
    storage.approvals.setShellExplanations(approval.approvalId, explanations);
  }
  repairs.push({
    checkId: "approvals-shell-explanations-backfill",
    applied: true,
    skipped: false,
    changes: missing.map((a) => `Backfilled explanations for ${a.approvalId}`),
  });
  return {
    id: "approvals-shell-explanations-backfill",
    group: "approvals",
    title: "Shell explanations backfilled",
    status: "fixed",
    severity: "info",
    detail: `Backfilled shell explanations for ${missing.length} approval(s).`,
    repairable: true,
  };
}

function extractCommands(approval: ApprovalRequest): string[] {
  const out: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (/^(command|cmd|script|shell|commands|cmds)$/i.test(key)) {
          if (typeof nested === "string") out.push(nested);
          else if (Array.isArray(nested)) for (const x of nested) if (typeof x === "string") out.push(x);
        } else {
          collect(nested);
        }
      }
    }
  };
  collect(approval.preview);
  collect(approval.payload);
  return out;
}
```

Import `explainCommandsForApproval` from `../services/shell-command-explainer.js`. Import `ApprovalRequest` from `@goatcitadel/contracts`.

Register the check by appending to the `checks.push(await ...)` block in `runDoctor` (next to existing checks).

- [ ] **Step 5: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/doctor/engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/doctor/engine.ts apps/gateway/src/doctor/engine.test.ts
git commit -m "feat(o19-doctor-backfill): doctor --deep backfills missing shell explanations"
```

---

## Phase 2 — O17 Channel Bot-Loop Guard

### Task 14: `inferChannelParticipantRole`

**Files:**
- Create: `apps/gateway/src/services/channel-participant-role.ts`
- Create: `apps/gateway/src/services/channel-participant-role.test.ts`

- [ ] **Step 1: Find the existing `ChannelParticipant` type**

Run: `grep -rn "interface ChannelParticipant\|type ChannelParticipant" packages/contracts/src/`. Note the field shape (look for `kind`, `role`, `agentProfileId`, `userId`, `connectorType`, or similar identifying fields).

- [ ] **Step 2: Write the failing test**

Create `channel-participant-role.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { inferChannelParticipantRole } from "./channel-participant-role.js";

describe("inferChannelParticipantRole", () => {
  it("returns assistant for participants with agentProfileId", () => {
    const p = { id: "p1", agentProfileId: "agent-1" } as never;
    expect(inferChannelParticipantRole(p)).toBe("assistant");
  });

  it("returns bot for connector-bot participants", () => {
    const p = { id: "p1", connectorType: "discord-bot" } as never;
    expect(inferChannelParticipantRole(p)).toBe("bot");
  });

  it("returns human for human-linked participants", () => {
    const p = { id: "p1", userId: "u1" } as never;
    expect(inferChannelParticipantRole(p)).toBe("human");
  });

  it("returns system when no participant identifying fields", () => {
    const p = { id: "p1", kind: "system" } as never;
    expect(inferChannelParticipantRole(p)).toBe("system");
  });

  it("returns unknown when nothing else matches", () => {
    const p = { id: "p1" } as never;
    expect(inferChannelParticipantRole(p)).toBe("unknown");
  });
});
```

- [ ] **Step 3: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-participant-role.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

Create `channel-participant-role.ts`:

```typescript
export type ChannelParticipantRole = "human" | "bot" | "assistant" | "system" | "unknown";

export interface ChannelParticipantLike {
  readonly id?: string;
  readonly agentProfileId?: string;
  readonly userId?: string;
  readonly connectorType?: string;
  readonly kind?: string;
  readonly role?: string;
}

const BOT_CONNECTOR_RE = /-bot$|^bot-/i;

export function inferChannelParticipantRole(
  participant: ChannelParticipantLike,
): ChannelParticipantRole {
  if (participant.agentProfileId) {
    return "assistant";
  }
  if (participant.connectorType && BOT_CONNECTOR_RE.test(participant.connectorType)) {
    return "bot";
  }
  if (participant.userId) {
    return "human";
  }
  if (participant.kind === "system") {
    return "system";
  }
  return "unknown";
}

export function isBotAuthored(role: ChannelParticipantRole): boolean {
  return role === "bot" || role === "assistant";
}
```

- [ ] **Step 5: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-participant-role.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/channel-participant-role.ts apps/gateway/src/services/channel-participant-role.test.ts
git commit -m "feat(o17-participant-role): infer channel participant role for bot-loop gating"
```

---

### Task 15: `ChannelBotLoopGuard`

**Files:**
- Create: `apps/gateway/src/services/channel-bot-loop-guard.ts`
- Create: `apps/gateway/src/services/channel-bot-loop-guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `channel-bot-loop-guard.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ChannelBotLoopGuard, type BotLoopGuardKey } from "./channel-bot-loop-guard.js";

const CONFIG = { maxEventsPerWindow: 20, windowSeconds: 60, cooldownSeconds: 60, enabled: true };
const KEY: BotLoopGuardKey = { scope: "ws1", conversation: "c1", participantA: "bot1", participantB: "bot2" };

describe("ChannelBotLoopGuard", () => {
  it("allows the first 20 events in a 60s window", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 20; i++) {
      now += 100;
      expect(guard.decide(KEY).action).toBe("allow");
    }
  });

  it("suppresses event 21 within the window", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 20; i++) {
      now += 100;
      guard.decide(KEY);
    }
    now += 100;
    const decision = guard.decide(KEY);
    expect(decision.action).toBe("suppress");
    if (decision.action === "suppress") {
      expect(decision.reason).toBe("rate-cap");
    }
  });

  it("allows again after cooldown elapses", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 21; i++) {
      now += 100;
      guard.decide(KEY);
    }
    now += 70_000; // past cooldown
    expect(guard.decide(KEY).action).toBe("allow");
  });

  it("reports cooldown reason for attempts during cooldown", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 21; i++) {
      now += 100;
      guard.decide(KEY);
    }
    now += 1000;
    const decision = guard.decide(KEY);
    expect(decision.action).toBe("suppress");
    if (decision.action === "suppress") {
      expect(decision.reason).toBe("cooldown");
    }
  });

  it("different pairs in same conversation are independent", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    const pairA = KEY;
    const pairB: BotLoopGuardKey = { ...KEY, participantA: "bot3", participantB: "bot4" };
    for (let i = 0; i < 20; i++) {
      now += 100;
      guard.decide(pairA);
    }
    expect(guard.decide(pairB).action).toBe("allow");
  });

  it("canonicalizes pair order (A,B) === (B,A)", () => {
    const guard = new ChannelBotLoopGuard(CONFIG, () => 1_000_000);
    const reversed: BotLoopGuardKey = {
      ...KEY,
      participantA: KEY.participantB,
      participantB: KEY.participantA,
    };
    for (let i = 0; i < 20; i++) guard.decide(KEY);
    expect(guard.decide(reversed).action).toBe("suppress");
  });

  it("inspect() reports state without mutating", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 5; i++) {
      now += 100;
      guard.decide(KEY);
    }
    const before = guard.inspect(KEY);
    expect(before.eventsInWindow).toBe(5);
    guard.inspect(KEY);
    const after = guard.inspect(KEY);
    expect(after.eventsInWindow).toBe(5);
  });

  it("gc() evicts idle keys past cooldown horizon", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    guard.decide(KEY);
    now += 200_000;
    expect(guard.gc()).toBeGreaterThanOrEqual(1);
    expect(guard.inspect(KEY).eventsInWindow).toBe(0);
  });

  it("when disabled, never suppresses", () => {
    const guard = new ChannelBotLoopGuard({ ...CONFIG, enabled: false }, () => 1_000_000);
    for (let i = 0; i < 100; i++) {
      expect(guard.decide(KEY).action).toBe("allow");
    }
  });
});
```

- [ ] **Step 2: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-bot-loop-guard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `channel-bot-loop-guard.ts`:

```typescript
export interface BotLoopGuardConfig {
  readonly maxEventsPerWindow: number;
  readonly windowSeconds: number;
  readonly cooldownSeconds: number;
  readonly enabled: boolean;
}

export interface BotLoopGuardKey {
  readonly scope: string;
  readonly conversation: string;
  readonly participantA: string;
  readonly participantB: string;
}

export type BotLoopGuardDecision =
  | { readonly action: "allow" }
  | {
      readonly action: "suppress";
      readonly reason: "rate-cap" | "cooldown";
      readonly cooldownExpiresAt: string;
    };

interface BucketState {
  events: number[];           // ms timestamps
  suppressedUntil?: number;   // ms
  lastTouched: number;
}

function canonicalKey(key: BotLoopGuardKey): string {
  const [a, b] = [key.participantA, key.participantB].sort();
  return `${key.scope} ${key.conversation} ${a} ${b}`;
}

export class ChannelBotLoopGuard {
  private readonly buckets = new Map<string, BucketState>();

  public constructor(
    private readonly config: BotLoopGuardConfig,
    private readonly now: () => number = Date.now,
  ) {}

  public decide(key: BotLoopGuardKey): BotLoopGuardDecision {
    if (!this.config.enabled) {
      return { action: "allow" };
    }
    const k = canonicalKey(key);
    const ts = this.now();
    const bucket = this.buckets.get(k) ?? { events: [], lastTouched: ts };
    bucket.lastTouched = ts;

    if (bucket.suppressedUntil && bucket.suppressedUntil > ts) {
      this.buckets.set(k, bucket);
      return {
        action: "suppress",
        reason: "cooldown",
        cooldownExpiresAt: new Date(bucket.suppressedUntil).toISOString(),
      };
    }
    bucket.suppressedUntil = undefined;

    const windowMs = this.config.windowSeconds * 1000;
    bucket.events = bucket.events.filter((t) => ts - t < windowMs);

    if (bucket.events.length >= this.config.maxEventsPerWindow) {
      bucket.suppressedUntil = ts + this.config.cooldownSeconds * 1000;
      this.buckets.set(k, bucket);
      return {
        action: "suppress",
        reason: "rate-cap",
        cooldownExpiresAt: new Date(bucket.suppressedUntil).toISOString(),
      };
    }

    bucket.events.push(ts);
    this.buckets.set(k, bucket);
    return { action: "allow" };
  }

  public inspect(key: BotLoopGuardKey): { eventsInWindow: number; suppressedUntil?: string } {
    const bucket = this.buckets.get(canonicalKey(key));
    if (!bucket) return { eventsInWindow: 0 };
    const windowMs = this.config.windowSeconds * 1000;
    const ts = this.now();
    const inWindow = bucket.events.filter((t) => ts - t < windowMs).length;
    return {
      eventsInWindow: inWindow,
      suppressedUntil:
        bucket.suppressedUntil && bucket.suppressedUntil > ts
          ? new Date(bucket.suppressedUntil).toISOString()
          : undefined,
    };
  }

  public gc(): number {
    const ts = this.now();
    const idleHorizonMs = (this.config.cooldownSeconds + this.config.windowSeconds) * 1000;
    let evicted = 0;
    for (const [k, bucket] of this.buckets.entries()) {
      if (ts - bucket.lastTouched > idleHorizonMs) {
        this.buckets.delete(k);
        evicted++;
      }
    }
    return evicted;
  }
}
```

- [ ] **Step 4: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-bot-loop-guard.test.ts`
Expected: PASS — all 9 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-bot-loop-guard.ts apps/gateway/src/services/channel-bot-loop-guard.test.ts
git commit -m "feat(o17-loop-guard): per-pair channel bot-loop guard with rate cap + cooldown"
```

---

### Task 16: Wire guard into primary delivery path

**Files:**
- Modify: `apps/gateway/src/services/channel-delivery-runtime-service.ts`
- Modify: `apps/gateway/src/services/channel-delivery-runtime-service.test.ts`
- Modify: `apps/gateway/src/config.ts` (add `channelBotLoopGuard` config section)

- [ ] **Step 1: Read the delivery service**

Read the entire file. Find the point where outbound channel messages are enqueued (likely a `enqueue` or `dispatch` method). Identify how participant info is available — there may be sender info on the input.

- [ ] **Step 2: Add config schema**

In `apps/gateway/src/config.ts`:

```typescript
export interface ChannelBotLoopGuardConfig {
  enabled: boolean;
  maxEventsPerWindow: number;
  windowSeconds: number;
  cooldownSeconds: number;
}

export const DEFAULT_CHANNEL_BOT_LOOP_GUARD: ChannelBotLoopGuardConfig = {
  enabled: true,
  maxEventsPerWindow: 20,
  windowSeconds: 60,
  cooldownSeconds: 60,
};
```

Plumb into the gateway config object.

- [ ] **Step 3: Write failing wiring test**

In `channel-delivery-runtime-service.test.ts`, add:

```typescript
it("suppresses bot-to-bot events after maxEventsPerWindow in windowSeconds", () => {
  const service = makeService({
    botLoopGuardConfig: { enabled: true, maxEventsPerWindow: 3, windowSeconds: 60, cooldownSeconds: 60 },
  });
  const suppressed: unknown[] = [];
  service.onSuppressed((evt) => suppressed.push(evt));

  for (let i = 0; i < 5; i++) {
    service.enqueueBotEvent({
      scope: "ws1",
      conversation: "c1",
      sender: { id: "bot1", agentProfileId: "agent-1" },
      recipient: { id: "bot2", agentProfileId: "agent-2" },
      payload: {},
    });
  }

  expect(suppressed.length).toBe(2);  // 4th and 5th
});
```

Adapt to whatever public API the service already exposes. If `onSuppressed`/`enqueueBotEvent` don't exist, add them as part of this task and reuse them in the implementation step.

- [ ] **Step 4: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-delivery-runtime-service.test.ts`
Expected: FAIL.

- [ ] **Step 5: Wire in the guard**

In the delivery service:

1. Inject `ChannelBotLoopGuard` and `ChannelBotLoopGuardConfig` via constructor.
2. In the enqueue path, before the actual enqueue, infer roles of sender and recipient using `inferChannelParticipantRole`. If both are bot-authored (`isBotAuthored(role)`), call `guard.decide({ scope, conversation, participantA: sender.id, participantB: recipient.id })`.
3. If decision is `suppress`, emit a `channel.bot_event.suppressed` event (publish through whatever existing event publisher the service uses — search the file for similar `emit(` or `publish(` calls).
4. Return without enqueuing the message.

- [ ] **Step 6: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-delivery-runtime-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/services/channel-delivery-runtime-service.ts apps/gateway/src/services/channel-delivery-runtime-service.test.ts apps/gateway/src/config.ts
git commit -m "feat(o17-integration): wire bot-loop guard into channel delivery runtime"
```

---

### Task 17: Wire guard into secondary paths

**Files:**
- Modify: `apps/gateway/src/services/channel-bot-live-probes.ts`
- Modify: `apps/gateway/src/services/agentic-improvement-bridge-service.ts`
- Modify: `apps/gateway/src/services/chat-agent-orchestrator.ts`
- Test: each file's existing `.test.ts` companion

- [ ] **Step 1: Audit each file for bot-event dispatch**

For each of the three files, read it and identify the call site(s) where a bot-authored event is published. Look for: `publish(`, `emit(`, message-to-channel, agent-to-agent dispatch.

- [ ] **Step 2: Decide guard application**

For each call site, decide:
- **Route through guard**: if the event is participant-to-participant and could feasibly loop, use the same `guard.decide` pattern as Task 16.
- **Exempt with comment**: if the event is single-shot, broadcast-only, or system-bootstrapped, add a code comment `// loop-guard-exempt: <reason>`.

- [ ] **Step 3: Write a failing test per file**

For each file, add a test asserting either:
- Suppression behavior matches Task 16 (if routed through guard), OR
- A comment-only no-behavior change (which doesn't need a test; document the exemption in the spec's "Resolved design decisions" section instead).

For files routed through the guard, the test mirrors the Task 16 test shape — generate 4 bot-pair events with a `maxEventsPerWindow: 3` config and assert the 4th is suppressed.

- [ ] **Step 4: Implement guard wiring per file**

Same pattern as Task 16, with the guard injected via constructor.

- [ ] **Step 5: Verify tests pass**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-bot-live-probes.test.ts src/services/agentic-improvement-bridge-service.test.ts src/services/chat-agent-orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 6: Final grep for additional dispatchers**

Run: `grep -rn "publishChannelEvent\|emitChannelEvent\|botToBot\|agent-to-agent" apps/gateway/src/services/ | grep -v ".test.ts"`. For each match, determine whether it's covered by Tasks 16-17 or whether it needs guard wiring. Document any exemptions inline with `// loop-guard-exempt: <reason>` comments.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/services/channel-bot-live-probes.ts apps/gateway/src/services/agentic-improvement-bridge-service.ts apps/gateway/src/services/chat-agent-orchestrator.ts apps/gateway/src/services/*.test.ts
git commit -m "feat(o17-integration): apply bot-loop guard to live-probes, improvement-bridge, chat-orchestrator"
```

---

## Phase 3 — Operator Diagnostics

### Task 18: Startup phase recorder

**Files:**
- Create: `apps/gateway/src/diagnostics/startup-phases.ts`
- Create: `apps/gateway/src/diagnostics/startup-phases.test.ts`

- [ ] **Step 1: Write the failing test**

Create `startup-phases.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { StartupPhaseRecorder } from "./startup-phases.js";

describe("StartupPhaseRecorder", () => {
  it("records open and close timestamps and computes duration", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    const phase = recorder.open("storage_init", { owner: "storage" });
    now += 1500;
    phase.close();
    const snapshot = recorder.snapshot();
    expect(snapshot.phases).toHaveLength(1);
    expect(snapshot.phases[0].durationMs).toBe(1500);
    expect(snapshot.phases[0].owner).toBe("storage");
  });

  it("supports nested phases", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    const outer = recorder.open("plugin_discovery", { owner: "plugins" });
    now += 100;
    const inner = recorder.open("plugin_load_addon", { owner: "plugins" });
    now += 500;
    inner.close();
    now += 100;
    outer.close();
    const snapshot = recorder.snapshot();
    expect(snapshot.phases.map((p) => p.id)).toEqual(["plugin_load_addon", "plugin_discovery"]);
  });

  it("reports in-progress phases when queried mid-run", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    recorder.open("plugin_discovery", { owner: "plugins" });
    now += 7000;
    const snapshot = recorder.snapshot();
    expect(snapshot.inProgress).toHaveLength(1);
    expect(snapshot.inProgress[0].ageMs).toBe(7000);
  });
});
```

- [ ] **Step 2: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/diagnostics/startup-phases.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `startup-phases.ts`:

```typescript
export interface StartupPhaseRecord {
  readonly id: string;
  readonly owner: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly notes?: string;
}

export interface StartupPhaseInProgress {
  readonly id: string;
  readonly owner: string;
  readonly startedAt: string;
  readonly ageMs: number;
}

export interface StartupPhaseSnapshot {
  readonly phases: readonly StartupPhaseRecord[];
  readonly inProgress: readonly StartupPhaseInProgress[];
  readonly ready: boolean;
}

export interface OpenPhaseOptions {
  readonly owner: string;
  readonly notes?: string;
}

export interface OpenPhase {
  close(notes?: string): void;
}

interface InternalPhase {
  id: string;
  owner: string;
  startMs: number;
  endMs?: number;
  notes?: string;
}

export class StartupPhaseRecorder {
  private readonly phases: InternalPhase[] = [];
  private ready = false;

  public constructor(private readonly now: () => number = Date.now) {}

  public open(id: string, options: OpenPhaseOptions): OpenPhase {
    const entry: InternalPhase = { id, owner: options.owner, startMs: this.now(), notes: options.notes };
    this.phases.push(entry);
    return {
      close: (notes?: string) => {
        entry.endMs = this.now();
        if (notes) entry.notes = notes;
      },
    };
  }

  public markReady(): void {
    this.ready = true;
  }

  public snapshot(): StartupPhaseSnapshot {
    const ts = this.now();
    const closed: StartupPhaseRecord[] = [];
    const open: StartupPhaseInProgress[] = [];
    for (const p of this.phases) {
      if (p.endMs !== undefined) {
        closed.push({
          id: p.id,
          owner: p.owner,
          startedAt: new Date(p.startMs).toISOString(),
          finishedAt: new Date(p.endMs).toISOString(),
          durationMs: p.endMs - p.startMs,
          notes: p.notes,
        });
      } else {
        open.push({
          id: p.id,
          owner: p.owner,
          startedAt: new Date(p.startMs).toISOString(),
          ageMs: ts - p.startMs,
        });
      }
    }
    return { phases: closed, inProgress: open, ready: this.ready };
  }
}

let singleton: StartupPhaseRecorder | undefined;

export function getStartupPhaseRecorder(): StartupPhaseRecorder {
  if (!singleton) {
    singleton = new StartupPhaseRecorder();
  }
  return singleton;
}

export function resetStartupPhaseRecorderForTests(): void {
  singleton = undefined;
}
```

- [ ] **Step 4: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/diagnostics/startup-phases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/diagnostics/startup-phases.ts apps/gateway/src/diagnostics/startup-phases.test.ts
git commit -m "feat(diagnostics-phase-spans): startup phase recorder with snapshot + in-progress queries"
```

---

### Task 19: Integrate phase recorder in `app.ts`

**Files:**
- Modify: `apps/gateway/src/app.ts`

- [ ] **Step 1: Identify phase boundaries**

Read `app.ts`. Map each phase from the spec to a code region:
- `env_load`: lines around `loadLocalEnvFile()`
- `storage_init`: `app.register(gatewayPlugin, ...)`
- `auth_load`: `app.register(authPlugin, ...)`
- `plugin_discovery`: `app.register(routeServicesPlugin, ...)` + any plugin registration
- `sidecar_init`: any sidecar bring-up registrations
- `route_registration`: the long block of `app.register(<route>...)`
- `ready`: marked at the end of `buildApp` before return

- [ ] **Step 2: Add phase wrapping**

At the top of `app.ts`, import:

```typescript
import { getStartupPhaseRecorder } from "./diagnostics/startup-phases.js";
```

Around each region:

```typescript
const phase = getStartupPhaseRecorder().open("storage_init", { owner: "storage" });
await app.register(gatewayPlugin, { ... });
phase.close();
```

For `route_registration`, wrap the whole block once.

Before returning the app at the end of `buildApp`:

```typescript
getStartupPhaseRecorder().markReady();
const readyPhase = getStartupPhaseRecorder().open("ready", { owner: "core" });
readyPhase.close();
```

Log the snapshot at INFO level just before returning:

```typescript
const snapshot = getStartupPhaseRecorder().snapshot();
app.log.info({ startupPhases: snapshot.phases }, "gateway startup phases complete");
```

- [ ] **Step 3: Smoke test**

Run: `pnpm --filter @goatcitadel/gateway typecheck`
Expected: exit code 0.

Run: `pnpm --filter @goatcitadel/gateway vitest run src/app.test.ts`
Expected: PASS — phase recorder must not break the existing app boot smoke test.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/app.ts
git commit -m "feat(diagnostics-phase-spans): wrap gateway startup with phase recorder"
```

---

### Task 20: Active-work labels (in-progress logging)

**Files:**
- Modify: `apps/gateway/src/diagnostics/startup-phases.ts`
- Modify: `apps/gateway/src/diagnostics/startup-phases.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `startup-phases.test.ts`:

```typescript
it("emits an in-progress log every interval for long-running phases", () => {
  let now = 1_000_000;
  const logs: Array<{ phase: string; ageMs: number }> = [];
  const recorder = new StartupPhaseRecorder(() => now, (entry) => logs.push(entry));
  recorder.open("plugin_discovery", { owner: "plugins" });
  // first tick: 5s after start (should fire — threshold 5s)
  now += 5500;
  recorder.tick();
  // second tick: 10s later (should fire on the 10s cadence)
  now += 10_000;
  recorder.tick();
  expect(logs.length).toBeGreaterThanOrEqual(2);
  expect(logs[0].phase).toBe("plugin_discovery");
});
```

- [ ] **Step 2: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/diagnostics/startup-phases.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend implementation**

Modify `startup-phases.ts` to accept an `onInProgress` callback in the constructor, and add a `tick()` method that:
- Walks phases without `endMs`,
- Emits if `age >= 5000ms` and (no last emit OR `last emit >= 10s ago`).

```typescript
export type InProgressLogger = (entry: { phase: string; owner: string; ageMs: number }) => void;

export class StartupPhaseRecorder {
  private readonly phases: InternalPhase[] = [];
  private readonly lastEmitAt = new Map<string, number>();
  private ready = false;

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly onInProgress?: InProgressLogger,
  ) {}

  // ... existing open/close/snapshot ...

  public tick(): void {
    if (!this.onInProgress) return;
    const ts = this.now();
    for (const p of this.phases) {
      if (p.endMs !== undefined) continue;
      const age = ts - p.startMs;
      if (age < 5000) continue;
      const lastEmit = this.lastEmitAt.get(p.id) ?? -Infinity;
      if (ts - lastEmit < 10_000) continue;
      this.onInProgress({ phase: p.id, owner: p.owner, ageMs: age });
      this.lastEmitAt.set(p.id, ts);
    }
  }
}
```

- [ ] **Step 4: Wire ticker into app.ts**

In `app.ts`, after `buildApp` initializes the recorder, schedule a ticker:

```typescript
const ticker = setInterval(() => getStartupPhaseRecorder().tick(), 1000);
ticker.unref();
app.addHook("onClose", async () => clearInterval(ticker));
```

Pass an `InProgressLogger` when getting the recorder. The easiest plumbing: re-create the recorder with the logger in `app.ts`. Since the singleton was initialized without a logger in Task 18, refactor `getStartupPhaseRecorder` to optionally accept a logger on first call:

```typescript
export function getStartupPhaseRecorder(logger?: InProgressLogger): StartupPhaseRecorder {
  if (!singleton) {
    singleton = new StartupPhaseRecorder(Date.now, logger);
  }
  return singleton;
}
```

In `app.ts`:

```typescript
const recorder = getStartupPhaseRecorder((entry) =>
  app.log.info({ phase: entry.phase, owner: entry.owner, ageMs: entry.ageMs }, "phase.in_progress"),
);
```

- [ ] **Step 5: Verify tests pass**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/diagnostics/startup-phases.test.ts src/app.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/diagnostics/startup-phases.ts apps/gateway/src/diagnostics/startup-phases.test.ts apps/gateway/src/app.ts
git commit -m "feat(diagnostics-phase-spans): active-work labels via in-progress ticker"
```

---

### Task 21: Stale runtime-session markers

**Files:**
- Create: `apps/gateway/src/diagnostics/stale-session-markers.ts`
- Create: `apps/gateway/src/diagnostics/stale-session-markers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `stale-session-markers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { markStaleSessions } from "./stale-session-markers.js";

describe("markStaleSessions", () => {
  const now = new Date("2026-05-15T10:00:00Z").getTime();

  it("marks records with heartbeat older than threshold as stale", () => {
    const stale = new Date(now - 120_000).toISOString();
    const fresh = new Date(now - 30_000).toISOString();
    const result = markStaleSessions(
      [
        { id: "a", lastHeartbeatAt: stale, status: "running" },
        { id: "b", lastHeartbeatAt: fresh, status: "running" },
      ],
      { now, thresholdMs: 90_000 },
    );
    expect(result[0].runtimeState).toBe("stale");
    expect(result[1].runtimeState).toBe("active");
  });

  it("uses updatedAt when lastHeartbeatAt is absent", () => {
    const stale = new Date(now - 120_000).toISOString();
    const result = markStaleSessions(
      [{ id: "a", updatedAt: stale, status: "running" }],
      { now, thresholdMs: 90_000 },
    );
    expect(result[0].runtimeState).toBe("stale");
  });

  it("never marks terminal-status records as stale", () => {
    const stale = new Date(now - 999_999).toISOString();
    const result = markStaleSessions(
      [
        { id: "a", lastHeartbeatAt: stale, status: "sent" },
        { id: "b", lastHeartbeatAt: stale, status: "failed" },
      ],
      { now, thresholdMs: 90_000 },
    );
    expect(result[0].runtimeState).toBe("active");
    expect(result[1].runtimeState).toBe("active");
  });

  it("returns active when no heartbeat info is available", () => {
    const result = markStaleSessions([{ id: "a", status: "running" }], {
      now,
      thresholdMs: 90_000,
    });
    expect(result[0].runtimeState).toBe("active");
  });
});
```

- [ ] **Step 2: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/diagnostics/stale-session-markers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `stale-session-markers.ts`:

```typescript
export type RuntimeSessionState = "active" | "stale";

const TERMINAL_STATUSES = new Set([
  "sent",
  "failed",
  "stale",  // already-marked stale; don't churn
  "completed",
  "rejected",
  "approved",
  "skipped",
]);

export interface StaleableRecord {
  readonly id?: string;
  readonly lastHeartbeatAt?: string;
  readonly updatedAt?: string;
  readonly status?: string;
}

export interface MarkOptions {
  readonly now: number;
  readonly thresholdMs: number;
}

export function markStaleSessions<T extends StaleableRecord>(
  records: readonly T[],
  options: MarkOptions,
): readonly (T & { runtimeState: RuntimeSessionState })[] {
  return records.map((r) => ({
    ...r,
    runtimeState: computeState(r, options),
  }));
}

function computeState(record: StaleableRecord, options: MarkOptions): RuntimeSessionState {
  if (record.status && TERMINAL_STATUSES.has(record.status)) return "active";
  const heartbeatRaw = record.lastHeartbeatAt ?? record.updatedAt;
  if (!heartbeatRaw) return "active";
  const heartbeatMs = Date.parse(heartbeatRaw);
  if (!Number.isFinite(heartbeatMs)) return "active";
  return options.now - heartbeatMs > options.thresholdMs ? "stale" : "active";
}

export const DEFAULT_STALE_THRESHOLD_MS = 90_000;
```

- [ ] **Step 4: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/diagnostics/stale-session-markers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/diagnostics/stale-session-markers.ts apps/gateway/src/diagnostics/stale-session-markers.test.ts
git commit -m "feat(diagnostics-stale-sessions): generic stale-state marker"
```

---

### Task 22: Apply stale markers to channel delivery records + sessions list + doctor

**Files:**
- Modify: `apps/gateway/src/services/channel-delivery-runtime-service.ts` (diagnostics output method)
- Modify: `apps/gateway/src/routes/sessions-list.ts`
- Modify: `apps/gateway/src/doctor/engine.ts` (new `runtime-sessions` check)
- Modify: corresponding `.test.ts` files

- [ ] **Step 1: Channel delivery records**

In `channel-delivery-runtime-service.ts`, find the method that returns records for diagnostics (search for `getDiagnosticsRecords` or similar, or the route handler that exposes runtime records). Pass returned records through `markStaleSessions(records, { now: Date.now(), thresholdMs: DEFAULT_STALE_THRESHOLD_MS })`.

Add a test confirming a 200s-old `running` record gains `runtimeState: "stale"`.

- [ ] **Step 2: Sessions list route**

In `sessions-list.ts`, find the response payload assembly. Pass each session through the same marker. Add a test asserting the response includes `runtimeState` for each session.

- [ ] **Step 3: Doctor `runtime-sessions` check**

In `doctor/engine.ts`, add:

```typescript
async function checkRuntimeSessions(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  // collect channel delivery records + session rows; mark them
  const all: StaleableRecord[] = [
    ...context.storage.channelDeliveryRuntime.listAll(),
    ...context.storage.sessions.list(),
  ];
  const marked = markStaleSessions(all, {
    now: Date.now(),
    thresholdMs: DEFAULT_STALE_THRESHOLD_MS,
  });
  const stale = marked.filter((r) => r.runtimeState === "stale");

  if (stale.length === 0) {
    return {
      id: "runtime-sessions",
      group: "runtime",
      title: "Runtime sessions",
      status: "ok",
      severity: "info",
      detail: "All runtime sessions are heartbeating within threshold.",
      repairable: false,
    };
  }
  return {
    id: "runtime-sessions",
    group: "runtime",
    title: "Runtime sessions",
    status: "warn",
    severity: "warning",
    detail: `${stale.length} stale runtime session(s). Oldest: ${oldestStaleAge(stale)}s.`,
    repairable: false,
  };
}
```

Adjust to whatever storage accessors the existing doctor uses (search the file for similar `context.storage.something.list`).

Register the check in `runDoctor`.

Test the check in `engine.test.ts`.

- [ ] **Step 4: Verify all tests pass**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/services/channel-delivery-runtime-service.test.ts src/routes/sessions-list.test.ts src/doctor/engine.test.ts`
(use the actual existing test file names for sessions-list if `sessions-list.test.ts` doesn't exist; search first)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-delivery-runtime-service.ts apps/gateway/src/routes/sessions-list.ts apps/gateway/src/doctor/engine.ts apps/gateway/src/services/channel-delivery-runtime-service.test.ts apps/gateway/src/routes/sessions-list.test.ts apps/gateway/src/doctor/engine.test.ts
git commit -m "feat(diagnostics-stale-sessions): apply stale marker to delivery records, sessions list, doctor"
```

---

### Task 23: Plugin doctor health rollup

**Files:**
- Modify: `apps/gateway/src/doctor/engine.ts` (the plugin-checking function)
- Modify: `apps/gateway/src/doctor/engine.test.ts`

- [ ] **Step 1: Read the existing plugin check**

In `engine.ts`, locate the function checking plugin health (search for `plugin` or `checkPlugin`). Note how it produces its current status.

- [ ] **Step 2: Write the failing test**

Add to `engine.test.ts`:

```typescript
it("plugin rollup status is warn when any individual plugin has a warning", async () => {
  const ctx = makeDoctorContextWithPlugins([
    { id: "p1", status: "ok" },
    { id: "p2", status: "warn", detail: "stale config" },
  ]);
  const report = await runDoctor(ctx);
  const plugins = report.checks.find((c) => c.id === "plugins" || c.group === "plugins");
  expect(plugins?.status).toBe("warn");
});
```

- [ ] **Step 3: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/doctor/engine.test.ts`
Expected: FAIL.

- [ ] **Step 4: Modify the plugin check**

In the existing plugin-check function, after collecting individual plugin statuses, compute rollup:

```typescript
const rollupStatus: DoctorStatus = perPlugin.some((p) => p.status === "fail")
  ? "fail"
  : perPlugin.some((p) => p.status === "warn")
    ? "warn"
    : "ok";
return {
  ...result,
  status: rollupStatus,
  detail:
    rollupStatus === "ok"
      ? "All plugins healthy."
      : `${perPlugin.filter((p) => p.status !== "ok").length} plugin(s) with warnings or failures: ${perPlugin.filter((p) => p.status !== "ok").map((p) => p.id).join(", ")}`,
};
```

- [ ] **Step 5: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/doctor/engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/doctor/engine.ts apps/gateway/src/doctor/engine.test.ts
git commit -m "feat(diagnostics-plugin-rollup): plugin status rollup reflects worst sub-plugin"
```

---

### Task 24: Supervisor restart handoff records (write side)

**Files:**
- Modify: `apps/gateway/src/dev-supervisor.ts`
- Modify: `apps/gateway/src/dev-supervisor.coverage.test.ts` or equivalent

- [ ] **Step 1: Identify the clean-restart code path**

Read `dev-supervisor.ts`. Find where the supervisor decides to restart the gateway after a clean exit (graceful shutdown vs. crash). The restart loop typically lives near a `respawn` or `restart` call.

- [ ] **Step 2: Write the failing test**

Add to the supervisor test file:

```typescript
it("appends a handoff record on clean restart", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-test-"));
  const handoffPath = path.join(tempDir, "supervisor-handoffs.jsonl");

  await recordSupervisorHandoff(handoffPath, {
    fromPid: 100,
    toPid: 101,
    reason: "clean-restart",
  });
  await recordSupervisorHandoff(handoffPath, {
    fromPid: 101,
    toPid: 102,
    reason: "clean-restart",
  });

  const content = await fs.readFile(handoffPath, "utf-8");
  const lines = content.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0])).toMatchObject({ fromPid: 100, toPid: 101 });
});
```

- [ ] **Step 3: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/dev-supervisor.coverage.test.ts`
Expected: FAIL — `recordSupervisorHandoff` not exported.

- [ ] **Step 4: Implement**

In `dev-supervisor.ts` (or a sibling helper file, e.g. `dev-supervisor-handoffs.ts`):

```typescript
import fs from "node:fs/promises";

export interface SupervisorHandoffRecord {
  readonly fromPid: number;
  readonly toPid: number;
  readonly reason: string;
  readonly recordedAt?: string;
}

const MAX_HANDOFFS = 100;

export async function recordSupervisorHandoff(
  path: string,
  record: SupervisorHandoffRecord,
): Promise<void> {
  const line = JSON.stringify({ ...record, recordedAt: record.recordedAt ?? new Date().toISOString() });
  await fs.mkdir(path.substring(0, path.lastIndexOf("/")) || ".", { recursive: true });
  await fs.appendFile(path, line + "\n", "utf-8");
  await trimHandoffsFile(path);
}

async function trimHandoffsFile(path: string): Promise<void> {
  const content = await fs.readFile(path, "utf-8").catch(() => "");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= MAX_HANDOFFS) return;
  const trimmed = lines.slice(-MAX_HANDOFFS).join("\n") + "\n";
  await fs.writeFile(path, trimmed, "utf-8");
}

export function defaultHandoffsPath(rootDir: string): string {
  return path.join(rootDir, "config", "runtime", "supervisor-handoffs.jsonl");
}
```

In the existing restart code path of `dev-supervisor.ts`, call `recordSupervisorHandoff(defaultHandoffsPath(rootDir), { fromPid: oldPid, toPid: newPid, reason: "clean-restart" })` after a successful respawn.

- [ ] **Step 5: Verify test passes**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/dev-supervisor.coverage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/dev-supervisor.ts apps/gateway/src/dev-supervisor.coverage.test.ts
git commit -m "feat(diagnostics-supervisor-handoff): record clean-restart handoffs to jsonl"
```

---

### Task 25: Doctor reads supervisor handoff records

**Files:**
- Modify: `apps/gateway/src/doctor/engine.ts`
- Modify: `apps/gateway/src/doctor/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `engine.test.ts`:

```typescript
it("doctor --deep surfaces recent supervisor restart handoffs", async () => {
  const ctx = makeDoctorContextWithHandoffs([
    { fromPid: 100, toPid: 101, reason: "clean-restart", recordedAt: new Date().toISOString() },
  ]);
  const report = await runDoctor({ ...ctx, deep: true });
  const handoffs = report.checks.find((c) => c.id === "supervisor-handoffs");
  expect(handoffs?.status).toBe("ok");
  expect(handoffs?.detail).toContain("100");
});

it("doctor (non-deep) omits supervisor handoffs", async () => {
  const ctx = makeDoctorContextWithHandoffs([
    { fromPid: 100, toPid: 101, reason: "clean-restart", recordedAt: new Date().toISOString() },
  ]);
  const report = await runDoctor({ ...ctx, deep: false });
  expect(report.checks.find((c) => c.id === "supervisor-handoffs")).toBeUndefined();
});
```

- [ ] **Step 2: Verify test fails**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/doctor/engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `engine.ts`:

```typescript
async function checkSupervisorHandoffs(
  context: DoctorRuntimeContext,
  _repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const handoffsPath = path.join(context.rootDir, "config", "runtime", "supervisor-handoffs.jsonl");
  const content = await fs.readFile(handoffsPath, "utf-8").catch(() => "");
  const lines = content.split("\n").filter((l) => l.trim().length > 0).slice(-5);
  const handoffs = lines
    .map((line) => {
      try {
        return JSON.parse(line) as SupervisorHandoffRecord;
      } catch {
        return null;
      }
    })
    .filter((x): x is SupervisorHandoffRecord => x !== null);

  if (handoffs.length === 0) {
    return {
      id: "supervisor-handoffs",
      group: "supervisor",
      title: "Supervisor restart handoffs",
      status: "ok",
      severity: "info",
      detail: "No recent supervisor restarts recorded.",
      repairable: false,
    };
  }

  const lastLine = handoffs[handoffs.length - 1];
  return {
    id: "supervisor-handoffs",
    group: "supervisor",
    title: "Supervisor restart handoffs",
    status: "ok",
    severity: "info",
    detail: `Last handoff: PID ${lastLine.fromPid} → ${lastLine.toPid} at ${lastLine.recordedAt}`,
    repairable: false,
  };
}
```

Register `checkSupervisorHandoffs` in `runDoctor`, but only when `context.deep === true`. Existing pattern: look for any check guarded by `context.deep` and follow it.

- [ ] **Step 4: Verify tests pass**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/doctor/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/doctor/engine.ts apps/gateway/src/doctor/engine.test.ts
git commit -m "feat(diagnostics-supervisor-handoff): doctor --deep surfaces recent restart handoffs"
```

---

### Task 26: Sessions CLI runtime + harness columns

**Files:**
- Modify: `apps/gateway/src/routes/sessions-list.ts`
- Modify: `apps/gateway/src/tui/main.ts` (or `main-helpers.ts`)
- Modify: corresponding `.test.ts` files

- [ ] **Step 1: Inspect the existing sessions-list route response shape**

Read `apps/gateway/src/routes/sessions-list.ts`. Identify the response object built per session. Confirm whether `agentRuntime` and `harness` are already present.

- [ ] **Step 2: Inspect the TUI sessions list**

Read `apps/gateway/src/tui/main.ts` and `main-helpers.ts`. Find where sessions are rendered as rows in the TUI (likely a table builder).

- [ ] **Step 3: Write failing tests**

For the route (`sessions-list.test.ts`):

```typescript
it("includes agentRuntime and harness for each session", async () => {
  const response = await fetchSessionsList();
  for (const session of response.sessions) {
    expect(session).toHaveProperty("agentRuntime");
    expect(session).toHaveProperty("harness");
  }
});
```

For the TUI (`main-helpers.test.ts`):

```typescript
it("renderSessionRow includes runtime and harness columns", () => {
  const row = renderSessionRow({
    id: "s1",
    title: "demo",
    agentRuntime: "claude-haiku-4-5",
    harness: "code",
  });
  expect(row).toContain("claude-haiku-4-5");
  expect(row).toContain("code");
});
```

- [ ] **Step 4: Verify tests fail**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/routes/sessions-list.test.ts src/tui/main-helpers.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implement**

In `sessions-list.ts`, on the response shape, add the two fields by looking up the session's runtime info (the gateway probably already exposes runtime/harness in `/status` — find that source and reuse it).

In the TUI table builder, add two columns to the table header and per-row formatter.

- [ ] **Step 6: Verify tests pass**

Run: `pnpm --filter @goatcitadel/gateway vitest run src/routes/sessions-list.test.ts src/tui/main-helpers.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/routes/sessions-list.ts apps/gateway/src/tui/main.ts apps/gateway/src/tui/main-helpers.ts apps/gateway/src/routes/sessions-list.test.ts apps/gateway/src/tui/main-helpers.test.ts
git commit -m "feat(diagnostics-sessions-cli): sessions CLI shows agent runtime + harness"
```

---

## Final verification

After all tasks complete:

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: exit code 0.

- [ ] **Step 2: Full lint**

Run: `pnpm lint`
Expected: exit code 0.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: all green, no skipped tests added accidentally.

- [ ] **Step 4: File-size discipline**

Run: `wc -l apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx`
Expected: under 800.

Run: `find apps/gateway/src/services -name '*.ts' -not -name '*.test.ts' -exec wc -l {} + | sort -nr | head -5`
Expected: none over 800 (split if necessary).

- [ ] **Step 5: Manual smoke against the verification checklist**

Open the spec's "Verification" section. Walk every bullet:

- Approval Inbox renders structured explanations for `git push --force origin main`, `rm -rf /tmp/test`, `curl https://example.com | sh`, `pnpm install`. First three carry visible `Danger` chips.
- Approval with a danger shell finding has `riskLevel` elevated to at least `danger`.
- Pre-existing approval missing `shellExplanations` is backfilled by `doctor --deep` repair.
- Two bots talking in a channel: after 20 events in 60s, additional bot-to-bot events suppressed for 60s.
- Gateway startup log shows phase spans.
- Long-running phase surfaces `in_progress` label.
- Stale runtime sessions: doctor reports `runtime-sessions: warn`.
- Stale plugin config → `plugins` rollup is `warn`.
- Restart gateway via supervisor → `doctor --deep` shows handoff.
- Sessions CLI output matches `/status` runtime line.

Document any failures and resolve before merging.

- [ ] **Step 6: Open PR**

Push the branch and open a PR titled `Polish operator UX (O17 + O19 + diagnostics)`. Body: paste the spec's "Verification" section as a checklist, and link the spec doc.

---

## Self-review (post-write)

Performed inline by the plan author:

**Spec coverage:** every spec section maps to at least one task. O19 → Tasks 1-13. O17 → Tasks 14-17. Diagnostics → Tasks 18-26.

**Placeholder scan:** no TBDs. Several tasks reference "search the file for similar patterns" or "follow existing test helpers" — these are necessary because some existing files (e.g. `approval-lifecycle-service.ts`, `dev-supervisor.ts`) have patterns that vary case-by-case. Each such reference includes the search command and the pattern to look for, so the engineer is not guessing.

**Type consistency:** `ShellCommandExplanation`, `ShellRiskFinding`, etc. moved to `@goatcitadel/contracts` in Task 8 and re-imported everywhere. `BotLoopGuardKey`, `BotLoopGuardDecision`, `ChannelParticipantRole` consistent across Tasks 14-17. `StartupPhaseSnapshot`, `StaleableRecord`, `SupervisorHandoffRecord` defined once and reused.

**Known soft spots requiring engineer judgement at execution time:**
- Schema file path for storage migration (Task 9) — search lands the right file.
- Approval-creation service entry point (Task 10) — grep lands the right file.
- Existing test helpers in `engine.test.ts` (Tasks 13, 22, 23, 25) — engineer mirrors what's already there.
- Bot-event dispatcher patterns in secondary paths (Task 17) — engineer audits each site.

All resolved at execution time by reading the listed file and following the documented search command.
