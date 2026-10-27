// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTask, fetchTaskDeliverables } from "./tasks";
import { fetchAgents } from "./operators-agents-files";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("fresh task and agent owner reads", () => {
  it.each(["task", "agents", "deliverables"])(
    "isolates a %s mutation preflight from an earlier coalesced read",
    async (kind) => {
      let finish!: (response: Response) => void;
      const freshBody = kind === "task" ? { taskId: "task-a", revision: 2 } : { items: [] };
      const oldBody = kind === "task" ? { taskId: "task-a", revision: 1 } : { items: [{ agentId: "retired" }] };
      const transport = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValueOnce(json(freshBody));
      vi.stubGlobal("fetch", transport);
      const read = (signal?: AbortSignal) =>
        kind === "task"
          ? fetchTask("task-a", "ws-a", undefined, { signal })
          : kind === "deliverables"
            ? fetchTaskDeliverables("task-a", "ws-a", undefined, { signal })
            : fetchAgents("active", 300, { signal });
      const old = read(),
        joined = read();
      expect(transport).toHaveBeenCalledTimes(1);
      const controller = new AbortController();
      const fresh = read(controller.signal);
      expect(transport).toHaveBeenCalledTimes(2);
      // The fresh read sends the caller's signal (combined with the client's read timeout).
      const sent = transport.mock.calls[1]?.[1]?.signal as AbortSignal;
      expect(sent.aborted).toBe(false);
      await expect(fresh).resolves.toEqual(freshBody);
      controller.abort();
      expect(sent.aborted).toBe(true);
      finish(json(oldBody));
      expect(await old).toEqual(await joined);
      expect(await old).toEqual(oldBody);
    },
  );
});
