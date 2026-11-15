// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { WebSearchCredentialStatus } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSearchKeys } from "./WebSearchKeys";

const api = vi.hoisted(() => ({ fetchWebSearchCredentials: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/web-search-settings", () => ({
  fetchWebSearchCredentials: api.fetchWebSearchCredentials,
  saveWebSearchCredential: vi.fn(),
  clearWebSearchCredential: vi.fn(),
}));

function status(targetId: WebSearchCredentialStatus["targetId"], label: string): WebSearchCredentialStatus {
  return {
    targetId,
    label,
    endpointHost: "example.test",
    endpointAllowlisted: true,
    keychainAvailable: true,
    keychainConfigured: false,
    envNames: ["EXAMPLE_KEY"],
    envConfigured: false,
    activeSource: "none",
    acquisitionUrl: "https://example.test/key",
  };
}

const settings = { data: { revision: "a".repeat(64) } } as unknown as UseQueryResult<RuntimeSettingsResponse>;
let root: Root, host: HTMLDivElement, client: QueryClient, scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll as unknown as typeof HTMLElement.prototype.scrollIntoView;
  api.fetchWebSearchCredentials.mockResolvedValue({
    items: [
      status("search.firecrawl", "Firecrawl"),
      status("search.brave", "Brave Search"),
      status("search.parallel", "Parallel"),
    ],
  });
  window.history.replaceState(null, "", "/capabilities/connectors/advanced#web-search-key-brave");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WebSearchKeys settings={settings} />
      </QueryClientProvider>,
    ),
  );
}

it("scrolls to the key field named by the address and focuses it, once", async () => {
  await render();
  await vi.waitFor(() => expect(document.getElementById("web-search-key-brave")).not.toBeNull());
  const row = document.getElementById("web-search-key-brave")!;
  await vi.waitFor(() => expect(row.contains(document.activeElement)).toBe(true));
  expect(scroll).toHaveBeenCalledTimes(1);
  // The same address again does not pull focus back.
  (document.activeElement as HTMLElement).blur();
  await render();
  expect(row.contains(document.activeElement)).toBe(false);
  expect(scroll).toHaveBeenCalledTimes(1);
});
