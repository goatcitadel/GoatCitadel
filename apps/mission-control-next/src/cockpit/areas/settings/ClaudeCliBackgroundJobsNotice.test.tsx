// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { ClaudeCliBackgroundJobsNotice } from "./ClaudeCliBackgroundJobsNotice";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchSettings: api.fetchSettings }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  api.fetchSettings.mockReset();
});

function settings(input: {
  activeApiStyle: string;
  utilityProviderId?: string;
  utilityHasKey?: boolean;
  utilityRouting?: boolean;
}) {
  return {
    revision: 1,
    features: { utilityModelRoutingV1Enabled: input.utilityRouting ?? false },
    llm: {
      activeProviderId: "active",
      activeModel: "model",
      ...(input.utilityProviderId ? { utilityProviderId: input.utilityProviderId, utilityModel: "cheap" } : {}),
      providers: [
        { providerId: "active", apiStyle: input.activeApiStyle, hasApiKey: false },
        { providerId: "openai", apiStyle: "openai-chat-completions", hasApiKey: input.utilityHasKey ?? false },
      ],
    },
  };
}

async function render(data: ReturnType<typeof settings>): Promise<HTMLDivElement> {
  api.fetchSettings.mockResolvedValue(data);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <ClaudeCliBackgroundJobsNotice />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
  // Let the settings query resolve and render before asserting.
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.fetchSettings).toHaveBeenCalled();
  return host;
}

describe("ClaudeCliBackgroundJobsNotice", () => {
  it("says background jobs are off on the Claude Code CLI, which jobs they are, and how to turn them on (#493)", async () => {
    const view = await render(settings({ activeApiStyle: "claude-code-cli" }));
    const section = view.querySelector("section");
    expect(section?.getAttribute("aria-labelledby")).toBe("claude-cli-background-jobs-title");
    expect(view.querySelector("#claude-cli-background-jobs-title")?.textContent).toBe(
      "Claude Code CLI: background jobs are off",
    );
    const text = view.textContent ?? "";
    for (const job of ["follow-up suggestions", "learned facts about you", "procedure reviews"]) {
      expect(text).toContain(job);
    }
    expect(text).toContain("would start its own Claude Code process");
    expect(text).toContain("utility model");
    expect(text).toContain("provider with an API key");
    expect(text).toContain("Chat can propose that change");
    // The sentence that points at Chat links there.
    expect(view.querySelector("a")?.getAttribute("href")).toBe("/chat");
    expect(view.querySelector("a")?.textContent).toBe("Open Chat");
  });

  it("stays hidden when a utility model on a keyed provider runs the background jobs", async () => {
    const view = await render(
      settings({
        activeApiStyle: "claude-code-cli",
        utilityRouting: true,
        utilityProviderId: "openai",
        utilityHasKey: true,
      }),
    );
    expect(view.querySelector("section")).toBeNull();
  });

  it("stays hidden when the Chat provider is not the Claude Code CLI", async () => {
    const view = await render(settings({ activeApiStyle: "openai-chat-completions" }));
    expect(view.querySelector("section")).toBeNull();
  });

  it("still shows when the utility provider has no API key, because the Gateway then ignores it", async () => {
    const view = await render(
      settings({
        activeApiStyle: "claude-code-cli",
        utilityRouting: true,
        utilityProviderId: "openai",
        utilityHasKey: false,
      }),
    );
    expect(view.querySelector("#claude-cli-background-jobs-title")).not.toBeNull();
  });
});
