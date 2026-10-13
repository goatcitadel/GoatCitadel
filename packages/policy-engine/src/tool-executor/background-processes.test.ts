import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../process-tree-killer.js", () => ({ terminateProcessTree: vi.fn() }));
import { terminateProcessTree } from "../process-tree-killer.js";
import {
  registerBackgroundProcess,
  killAllBackgroundProcesses,
  killTurnBackgroundProcesses,
} from "./background-processes.js";

function child(pid: number) {
  return Object.assign(new EventEmitter(), { pid }) as ChildProcess;
}
afterEach(() => {
  killAllBackgroundProcesses();
  vi.clearAllMocks();
});

describe("exact turn background ownership", () => {
  it("closes only the settled child's processes, preserving parent, sibling and unbound jobs", () => {
    const owned = child(101),
      parent = child(102),
      sibling = child(103),
      otherTurn = child(104),
      unbound = child(105);
    registerBackgroundProcess(owned, "fixture", undefined, { sessionId: "child", turnId: "turn" });
    registerBackgroundProcess(parent, "fixture", undefined, { sessionId: "parent", turnId: "turn" });
    registerBackgroundProcess(sibling, "fixture", undefined, { sessionId: "sibling", turnId: "turn" });
    registerBackgroundProcess(otherTurn, "fixture", undefined, { sessionId: "child", turnId: "other" });
    registerBackgroundProcess(unbound, "fixture");
    expect(killTurnBackgroundProcesses({ sessionId: "child", turnId: "turn" })).toBe(1);
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(terminateProcessTree).toHaveBeenCalledWith(expect.objectContaining({ child: owned }));
    expect(killTurnBackgroundProcesses({ sessionId: "child", turnId: "turn" })).toBe(0);
  });

  it("never adopts a reused PID when the registered child already exited", () => {
    const exited = child(201),
      replacement = child(201);
    registerBackgroundProcess(exited, "fixture", undefined, { sessionId: "child", turnId: "turn" });
    exited.emit("exit", 0);
    registerBackgroundProcess(replacement, "fixture", undefined, { sessionId: "sibling", turnId: "turn" });
    exited.emit("exit", 0);
    expect(killTurnBackgroundProcesses({ sessionId: "child", turnId: "turn" })).toBe(0);
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(killTurnBackgroundProcesses({ sessionId: "sibling", turnId: "turn" })).toBe(1);
  });

  it("rejects wildcard or missing ownership", () => {
    expect(() => killTurnBackgroundProcesses({ sessionId: "", turnId: "turn" })).toThrow(/exact turn/);
    expect(() => killTurnBackgroundProcesses({ sessionId: "child", turnId: "" })).toThrow(/exact turn/);
  });
});
