// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  __resetMcpServerMutationsForTests,
  commitMcpServerUpdate,
} from "../../../features/native-routes/settings/mcp-server-mutation";
import { useMcpEnabled } from "../../../features/native-routes/settings/use-mcp-enabled";
import { McpServersSettings } from "./McpServersSettings";

const api = vi.hoisted(() => ({ fetchMcpServers: vi.fn(), fetchMcpServer: vi.fn(), updateMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
let confirmation: ComponentProps<typeof ConfirmModal>;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    confirmation = props;
    return null;
  },
}));
const fixture = (): McpServerRecord => ({
  serverId: "mcp-fixture",
  revision: "a".repeat(64),
  label: "Fixture MCP",
  transport: "stdio",
  command: "node",
  authType: "none",
  enabled: false,
  status: "disconnected",
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  policy: {
    requireFirstToolApproval: true,
    redactionMode: "strict",
    allowedToolPatterns: [],
    blockedToolPatterns: [],
    allowedEnvKeys: [],
  },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
});
let saved: McpServerRecord;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let workspace = "first";
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <McpServersSettings workspaceId={workspace} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Saved state:"));
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpServerMutationsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in native MCP tests");
    }),
  );
  saved = fixture();
  workspace = "first";
  api.fetchMcpServers.mockImplementation(async () => ({ items: [saved] }));
  api.fetchMcpServer.mockImplementation(async () => saved);
  api.updateMcpServer.mockImplementation(async (_id: string, input: { enabled: boolean }) => {
    saved = { ...saved, enabled: input.enabled, revision: "b".repeat(64) };
    return saved;
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
describe("native MCP saved-state control", () => {
  it("keeps caller-owned servers searchable and editable beside revisionless Gateway-owned records", async () => {
    const internal = {
      ...fixture(),
      serverId: "goatcitadel-internal-approval-inbox",
      label: "Approval Inbox",
      enabled: true,
      revision: undefined,
      transport: "http" as const,
      url: "goatcitadel://approval-inbox",
    };
    api.fetchMcpServers.mockImplementation(async () => ({ items: [internal, saved] }));
    await render();
    expect(container.querySelector('input[type="search"]')).not.toBeNull();
    expect(container.textContent).toContain("This server is managed by the Gateway.");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Review disable Approval Inbox"]')?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Review enable Fixture MCP"]')?.disabled).toBe(
      false,
    );
    await act(async () => button("Review enable").click());
    await act(async () => confirmation.onConfirm());
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("mcp-fixture", {
      expectedRevision: "a".repeat(64),
      enabled: true,
    });
  });
  it("keeps a revisionless caller-owned record inspectable without offering mutation", async () => {
    saved.revision = undefined;
    await render();
    expect(container.querySelector('input[type="search"]')).not.toBeNull();
    expect(container.textContent).toContain("Current server identity or revision is unavailable.");
    expect(button("Review enable").disabled).toBe(true);
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
  it("reviews and cancels without writes then confirms exact metadata and truthful saved state", async () => {
    await render();
    await act(async () => button("Review enable").click());
    expect(confirmation.open).toBe(true);
    expect(confirmation.message).toContain("Disabled → Enabled");
    expect(confirmation.message).toContain("closes current connections");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    act(() => confirmation.onCancel());
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    await act(async () => button("Review enable").click());
    await act(async () => confirmation.onConfirm());
    await vi.waitFor(() => expect(container.textContent).toContain("Saved state: Enabled"));
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("mcp-fixture", {
      expectedRevision: "a".repeat(64),
      enabled: true,
    });
    expect(container.textContent).toContain("connectivity and tool permission are separate");
    expect(container.textContent).toContain("Last connection state: Disconnected");
  });
  it("rejects owner drift after review without sending PATCH", async () => {
    await render();
    await act(async () => button("Review enable").click());
    saved = { ...saved, revision: "b".repeat(64), label: "Peer edit" };
    await act(async () => confirmation.onConfirm());
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    expect(container.textContent).toContain("server changed");
  });
  it("blocks a native retry when another shell lost the owner response", async () => {
    api.updateMcpServer.mockRejectedValue(new Error("response lost"));
    await commitMcpServerUpdate({
      reviewed: saved,
      input: { expectedRevision: saved.revision!, enabled: true },
      isCurrent: () => true,
    });
    await render();
    expect(button("Review enable").disabled).toBe(true);
    expect(container.textContent).toContain("MCP save outcome is unconfirmed");
    expect(api.updateMcpServer).toHaveBeenCalledTimes(1);
  });
  it.each(["internal", "quarantined", "missing auth"])("withholds ineligible enabling for %s", async (kind) => {
    if (kind === "internal") saved.serverId = "goatcitadel-internal-approval-inbox";
    if (kind === "quarantined") saved.trustTier = "quarantined";
    if (kind === "missing auth")
      saved = { ...saved, transport: "http", url: "https://mcp.example.test/mcp", authType: "oauth2" };
    await render();
    expect(button("Review enable").disabled).toBe(true);
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
  it("withholds cached editable rows after directory refresh fails", async () => {
    await render();
    api.fetchMcpServers.mockRejectedValue(new Error("owner unavailable"));
    await act(async () => {
      await client.refetchQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("MCP servers unavailable");
    expect(button("Review enable")).toBeUndefined();
  });
});
describe("MCP review lifecycle", () => {
  let hook: ReturnType<typeof useMcpEnabled>;
  const reload = vi.fn(async () => undefined);
  function Probe() {
    hook = useMcpEnabled({ workspaceId: workspace, available: true, reload });
    return null;
  }
  const mount = async () => {
    await act(async () => root.render(<Probe />));
  };
  it.each(["cancel", "workspace round trip", "unmount"])(
    "cancels %s during preflight without mutation",
    async (kind) => {
      await mount();
      await act(async () => {
        await hook.requestReview(saved);
      });
      let resolve!: (value: McpServerRecord) => void;
      api.fetchMcpServer.mockReturnValueOnce(
        new Promise<McpServerRecord>((done) => {
          resolve = done;
        }),
      );
      let result!: Promise<void>;
      await act(async () => {
        result = hook.confirm();
      });
      if (kind === "cancel") act(() => hook.cancel());
      else if (kind === "workspace round trip") {
        workspace = "other";
        await mount();
        workspace = "first";
        await mount();
      } else {
        act(() => root.unmount());
        root = createRoot(container);
      }
      await act(async () => {
        resolve(saved);
        await result;
      });
      expect(api.updateMcpServer).not.toHaveBeenCalled();
    },
  );
});
