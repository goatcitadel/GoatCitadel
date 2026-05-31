import { describe, expect, it } from "vitest";
import {
  CODE_MODE_AIDER_MESSAGE_FILE,
  buildCodeModeAiderAdapterInvocationPlan,
} from "./code-mode-aider-adapter-plan.js";

describe("code-mode-aider-adapter-plan", () => {
  it("builds a non-replayable command plan without putting the prompt in argv", () => {
    const plan = buildCodeModeAiderAdapterInvocationPlan({
      runId: "code-run-1",
      repositoryRootRelPath: "repo",
      model: "openai/gpt-5.4-mini",
    });

    expect(plan).toMatchObject({
      contractVersion: 1,
      adapterId: "aider-cli-adapter",
      runId: "code-run-1",
      repository: {
        rootRelPath: "repo",
      },
      command: {
        executable: "aider",
        cwdRelPath: "repo",
        messageFileRelPath: CODE_MODE_AIDER_MESSAGE_FILE,
      },
      replay: {
        replaySafe: false,
        policy: "audit_only",
      },
    });
    expect(plan.command.argv).toEqual([
      "aider",
      "--yes",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--message-file",
      CODE_MODE_AIDER_MESSAGE_FILE,
      "--model",
      "openai/gpt-5.4-mini",
    ]);
    expect(plan.command.argvRedacted).toEqual(plan.command.argv);
    expect(JSON.stringify(plan.command.argv)).not.toContain("implement this task");
  });

  it("keeps repository roots scoped to the Code Mode run workspace", () => {
    expect(
      buildCodeModeAiderAdapterInvocationPlan({
        runId: "code-run-1",
        repositoryRootRelPath: ".\\repo\\",
      }).repository.rootRelPath,
    ).toBe("./repo");

    expect(() =>
      buildCodeModeAiderAdapterInvocationPlan({
        runId: "code-run-1",
        repositoryRootRelPath: "../outside",
      }),
    ).toThrow("repository path must stay inside the Code Mode run workspace");

    expect(() =>
      buildCodeModeAiderAdapterInvocationPlan({
        runId: "code-run-1",
        repositoryRootRelPath: "/outside",
      }),
    ).toThrow("repository path must stay inside the Code Mode run workspace");
  });

  it("rejects unsafe command and run identifiers", () => {
    expect(() =>
      buildCodeModeAiderAdapterInvocationPlan({
        runId: "",
      }),
    ).toThrow("Aider adapter runId is required.");

    expect(() =>
      buildCodeModeAiderAdapterInvocationPlan({
        runId: "code-run-1",
        command: "aider\n--danger",
      }),
    ).toThrow("Aider adapter command contains unsafe characters.");
  });
});
