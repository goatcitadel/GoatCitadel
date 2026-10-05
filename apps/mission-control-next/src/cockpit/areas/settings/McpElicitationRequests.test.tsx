// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpElicitationRequests } from "./McpElicitationRequests";

const api = vi.hoisted(() => ({ fetchMcpElicitations: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../../features/native-routes/settings/McpElicitationResponseForm", () => ({
  McpElicitationResponseForm: ({ request }: { request: { elicitationId: string } }) => (
    <form aria-label="Answer request">{request.elicitationId}</form>
  ),
}));

const item = {
  elicitationId: "request-a",
  status: "pending",
  owner: { workspaceId: "w" },
  prompt: { text: "Pick a folder" },
};
let root: Root, container: HTMLDivElement, client: QueryClient;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label)!;

beforeEach(() => {
  api.fetchMcpElicitations.mockReset().mockResolvedValue({ items: [item] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("MCP operator requests", () => {
  it("keeps the loaded list and an open request while it is read again, and beside a failed read", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <McpElicitationRequests workspaceId="w" />
        </QueryClientProvider>,
      ),
    );
    await act(async () => button("Inspect MCP requests").click());
    await vi.waitFor(() => expect(container.textContent).toContain("Pick a folder"));
    await act(async () => button("Inspect request").click());
    expect(container.querySelector('form[aria-label="Answer request"]')).not.toBeNull();
    let release!: () => void;
    api.fetchMcpElicitations.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [item] });
        }),
    );
    await act(async () => {
      void client.invalidateQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).not.toContain("Reading MCP requests…");
    expect(container.textContent).toContain("Pick a folder");
    expect(container.querySelector('form[aria-label="Answer request"]')).not.toBeNull();
    await act(async () => release());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking for changes…"));
    api.fetchMcpElicitations.mockRejectedValueOnce(new Error("Gateway offline"));
    await act(async () => {
      void client.invalidateQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Pick a folder");
    expect(container.textContent).toContain("Showing the last version from");
  });
});
