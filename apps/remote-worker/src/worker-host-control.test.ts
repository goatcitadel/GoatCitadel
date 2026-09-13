import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { attachWorkerHostControl } from "./worker-host-control.js";
import { CONNECTED_WORKER_ENV, WORKER_HOST_CONTROL_PROTOCOL } from "./worker-environment.js";

const hosted = { [CONNECTED_WORKER_ENV.hostControl]: WORKER_HOST_CONTROL_PROTOCOL };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("native worker host shutdown", () => {
  it("leaves ordinary foreground input alone", () => {
    const input = new PassThrough();
    const stop = vi.fn();
    const detach = attachWorkerHostControl({}, input, stop);
    input.end();
    detach();
    expect(stop).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
  });

  it.each(["eof", "data", "error", "closed"])("requests shutdown exactly once on %s", async (event) => {
    const input = new PassThrough();
    const stop = vi.fn();
    if (event === "closed") input.destroy();
    const detach = attachWorkerHostControl(hosted, input, stop);
    if (event === "eof") input.end();
    if (event === "data") input.end("ignored operands");
    if (event === "error") input.destroy(new Error("broken pipe"));
    await tick();
    expect(stop).toHaveBeenCalledOnce();
    detach();
    for (const name of ["data", "end", "close", "error"]) expect(input.listenerCount(name)).toBe(0);
  });

  it("detaches without stopping an already completed worker", async () => {
    const input = new PassThrough();
    const stop = vi.fn();
    attachWorkerHostControl(hosted, input, stop)();
    input.end();
    await tick();
    expect(stop).not.toHaveBeenCalled();
  });

  it("refuses unsupported protocols and a terminal", () => {
    expect(() =>
      attachWorkerHostControl({ [CONNECTED_WORKER_ENV.hostControl]: "other" }, new PassThrough(), vi.fn()),
    ).toThrow("pipe protocol");
    const input = Object.assign(new PassThrough(), { isTTY: true });
    expect(() => attachWorkerHostControl(hosted, input, vi.fn())).toThrow("pipe protocol");
  });
});
