import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  advanceCodingWindow,
  applyCodingToolReceipts,
  buildCodingCheckpoint,
  chargeCodingActiveTime,
  codingTestReceipt,
  evaluateCodingCompletion,
  recoverCodingCheckpoint,
} from "./chat-sustained-coding-state.js";
import { resolveSustainedLocalCodingProfile } from "./chat-turn-execution-profile.js";
import { resolveChatExecutionBudget } from "./chat-agent-budget.js";

const request = [
  "Build a local PowerShell project. Create LogAnalyzer.psm1 and tests.ps1.",
  "Run:",
  "1. tests.ps1",
  "After tests pass, independently recompute median and p95 with Python.",
].join("\n");

function run(toolRunId: string, toolName: string, args: Record<string, unknown>, result: Record<string, unknown>, status: ChatToolRunRecord["status"] = "executed"): ChatToolRunRecord {
  return { toolRunId, toolName, args, result, status, turnId: "turn-1", sessionId: "session-1", startedAt: "2026-09-25T00:00:00Z" };
}

describe("sustained local coding admission and accounting", () => {
  it("admits both coding prompts, keeps report.json subordinate, and requires a recognized local durable route", () => {
    const seeded = "Create and repair a PowerShell project with RequestTools.psm1. Run tests.ps1 and compare report.json with raw requests.log.";
    for (const content of [seeded, request]) {
      expect(resolveSustainedLocalCodingProfile({ content, providerId: "llamacpp", durableEnabled: true })).toBe("sustained_local_coding");
      expect(resolveSustainedLocalCodingProfile({ content, providerId: "openai", durableEnabled: true })).toBe("standard");
      expect(resolveSustainedLocalCodingProfile({ content, providerId: "llamacpp", durableEnabled: false })).toBe("standard");
    }
    expect(resolveSustainedLocalCodingProfile({ content: "Explain how tests.ps1 works", providerId: "llamacpp", durableEnabled: true })).toBe("standard");
    expect(resolveSustainedLocalCodingProfile({ content: "Create Hello.ps1 in this workspace.", providerId: "llamacpp", durableEnabled: true })).toBe("sustained_local_coding");
    expect(resolveSustainedLocalCodingProfile({ content: "Build a local PowerShell project.", providerId: "llamacpp", durableEnabled: true })).toBe("sustained_local_coding");
    expect(resolveSustainedLocalCodingProfile({ content: "Write a report about this repo.", providerId: "llamacpp", durableEnabled: true })).toBe("standard");
    expect(resolveChatExecutionBudget({ mode: "chat", webMode: "off", thinkingLevel: "standard", providerId: "llamacpp", executionProfile: "sustained_local_coding" })).toMatchObject({
      turnBudgetMs: 720_000, completionTimeoutMs: 360_000, maxToolLoops: 8, maxToolRunsPerTurn: 12,
      maxTokens: 4096, searchMaxResults: 0, loopLimitBehavior: "checkpoint_continue",
    });
    expect(resolveChatExecutionBudget({ mode: "chat", webMode: "off", thinkingLevel: "standard", executionProfile: "sustained_local_coding", modelOutputTokenLimit: 2048 }).maxTokens).toBe(2048);
  });

  it("persists active accounting across recovery and excludes approval wait", () => {
    const initial = buildCodingCheckpoint({ turnId: "turn-1", userMessageId: "user-1", request, webOff: true, now: new Date("2026-09-25T00:00:00Z") });
    const charged = chargeCodingActiveTime(initial, new Date("2026-09-25T00:05:00Z"));
    expect(charged.activeUsedMs).toBe(300_000);
    const recovered = recoverCodingCheckpoint(JSON.parse(JSON.stringify(charged)), initial);
    expect(recovered?.activeUsedMs).toBe(300_000);
    expect(recovered?.toolCallsConsumed).toBe(0);
    expect(recoverCodingCheckpoint({ ...charged, toolCallsConsumed: 120 }, initial)?.toolCallsConsumed).toBe(120);
    expect(chargeCodingActiveTime(recovered!, new Date("2026-09-25T01:05:00Z"), true).activeUsedMs).toBe(300_000);
    expect(recoverCodingCheckpoint({ ...charged, requestSha256: "wrong" }, initial)).toBeUndefined();
    expect(evaluateCodingCompletion(initial, [], "Done.")).toContain("No successful coding tool receipt supports completion");
  });

  it("extracts the seeded task's explicit command and JSON output requirement", () => {
    const seeded = buildCodingCheckpoint({
      turnId: "turn-1", userMessageId: "user-1", webOff: true,
      request: [
        "Create and repair RequestTools.psm1, Invoke-RequestReport.ps1, tests.ps1, and requests.log.",
        "The CLI must create report.json.",
        "Run this from the project directory:",
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests.ps1",
      ].join("\n"),
    });
    expect(seeded.acceptance.requiredFiles).toContain("report.json");
    expect(seeded.acceptance.requiredCommands).toContain("tests.ps1");
  });

  it("uses settled receipts for repair, no-progress windows, and completion", () => {
    let state = buildCodingCheckpoint({ turnId: "turn-1", userMessageId: "user-1", request, webOff: true });
    const receipts = [
      run("write-module", "fs.write", { path: "C:\\work\\LogAnalyzer.psm1", content: "old" }, { path: "C:\\work\\LogAnalyzer.psm1" }),
      run("write-test", "fs.write", { path: "C:\\work\\tests.ps1", content: "test" }, { path: "C:\\work\\tests.ps1" }),
      run("test-fail", "shell.exec", { command: "powershell.exe -File tests.ps1" }, { exitCode: 1, stderr: "median mismatch" }),
      run("repair", "fs.patch", { path: "C:\\work\\LogAnalyzer.psm1" }, { path: "C:\\work\\LogAnalyzer.psm1", afterSha256: "abc" }),
      run("test-pass", "shell.exec", { command: "powershell.exe -File tests.ps1" }, { exitCode: 0, stdout: "27/27 tests passed" }),
      run("verify", "shell.exec", { command: "python -c \"from verify import recompute; raw=open('logs/data.log').read(); expected=open('output.json').read(); assert recompute(raw) == expected # median p95\"" }, { exitCode: 0, stdout: "matched" }),
      run("module-exists", "fs.stat", { path: "C:\\work\\LogAnalyzer.psm1" }, { path: "C:\\work\\LogAnalyzer.psm1", isFile: true }),
      run("test-exists", "fs.stat", { path: "C:\\work\\tests.ps1" }, { path: "C:\\work\\tests.ps1", isFile: true }),
    ];
    state = applyCodingToolReceipts(state, receipts);
    expect(state.firstTest?.passed).toBe(false);
    expect(state.latestTest?.passed).toBe(true);
    expect(state.latestTest?.evidenceLabel).toBe("27/27 tests passed");
    expect(state.repairCount).toBe(1);
    expect(state.changedFileHashes["C:\\work\\LogAnalyzer.psm1"]).toBe("abc");
    expect(evaluateCodingCompletion(state, receipts, "Tests passed; separate calculation matched.")).toEqual([]);
    expect(evaluateCodingCompletion(state, receipts, "27/27 tests passed; independently verified.")).toContain("No trusted independent verifier receipt supports that claim; describe the separate verification command instead");
    expect(evaluateCodingCompletion(state, receipts, "27/27 tests passed.")).toEqual([]);
    expect(evaluateCodingCompletion(state, receipts, "28/28 tests passed.")).toContain("No final test receipt supports 28/28 tests passed");
    expect(evaluateCodingCompletion(state, receipts, "No files outside C:\\work were modified.")).toContain("No recorded filesystem-wide audit supports the out-of-scope modification claim");
    expect(evaluateCodingCompletion(state, [...receipts,
      run("late-shell-edit", "shell.exec", { command: "Set-Content C:\\work\\LogAnalyzer.psm1 -Value broken" }, { exitCode: 0 }),
    ], "Tests passed.")).toContain("No passing test receipt after the last source edit");
    expect(evaluateCodingCompletion(state, [...receipts,
      run("late-test-fail", "shell.exec", { command: "powershell.exe -File tests.ps1" }, { exitCode: 1, stderr: "regression" }),
    ], "All tests passed.")).toContain("The answer claims passing tests without a final passing test receipt");
    expect(evaluateCodingCompletion(state, receipts.slice(0, 6), "Tests passed; separate calculation matched.")).toContain("No fresh file existence receipt for LogAnalyzer.psm1");
    expect(evaluateCodingCompletion(state, receipts.slice(0, 4), "All tests passed; independently verified.")).toContain("No passing test receipt after the last source edit");
    expect(evaluateCodingCompletion(state, receipts.filter((receipt) => receipt.toolRunId !== "verify"), "Separate verification matched.")).toContain("No separate verification receipt after the passing tests");
    expect(evaluateCodingCompletion(state, receipts.map((receipt) => receipt.toolRunId === "verify"
      ? { ...receipt, result: { exitCode: 1, stderr: "verification mismatch" } }
      : receipt), "Separate verification matched.")).toContain("No separate verification receipt after the passing tests");
    expect(evaluateCodingCompletion(state, [...receipts,
      run("no-op-verify", "shell.exec", { command: "python -c \"print('median p95')\"" }, { exitCode: 0 }),
    ].filter((receipt) => receipt.toolRunId !== "verify"), "Separate verification matched.")).toContain("No separate verification receipt after the passing tests");
    expect(codingTestReceipt(run("read-test", "shell.exec", { command: "Get-Content .\\tests.ps1" }, { exitCode: 0 }))).toBeUndefined();
    expect(codingTestReceipt(run("search-test", "shell.exec", { command: "rg test ." }, { exitCode: 0 }))).toBeUndefined();
    expect(evaluateCodingCompletion(state, receipts.filter((receipt) => receipt.toolRunId !== "test-pass").concat(
      run("read-test", "shell.exec", { command: "Get-Content .\\tests.ps1" }, { exitCode: 0 }),
    ), "Done.")).toContain("No successful run receipt for tests.ps1");
    const scoped = buildCodingCheckpoint({ turnId: "turn-1", userMessageId: "user-1", request: `WORK ONLY INSIDE:\nC:\\work\n${request}`, webOff: true });
    const wrongDirectoryStats = receipts.map((receipt) => receipt.toolName === "fs.stat"
      ? { ...receipt, args: { path: String(receipt.args.path).replace("C:\\work", "C:\\other") }, result: { ...receipt.result, path: String(receipt.result?.path).replace("C:\\work", "C:\\other") } }
      : receipt);
    expect(evaluateCodingCompletion(scoped, wrongDirectoryStats, "Done.")).toContain("No fresh file existence receipt for LogAnalyzer.psm1");
    expect(evaluateCodingCompletion(state, [...receipts,
      run("late-python-edit", "shell.exec", { command: "python -c \"open('LogAnalyzer.psm1','w').write('broken')\"" }, { exitCode: 0 }),
      ...receipts.slice(-2),
    ], "Done.")).toContain("No passing test receipt after the last source edit");
    state = advanceCodingWindow(state);
    expect(state.noProgressWindows).toBe(0);
    expect(advanceCodingWindow(state).noProgressWindows).toBe(1);
    expect(advanceCodingWindow(advanceCodingWindow(state)).noProgressWindows).toBe(2);
    expect(applyCodingToolReceipts(state, receipts).repairCount).toBe(1);
    const observed = applyCodingToolReceipts(state, [...receipts,
      run("read-after-shell", "fs.read", { path: "C:\\work\\LogAnalyzer.psm1" }, { path: "C:\\work\\LogAnalyzer.psm1", sha256: "def" }),
    ]);
    expect(observed.changedFileHashes["C:\\work\\LogAnalyzer.psm1"]).toBe("def");
    expect(observed.repairCount).toBe(1);
  });

  it("counts repair cycles once and does not treat inspection as window progress", () => {
    const initial = buildCodingCheckpoint({ turnId: "turn-1", userMessageId: "user-1", request, webOff: true });
    const failed = applyCodingToolReceipts(initial, [
      run("test-fail", "shell.exec", { command: "pwsh -File tests.ps1" }, { exitCode: 1, stderr: "mismatch" }),
    ]);
    const firstRepair = applyCodingToolReceipts(failed, [
      run("test-fail", "shell.exec", { command: "pwsh -File tests.ps1" }, { exitCode: 1, stderr: "mismatch" }),
      run("edit-1", "fs.write", { path: "C:\\work\\LogAnalyzer.psm1", content: "fixed" }, { path: "C:\\work\\LogAnalyzer.psm1" }),
      run("edit-2", "fs.write", { path: "C:\\work\\tests.ps1", content: "fixed" }, { path: "C:\\work\\tests.ps1" }),
    ]);
    expect(firstRepair.repairCount).toBe(1);
    const afterPass = applyCodingToolReceipts(firstRepair, [
      run("test-fail", "shell.exec", { command: "pwsh -File tests.ps1" }, { exitCode: 1 }),
      run("edit-1", "fs.write", { path: "C:\\work\\LogAnalyzer.psm1", content: "fixed" }, { path: "C:\\work\\LogAnalyzer.psm1" }),
      run("edit-2", "fs.write", { path: "C:\\work\\tests.ps1", content: "fixed" }, { path: "C:\\work\\tests.ps1" }),
      run("test-pass", "shell.exec", { command: "pwsh -File tests.ps1" }, { exitCode: 0 }),
      run("later-edit", "fs.write", { path: "C:\\work\\tests.ps1", content: "later" }, { path: "C:\\work\\tests.ps1" }),
    ]);
    expect(afterPass.repairCount).toBe(1);
    const readOnly = applyCodingToolReceipts(initial, [run("inspect", "fs.read", { path: "C:\\work\\LogAnalyzer.psm1" }, { path: "C:\\work\\LogAnalyzer.psm1", sha256: "abc" })]);
    expect(advanceCodingWindow(readOnly).noProgressWindows).toBe(1);
  });
});
