import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { groupToolRunRetries } from "./chat-tool-run-groups";

const run = (toolRunId: string, toolName: string, status: ChatToolRunRecord["status"]) =>
  ({
    toolRunId,
    toolName,
    status,
    turnId: "t",
    sessionId: "s",
    startedAt: "2026-10-28T00:00:00Z",
  }) as ChatToolRunRecord;

const shape = (runs: ChatToolRunRecord[]) =>
  groupToolRunRetries(runs).map((group) => [group.key, group.run.toolRunId, group.earlier.map((r) => r.toolRunId)]);

describe("groupToolRunRetries", () => {
  it("joins tries of a tool that follow its failures, keyed by the first try", () => {
    expect(
      shape([run("a", "shell.exec", "failed"), run("b", "shell.exec", "failed"), run("c", "shell.exec", "executed")]),
    ).toEqual([["a", "c", ["a", "b"]]]);
  });

  it("keeps a still-running retry in the same row", () => {
    expect(shape([run("a", "shell.exec", "failed"), run("b", "shell.exec", "started")])).toEqual([["a", "b", ["a"]]]);
  });

  it("does not join after a success, a block, or a different tool", () => {
    expect(
      shape([
        run("a", "shell.exec", "executed"),
        run("b", "shell.exec", "executed"),
        run("c", "shell.exec", "blocked"),
        run("d", "shell.exec", "failed"),
        run("e", "fs.read", "executed"),
      ]),
    ).toEqual([
      ["a", "a", []],
      ["b", "b", []],
      ["c", "c", []],
      ["d", "d", []],
      ["e", "e", []],
    ]);
  });
});
