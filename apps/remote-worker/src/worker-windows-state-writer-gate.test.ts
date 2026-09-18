import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWindowsWorkerStateWriterGate } from "./worker-windows-state-writer-gate.js";
const mocks = vi.hoisted(() => ({ start: vi.fn(), pause: vi.fn(), resume: vi.fn(), install: vi.fn(), delay: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: () => () => ({
  startStateWriterGate: mocks.start, pauseStateWriterGate: mocks.pause, resumeStateWriterGate: mocks.resume,
}) }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("./worker-local-state-activity.js", () => ({ workerLocalStateActivity: { installWriterGate: mocks.install } }));
beforeEach(() => { vi.resetAllMocks(); mocks.start.mockReturnValue(true); mocks.pause.mockReturnValue(true); mocks.resume.mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());
describe.skipIf(process.platform !== "win32")("installed writer gate bridge", () => {
  it("starts native custody before installing the pause and resume callbacks", async () => {
    startWindowsWorkerStateWriterGate();
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(mocks.install.mock.invocationCallOrder[0]!);
    const gate = mocks.install.mock.calls[0]![0];
    gate.pause(); await gate.resume();
    expect(mocks.pause).toHaveBeenCalledExactlyOnceWith(); expect(mocks.resume).toHaveBeenCalledExactlyOnceWith();
  });
  it("waits for a competing controller hold before restoring writer custody", async () => {
    mocks.resume.mockReturnValueOnce(false).mockReturnValue(true);
    startWindowsWorkerStateWriterGate(); await mocks.install.mock.calls[0]![0].resume();
    expect(mocks.resume).toHaveBeenCalledTimes(2); expect(mocks.delay).toHaveBeenCalledExactlyOnceWith(10);
  });
  it("bounds unavailable native custody without pretending that a lock was restored", async () => {
    startWindowsWorkerStateWriterGate(); mocks.resume.mockReturnValue(false);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(5001);
    await expect(mocks.install.mock.calls[0]![0].resume()).rejects.toThrow("not restored");
    expect(mocks.resume).toHaveBeenCalledOnce(); expect(mocks.delay).not.toHaveBeenCalled();
  });
  it("refuses failed native initialization and pause", () => {
    mocks.start.mockReturnValue(false);
    expect(() => startWindowsWorkerStateWriterGate()).toThrow("unavailable"); expect(mocks.install).not.toHaveBeenCalled();
    mocks.start.mockReturnValue(true); startWindowsWorkerStateWriterGate(); mocks.pause.mockReturnValue(false);
    expect(() => mocks.install.mock.calls[0]![0].pause()).toThrow("cannot pause");
  });
});
