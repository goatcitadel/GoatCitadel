// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSettings, fetchOnboardingState } from "./settings";
import { fetchDemoState } from "./demo";
import { fetchWorkspaces } from "./workspaces";
import { fetchChatProjects, fetchChatSessions } from "./chat";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
describe("independent first-run owner reads", () => {
  it.each(["settings", "onboarding", "demo", "workspaces", "projects", "sessions"])(
    "does not coalesce the %s review with an older GET",
    async (owner) => {
      let finish!: (response: Response) => void;
      const transport = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValueOnce(json({ revision: "fresh" }));
      vi.stubGlobal("fetch", transport);
      const read = (signal?: AbortSignal) =>
        owner === "settings"
          ? fetchSettings({ signal })
          : owner === "onboarding"
            ? fetchOnboardingState({ signal })
            : owner === "demo"
              ? fetchDemoState({ signal })
              : owner === "workspaces"
                ? fetchWorkspaces("all", 500, undefined, { signal })
                : owner === "projects"
                  ? fetchChatProjects("all", 300, "workspace-a", undefined, { signal })
                  : fetchChatSessions({ workspaceId: "workspace-a", projectId: "project-a", view: "all" }, { signal });
      const old = read(),
        joined = read();
      expect(transport).toHaveBeenCalledTimes(1);
      const signal = new AbortController().signal,
        fresh = read(signal);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[1]?.[0]).toBe(transport.mock.calls[0]?.[0]);
      expect(transport.mock.calls[1]?.[1]).toMatchObject({ signal, cache: "no-store" });
      expect(transport.mock.calls[1]?.[1]?.method ?? "GET").toBe("GET");
      expect(transport.mock.calls[1]?.[1]?.body).toBeUndefined();
      expect(await fresh).toEqual({ revision: "fresh" });
      finish(json({ revision: "old" }));
      expect(await old).toEqual(await joined);
      expect(await old).toEqual({ revision: "old" });
    },
  );
});
