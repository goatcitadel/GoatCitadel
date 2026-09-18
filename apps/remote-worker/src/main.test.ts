import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConnectedWorkerStartup } from "./worker-runtime-config.js";
import { runWorkerProcess } from "./worker-process-runtime.js";
import { acquireWorkerStateOwnership } from "./worker-state-ownership.js";
import { attachWorkerHostControl } from "./worker-host-control.js";
import { createWindowsInstalledNativeRuntime } from "./worker-windows-installed-runtime.js";
import { startWindowsWorkerStateWriterGate } from "./worker-windows-state-writer-gate.js";
import { CONNECTED_WORKER_ENV, WORKER_HOST_CONTROL_PROTOCOL } from "./worker-environment.js";

vi.mock("./worker-runtime-config.js", () => ({ parseConnectedWorkerStartup: vi.fn() }));
vi.mock("./worker-process-runtime.js", () => ({ runWorkerProcess: vi.fn(), WorkerProcessRecoveryRequiredError: class extends Error {} }));
vi.mock("./worker-state-ownership.js", () => ({ acquireWorkerStateOwnership: vi.fn() }));
vi.mock("./worker-process-report.js", () => ({ writeWorkerProcessReport: vi.fn() }));
vi.mock("./worker-host-control.js", () => ({ attachWorkerHostControl: vi.fn() }));
vi.mock("./worker-windows-installed-runtime.js", () => ({ createWindowsInstalledNativeRuntime: vi.fn() }));
vi.mock("./worker-windows-state-writer-gate.js", () => ({ startWindowsWorkerStateWriterGate: vi.fn() }));
vi.mock("./worker-mesh-capability-runtime.js", () => ({ WorkerMeshCapabilityRuntime: class {} }));

const originalExitCode = process.exitCode;
beforeEach(() => { vi.resetAllMocks(); vi.resetModules(); vi.stubEnv(CONNECTED_WORKER_ENV.hostControl, undefined); });
afterEach(() => { process.exitCode = originalExitCode; vi.unstubAllEnvs(); });

describe("worker process entrypoint native composition", () => {
  it("refuses protected startup before touching state when native writer custody is unavailable", async () => {
    vi.stubEnv(CONNECTED_WORKER_ENV.hostControl, WORKER_HOST_CONTROL_PROTOCOL);
    vi.mocked(parseConnectedWorkerStartup).mockReturnValue({ config: {} as ReturnType<typeof parseConnectedWorkerStartup>["config"],
      protectedKeys: { reference: {} } as NonNullable<ReturnType<typeof parseConnectedWorkerStartup>["protectedKeys"]> });
    const detach = vi.fn(); vi.mocked(attachWorkerHostControl).mockReturnValue(detach);
    vi.mocked(startWindowsWorkerStateWriterGate).mockImplementation(() => { throw new Error("custody unavailable"); });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await import("./main.js");
      expect(acquireWorkerStateOwnership).not.toHaveBeenCalled(); expect(runWorkerProcess).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
    } finally { stderr.mockRestore(); }
  });
  it.each([[false, false], [true, false], [true, true]])("composes native runtime and writer custody (protected=%s, hosted=%s)", async (protectedStartup, hosted) => {
    if (hosted) vi.stubEnv(CONNECTED_WORKER_ENV.hostControl, WORKER_HOST_CONTROL_PROTOCOL);
    const config = { stateDir: "unused-fixture-state", reportFile: "unused-fixture-report" } as ReturnType<typeof parseConnectedWorkerStartup>["config"];
    const keys = { reference: {} } as NonNullable<ReturnType<typeof parseConnectedWorkerStartup>["protectedKeys"]>;
    const release = vi.fn(async () => {}), detach = vi.fn(), nativeRuntime = { run: vi.fn() };
    vi.mocked(parseConnectedWorkerStartup).mockReturnValue({ config, ...(protectedStartup ? { protectedKeys: keys } : {}) });
    vi.mocked(acquireWorkerStateOwnership).mockResolvedValue(release);
    vi.mocked(attachWorkerHostControl).mockReturnValue(detach);
    vi.mocked(createWindowsInstalledNativeRuntime).mockReturnValue(nativeRuntime);
    const sigintListeners = process.listenerCount("SIGINT"), sigtermListeners = process.listenerCount("SIGTERM");
    await import("./main.js");
    expect(runWorkerProcess).toHaveBeenCalledExactlyOnceWith(config,
      expect.objectContaining({ nativeRuntime: protectedStartup ? nativeRuntime : undefined }));
    expect(createWindowsInstalledNativeRuntime).toHaveBeenCalledTimes(protectedStartup ? 1 : 0);
    expect(startWindowsWorkerStateWriterGate).toHaveBeenCalledTimes(hosted ? 1 : 0);
    if (hosted) expect(vi.mocked(startWindowsWorkerStateWriterGate).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(acquireWorkerStateOwnership).mock.invocationCallOrder[0]!);
    if (protectedStartup) expect(createWindowsInstalledNativeRuntime).toHaveBeenCalledWith(keys);
    expect(release).toHaveBeenCalledOnce(); expect(detach).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(process.exitCode).toBe(0);
  });
});
