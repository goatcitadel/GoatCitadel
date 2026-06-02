#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const execFileAsync = promisify(execFile);

const CHECK_GROUPS = Object.freeze({
  contracts: {
    title: "Agentic contracts and API anchors",
    checks: [
      fileContains("docs/COWORK_CODE_BOUNDARIES.md", [
        "review-first",
        "trusted-code, operator-governed",
        "not a hostile-code sandbox claim",
        "gated by availability",
      ]),
      fileContains("packages/contracts/src/agentic-runtime.ts", [
        "AgenticSurface",
        "AgenticTaskContext",
        "AgenticRunTreeResponse",
        "AgenticControlDescriptor",
        "AgenticCapabilityAvailability",
        "controlId",
        "idempotentReplay",
      ]),
      fileContains("packages/contracts/src/index.ts", ["./agentic-runtime.js"]),
      fileContains("apps/gateway/src/routes/orchestration.ts", ["orchestration"]),
      fileContains("apps/gateway/src/routes/improvement.ts", ["improvement"]),
      fileContains("apps/gateway/src/routes/capabilities.ts", ["capabilities"]),
      fileContains("apps/gateway/src/orchestration/policies/cowork-policy.ts", ["cowork"]),
      fileContains("apps/gateway/src/orchestration/policies/code-policy.ts", ["code"]),
    ],
  },
  behavioral: {
    title: "Agentic behavior-backed callable-boundary checks",
    checks: [
      commandCheck(
        "Runtime availability and proposal trust behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/routes/tasks.test.ts",
          "src/services/agentic-capability-availability.test.ts",
          "src/services/agentic-harness-availability.test.ts",
          "src/services/plugin-provider-governance-service.test.ts",
          "src/services/agentic-improvement-bridge-service.test.ts",
        ],
        {
          timeoutMs: 180_000,
          minimumPassedTests: 12,
          expectedStdout: [
            "exposes normalized agentic runtime availability",
            "keeps corrupt plugin manifests unavailable and non-callable",
            "keeps corrupt provider manifests quarantined from callable exposure",
            "hides configured harness capability when the executable is missing",
            "converts skill drift, memory misses, and repeated failures into proposal-only review records",
          ],
        },
      ),
    ],
  },
  availability: {
    title: "Agentic availability route and callable-boundary behavior",
    checks: [
      commandCheck(
        "Agentic availability route and runtime normalization behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/routes/tasks.test.ts",
          "src/services/agentic-capability-availability.test.ts",
          "src/services/agentic-harness-availability.test.ts",
          "src/services/plugin-provider-governance-service.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "exposes normalized agentic runtime availability",
            "normalizes harnesses, providers, plugins, and channels into one non-callable-safe surface",
            "keeps corrupt plugin manifests unavailable and non-callable",
            "keeps corrupt provider manifests quarantined from callable exposure",
            "hides configured harness capability when the executable is missing",
          ],
        },
      ),
    ],
  },
  workbench: {
    title: "Code Workbench patch/test/apply/export/revert behavior",
    checks: [
      commandCheck(
        "Code Workbench service and route behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/chat-workbench-service.test.ts",
          "src/routes/chat.routes.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "chat workbench helpers",
            "runs commands in an existing workbench worktree and updates validation state",
            "exports, applies, and reverts workbench patches inside the project scope",
            "removes untracked files when reverting all workbench changes",
            "serves session-scoped workbench routes",
          ],
        },
      ),
      commandCheck(
        "Patch review claim verification behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/agentic-patch-review-service.test.ts",
        ],
        {
          timeoutMs: 120_000,
          expectedStdout: [
            "agentic patch review service",
            "records apply, export, and revert lifecycle state",
            "verifies claimed files, tests, and artifacts",
          ],
        },
      ),
    ],
  },
  channels: {
    title: "Durable channel delivery retry, stale-state, and route behavior",
    checks: [
      commandCheck(
        "Gateway channel delivery runtime behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/channel-delivery-runtime-service.test.ts",
          "src/routes/comms.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "deduplicates queued deliveries by idempotency key",
            "backs off retryable delivery failures and later marks sent",
            "marks overdue queued deliveries stale without sending",
            "lists channel delivery runtime records with retry and stale state visible",
            "filters channel delivery runtime records by connection id and caps the limit",
          ],
        },
      ),
      commandCheck(
        "Storage delivery-attempt persistence behavior",
        "pnpm",
        ["--filter", "@goatcitadel/storage", "test", "--", "--test-name-pattern", "CommsDeliveryRepository"],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "persists queued delivery retry metadata and idempotency lookup",
            "persists stale final-delivery state separately from provider failures",
          ],
        },
      ),
    ],
  },
  governance: {
    title: "Review-first governance anchors",
    checks: [
      fileContains("docs/COWORK_CODE_BOUNDARIES.md", [
        "Self-Improvement Boundary",
        "generated candidates remain proposals or candidates",
        "mutation paths require explicit approval",
      ]),
      fileContains("docs/CAPABILITY_SYSTEM_V1.md", [
        "Only `callableCatalog` may feed planning",
        "trusted-code only",
        "no hostile-code guarantees",
        "Proposals and unactivated candidates are inspectable",
      ]),
      fileContains("docs/CANONICAL_RUNTIME_STATE_MODEL.md", [
        "Mission-session Chat / Cowork / Code",
        "Cowork/orchestration runs are durable-run backed",
        "Approval-gated orchestration resume must re-enter the linked durable run",
      ]),
      fileContains("apps/gateway/src/services/improvement-service.ts", [
        "ready_for_approval",
        "approval_pending",
        "applyApprovedActivation",
        "recordAgenticDiagnosticSignal",
        "agentic_diagnostic",
      ]),
      fileContains("apps/gateway/src/services/capability-system-service.ts", [
        "listCatalog(\"inspectable\")",
        "callableEntries",
        "approval",
      ]),
      fileContains("apps/gateway/src/services/durable-run-service.ts", ["checkpointKind", "run_resumed"]),
      fileContains("packages/contracts/src/durable.ts", ["approval.wait", "approvalId"]),
      commandCheck(
        "Permission profiles and Local Operator Override storage behavior",
        "pnpm",
        ["--filter", "@goatcitadel/storage", "exec", "tsx", "--test", "src/permission-profile-repo.test.ts"],
        {
          timeoutMs: 120_000,
        },
      ),
      commandCheck(
        "Gateway permission profile and plugin override governance behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/routes/tools.permission-profiles.test.ts",
          "src/services/plugin-tool-override-service.test.ts",
          "src/services/tool-invocation-coordinator-service.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "routes execution to plugin override handler when an active override exists",
            "blocks plugin overrides when final policy would require approval",
          ],
        },
      ),
      commandCheck(
        "Subagent permission inheritance and approval wait truth",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/chat-delegation-service.loop20-worker-a.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "carries the parent permission profile and override into delegated child turns",
            "keeps waiting delegate responses active",
          ],
        },
      ),
      commandCheck(
        "Code Mode profile and override inheritance behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/capability-system-service.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "freezes Code Mode wrapper policy context at run approval time",
            "does not silently swap an explicit Code Mode permission profile during policy resolution",
            "expires a Code Mode pending action that was not resolved before its TTL",
          ],
        },
      ),
    ],
  },
  marketplace: {
    title: "Plugin/provider marketplace callable-boundary behavior",
    checks: [
      commandCheck(
        "Plugin/provider quarantine and callable exposure behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/plugin-provider-governance-service.test.ts",
          "src/services/agentic-capability-availability.test.ts",
          "src/routes/tasks.test.ts",
        ],
        {
          timeoutMs: 120_000,
          expectedStdout: [
            "keeps corrupt plugin manifests unavailable and non-callable",
            "keeps corrupt provider manifests quarantined from callable exposure",
            "allows callable exposure only after integrity, approval, availability, and health pass",
            "marks non-inspectable capabilities unavailable even when a runtime says callable",
            "exposes normalized agentic runtime availability",
          ],
        },
      ),
    ],
  },
  selfImprovement: {
    title: "Self-improvement and curator review-first behavior",
    checks: [
      commandCheck(
        "Agentic improvement bridge proposal behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/agentic-improvement-bridge-service.test.ts",
          "src/services/curation-review-service.test.ts",
          "src/services/skill-evaluation-service.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "converts skill drift, memory misses, and repeated failures into proposal-only review records",
            "creates approval-gated proposals without mutating targets",
            "does not write skill files",
          ],
        },
      ),
      commandCheck(
        "Proposal review routes preserve review-first mutation boundaries",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/routes/skills.test.ts",
          "src/routes/capabilities.test.ts",
          "src/routes/improvement.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "previews and stores skill evaluation runs through the skill route service",
            "creates skill evaluation proposals from accepted runs",
            "creates a capability proposal through the capability route service",
            "serves ledger signal, candidate, and activation detail routes",
          ],
        },
      ),
      commandCheck(
        "Improvement ledger approval-gated mutation behavior",
        "pnpm",
        [
          "exec",
          "tsx",
          "--test",
          "apps/gateway/src/services/improvement-service.node.test.ts",
          "apps/gateway/src/improvement-operator-proof.node.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "persists agentic bridge proposals as governed candidates with mutationApplied=false",
            "keeps review-first skill drift proposals from mutating through direct activation",
            "serves ledger and legacy improvement endpoints without server errors",
          ],
        },
      ),
    ],
  },
  harnesses: {
    title: "External harness availability boundary anchors",
    checks: [
      fileContains("docs/COWORK_CODE_BOUNDARIES.md", [
        "External Harness Boundary",
        "gated by availability and operator intent",
        "must not claim full parity",
      ]),
      fileContains("docs/HARNESS_AUDIT_LENS.md", [
        "external",
        "review",
        "GoatCitadel already owns orchestration",
      ]),
      fileContains("docs/review/HERMES_GOATCITADEL_PARITY_AUDIT_2026-05-02.md", [
        "Hermes",
        "Curator/self-improvement",
        "Do not adopt Python gateway runtime",
      ]),
      fileContains("goatcitadel_prompt_pack_v4_agentic_focused.md", ["Cowork", "Code"]),
      fileContains("apps/gateway/src/services/prompt-pack-service.ts", [
        "agentic_surface",
        "single_turn_harness",
        "normalizePromptPackAgenticResponse",
      ]),
      commandCheck(
        "Harness availability and scripted runner behavior",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/services/agentic-harness-availability.test.ts",
          "src/services/agentic-scripted-runner.test.ts",
        ],
        {
          timeoutMs: 120_000,
          expectedStdout: [
            "emits registry-backed records for all external harnesses and the governed scripted runner",
            "marks scripted runner not configured until policy-approved tool names are provided",
            "exposes only policy-approved tool names and keeps final output bounded",
          ],
        },
      ),
      commandCheck(
        "Agentic availability route exposes harness/provider/plugin/channel callability",
        "pnpm",
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "--reporter",
          "verbose",
          "src/routes/tasks.test.ts",
          "src/services/agentic-capability-availability.test.ts",
          "src/services/agentic-harness-availability.test.ts",
        ],
        {
          timeoutMs: 180_000,
          expectedStdout: [
            "exposes normalized agentic runtime availability",
            "normalizes harnesses, providers, plugins, and channels into one non-callable-safe surface",
            "hides configured harness capability when the executable is missing",
          ],
        },
      ),
    ],
  },
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = String(args.profile ?? args._[0] ?? "contracts");
  const group = CHECK_GROUPS[profile];
  if (!group) {
    throw new Error(`Unknown agentic proof profile: ${profile}`);
  }

  const checks = [];
  for (const check of group.checks) {
    checks.push(await runCheck(check));
  }

  const missing = checks.filter((check) => check.status !== "passed");
  const proof = {
    profile,
    title: group.title,
    status: missing.length === 0 ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    repoRoot,
    checks,
    summary: {
      total: checks.length,
      passed: checks.length - missing.length,
      failed: missing.length,
    },
  };

  if (args.output) {
    const outputPath = path.resolve(repoRoot, String(args.output));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  } else {
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  }

  if (missing.length > 0) {
    throw new Error(`Agentic proof profile '${profile}' failed ${missing.length} check(s).`);
  }
}

