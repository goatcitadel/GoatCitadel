import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { terminatePosixProcess, type PosixTerminationHooks } from "./llama-cpp-runtime-service.js";

describe("terminatePosixProcess", () => {
  const pid = 24_680;
  const child = {} as ChildProcess;

  it("returns after the process group exits from SIGTERM", async () => {
    const signalTree = vi.fn<NonNullable<PosixTerminationHooks["signalTree"]>>(() => "group");
    const waitForTreeExit = vi.fn<NonNullable<PosixTerminationHooks["waitForTreeExit"]>>(async () => true);

    await terminatePosixProcess(child, pid, { signalTree, waitForTreeExit });

    expect(signalTree).toHaveBeenCalledTimes(1);
    expect(signalTree).toHaveBeenCalledWith(pid, "SIGTERM");
    expect(waitForTreeExit).toHaveBeenCalledOnce();
    expect(waitForTreeExit).toHaveBeenCalledWith(child, pid, "group", 5_000);
  });

  it("escalates a timed-out SIGTERM to SIGKILL and returns after the group exits", async () => {
    const signalTree = vi.fn<NonNullable<PosixTerminationHooks["signalTree"]>>(() => "group");
    const waitForTreeExit = vi
      .fn<NonNullable<PosixTerminationHooks["waitForTreeExit"]>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await terminatePosixProcess(child, pid, { signalTree, waitForTreeExit });

    expect(signalTree.mock.calls).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
    expect(waitForTreeExit.mock.calls).toEqual([
      [child, pid, "group", 5_000],
      [child, pid, "group", 1_000],
    ]);
  });

  it("rejects when the process group remains alive after SIGKILL", async () => {
    const signalTree = vi.fn<NonNullable<PosixTerminationHooks["signalTree"]>>(() => "group");
    const waitForTreeExit = vi.fn<NonNullable<PosixTerminationHooks["waitForTreeExit"]>>(async () => false);

    await expect(terminatePosixProcess(child, pid, { signalTree, waitForTreeExit })).rejects.toThrow(
      `llama.cpp process tree ${pid} remained alive after SIGKILL`,
    );

    expect(signalTree.mock.calls).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
    expect(waitForTreeExit).toHaveBeenCalledTimes(2);
  });

  it("propagates a SIGTERM signaling error without waiting", async () => {
    const signalError = new Error("SIGTERM denied");
    const signalTree = vi.fn<NonNullable<PosixTerminationHooks["signalTree"]>>(() => {
      throw signalError;
    });
    const waitForTreeExit = vi.fn<NonNullable<PosixTerminationHooks["waitForTreeExit"]>>();

    await expect(terminatePosixProcess(child, pid, { signalTree, waitForTreeExit })).rejects.toBe(signalError);

    expect(signalTree).toHaveBeenCalledWith(pid, "SIGTERM");
    expect(waitForTreeExit).not.toHaveBeenCalled();
  });

  it("propagates a SIGKILL signaling error after SIGTERM times out", async () => {
    const signalError = new Error("SIGKILL denied");
    const signalTree = vi
      .fn<NonNullable<PosixTerminationHooks["signalTree"]>>()
      .mockReturnValueOnce("group")
      .mockImplementationOnce(() => {
        throw signalError;
      });
    const waitForTreeExit = vi.fn<NonNullable<PosixTerminationHooks["waitForTreeExit"]>>(async () => false);

    await expect(terminatePosixProcess(child, pid, { signalTree, waitForTreeExit })).rejects.toBe(signalError);

    expect(signalTree.mock.calls).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
    expect(waitForTreeExit).toHaveBeenCalledOnce();
  });
});