function fileContains(file, patterns) {
  return {
    kind: "file_contains",
    file,
    patterns,
  };
}

function commandCheck(title, command, args, options = {}) {
  return {
    kind: "command",
    title,
    command,
    args,
    timeoutMs: options.timeoutMs ?? 120_000,
    expectedStdout: options.expectedStdout ?? [],
    minimumPassedTests: options.minimumPassedTests,
  };
}

async function runCheck(check) {
  if (check.kind === "command") {
    const startedAt = Date.now();
    try {
      const invocation = resolveInvocation(check.command, check.args);
      const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
        cwd: repoRoot,
        timeout: check.timeoutMs,
        maxBuffer: 1024 * 1024 * 8,
        windowsHide: true,
        env: {
          ...process.env,
          CI: process.env.CI ?? "1",
        },
      });
      const output = `${stdout}\n${stderr}`;
      const missingOutput = check.expectedStdout.filter((needle) => !output.includes(needle));
      const passedTestCount = readPassedTestCount(output);
      const testCountShortfall =
        typeof check.minimumPassedTests === "number" && passedTestCount < check.minimumPassedTests
          ? [`Expected at least ${check.minimumPassedTests} passed tests, saw ${passedTestCount}.`]
          : [];
      const missing = [...missingOutput, ...testCountShortfall];
      return {
        title: check.title,
        kind: "command",
        command: [check.command, ...check.args].join(" "),
        status: missing.length === 0 ? "passed" : "missing_output",
        durationMs: Date.now() - startedAt,
        expectedStdout: check.expectedStdout,
        minimumPassedTests: check.minimumPassedTests,
        passedTestCount,
        missingOutput: missing,
        stdoutTail: clampString(stdout, 4000),
        stderrTail: clampString(stderr, 4000),
      };
    } catch (error) {
      return {
        title: check.title,
        kind: "command",
        command: [check.command, ...check.args].join(" "),
        status: "failed",
        durationMs: Date.now() - startedAt,
        expectedStdout: check.expectedStdout,
        exitCode: typeof error?.code === "number" ? error.code : undefined,
        signal: error?.signal,
        error: error instanceof Error ? error.message : String(error),
        stdoutTail: clampString(String(error?.stdout ?? ""), 4000),
        stderrTail: clampString(String(error?.stderr ?? ""), 4000),
      };
    }
  }

  const targetPath = path.join(repoRoot, check.file);
  let source;
  try {
    source = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    return {
      file: check.file,
      status: "missing_file",
      missingPatterns: check.patterns,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const missingPatterns = check.patterns.filter((pattern) => !source.includes(pattern));
  return {
    file: check.file,
    status: missingPatterns.length === 0 ? "passed" : "missing_patterns",
    requiredPatterns: check.patterns,
    missingPatterns,
  };
}

function clampString(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 32))}\n…truncated ${value.length - maxLength + 32} chars`;
}

function readPassedTestCount(output) {
  const normalized = stripAnsi(output).replace(/\s+/g, " ");
  const matches = [...normalized.matchAll(/Tests\s+(\d+)\s+passed/g)];
  if (matches.length === 0) {
    return 0;
  }
  return matches.reduce((total, match) => total + Number(match[1] ?? 0), 0);
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function resolveInvocation(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", quoteWindowsCommand([command, ...args])],
  };
}

function quoteWindowsCommand(parts) {
  return parts
    .map((part) => {
      const value = String(part);
      if (value.length === 0) {
        return '""';
      }
      if (!/[\s"&()^<>|]/.test(value)) {
        return value;
      }
      return `"${value.replace(/(["\\])/g, "\\$1")}"`;
    })
    .join(" ");
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.split("=", 2);
    const key = rawKey.slice(2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
