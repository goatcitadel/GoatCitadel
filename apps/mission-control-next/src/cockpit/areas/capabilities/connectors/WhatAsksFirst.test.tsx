// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  mcpCallAsksFirst,
  type CapabilityConnectorItem,
  type CapabilityConnectorsResponse,
  type McpApprovalPosture,
  type McpServerRecord,
  type McpToolRecord,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorProvider } from "../../../app/inspector";
import { queryKeys } from "../../../data/query-keys";
import { ConnectorPanel } from "./ConnectorPanel";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const mcp = vi.hoisted(() => ({
  updateMcpServer: vi.fn(),
  updateMcpServerPolicy: vi.fn(),
  deleteMcpServer: vi.fn(),
  fetchMcpTools: vi.fn(),
  fetchMcpServer: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/mcp-operations", () => mcp);
const connectorsApi = vi.hoisted(() => ({ fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => connectorsApi);
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));

const REVISION = "a".repeat(64);
const NEXT_REVISION = "b".repeat(64);
const KEY = queryKeys.capabilityConnectors("ws-1");
const PER_CHAT_LINE = "This connector's tools are listed per chat, so every action asks you first.";
const FOOTER =
  "This goes by how the app labels its own tools. Deny rules, wards and quarantine still apply, and it applies whichever approval profile Chat uses.";

function linear(overrides: Partial<CapabilityConnectorItem> = {}): CapabilityConnectorItem {
  return {
    id: "mcp-server:linear",
    name: "Linear",
    description: "Issues and projects",
    kind: "mcp",
    source: "mcp_server",
    category: "development",
    state: "connected",
    reason: "ready",
    group: "connected",
    auth: "oauth",
    runsOnThisDevice: false,
    networkHosts: ["mcp.linear.app"],
    serverId: "linear",
    serverRevision: REVISION,
    chat: { available: true },
    hiddenInWorkspace: false,
    ...overrides,
  };
}

function savedServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "linear",
    revision: NEXT_REVISION,
    label: "Linear",
    transport: "http",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "development",
    trustTier: "restricted",
    costTier: "free",
    policy: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as unknown as McpServerRecord;
}

function tool(toolName: string, annotations?: McpToolRecord["annotations"]): McpToolRecord {
  return {
    serverId: "linear",
    toolName,
    ...(annotations ? { annotations } : {}),
    enabled: true,
    updatedAt: "2026-10-01",
  };
}

const TOOLS: McpToolRecord[] = [
  tool("list_issues", { readOnlyHint: true }),
  tool("update_issue", { destructiveHint: false }),
  tool("delete_issue", { destructiveHint: true }),
  tool("mystery_tool"),
];

function response(items: CapabilityConnectorItem[]): CapabilityConnectorsResponse {
  return { workspaceId: "ws-1", items, issues: [], generatedAt: "2026-10-25T10:00:00.000Z" };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
const radio = (posture: McpApprovalPosture) =>
  document.body.querySelector<HTMLInputElement>(`input[type="radio"][value="${posture}"]`);
const checkedRadios = () =>
  [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    .filter((entry) => entry.checked)
    .map((entry) => entry.value);
const group = () => document.body.querySelector("fieldset");
const alertText = () => document.body.querySelector('[role="alert"]')?.textContent;
const cached = () => client.getQueryData<CapabilityConnectorsResponse>(KEY)?.items[0];
const toolLine = (name: string) =>
  [...document.body.querySelectorAll("li")].find((entry) => entry.querySelector("code")?.textContent === name)
    ?.textContent ?? "";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function renderPanel(item: CapabilityConnectorItem = linear(), tools: McpToolRecord[] = TOOLS) {
  mcp.fetchMcpTools.mockResolvedValue({ items: tools });
  client.setQueryData(KEY, response([item]));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorProvider>
          <ConnectorPanel itemId={item.id} />
        </InspectorProvider>
      </QueryClientProvider>,
    ),
  );
  // A saved server lists its tools; wait for them so the labels have been drawn.
  if (item.source === "mcp_server") await vi.waitFor(() => expect(document.body.querySelector("li")).not.toBeNull());
}

const choose = (posture: McpApprovalPosture) => act(async () => radio(posture)?.click());

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  for (const mock of [...Object.values(mcp), ...Object.values(connectorsApi), route.navigate]) mock.mockReset();
  mcp.fetchMcpServer.mockResolvedValue(savedServer());
  connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([linear()]));
  route.search = "";
  prefs.showTechnicalDetails = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});

describe("What asks first", () => {
  it("labels each tool Asks first or Runs freely for the chosen setting", async () => {
    await renderPanel(linear({ approvalPosture: "reads_free" }));
    expect(toolLine("list_issues")).toContain("Runs freely");
    expect(toolLine("update_issue")).toContain("Asks first");
    expect(toolLine("delete_issue")).toContain("Asks first");
    expect(toolLine("mystery_tool")).toContain("Asks first");
  });

  it.each([
    ["everything_asks", [true, true, true, true]],
    ["reads_free", [false, true, true, true]],
    ["nothing_asks", [false, false, true, true]],
    [undefined, [true, true, true, true]],
  ] as const)("labels tools the way the engine decides them under %s", async (posture, asks) => {
    await renderPanel(linear(posture ? { approvalPosture: posture } : {}));
    TOOLS.forEach((entry, index) => {
      // The cockpit and the engine share one rule, so a label can never disagree with what really happens.
      expect(mcpCallAsksFirst(posture, entry.annotations)).toBe(asks[index]);
      expect(toolLine(entry.toolName)).toContain(asks[index] ? "Asks first" : "Runs freely");
      expect(toolLine(entry.toolName)).not.toContain(asks[index] ? "Runs freely" : "Asks first");
    });
  });

  it("shows Everything asks selected when nothing is saved, without an older-setting line", async () => {
    await renderPanel();
    expect(text()).toContain("What asks first");
    expect(checkedRadios()).toEqual(["everything_asks"]);
    expect(text()).not.toContain("asks the first time");
    expect(text()).not.toContain("Now:");
  });

  it("shows the three choices with their plain-words detail, and the footer", async () => {
    await renderPanel(linear({ approvalPosture: "reads_free" }));
    const radios = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((entry) => entry.labels?.[0]?.textContent)).toEqual([
      "Everything asks",
      "Reading is free Recommended",
      "Nothing asks",
    ]);
    expect(text()).toContain("Every action asks you first.");
    expect(text()).toContain("Reads run on their own. Anything that creates or changes something asks you first.");
    expect(text()).toContain(
      "Changes run on their own. Anything the app marks as destructive, or doesn't label, still asks you first.",
    );
    expect(text()).toContain(FOOTER);
    expect(checkedRadios()).toEqual(["reads_free"]);
  });

  it("describes each choice to a screen reader and groups them under the heading", async () => {
    await renderPanel();
    expect(group()?.querySelector("legend")?.textContent).toBe("What asks first");
    for (const entry of document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      const description = entry.getAttribute("aria-describedby");
      expect(description && document.getElementById(description)?.textContent).toBeTruthy();
    }
  });

  it("places it between how it connects and the server controls, for saved servers only", async () => {
    await renderPanel();
    const order = [...document.body.querySelectorAll("h3")].map((entry) => entry.textContent);
    expect(order).toEqual(["What it does", "How it connects", "What asks first"]);
    expect(group()?.compareDocumentPosition(document.body.querySelector('[role="switch"]')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("is absent for a connector that is not a saved server", async () => {
    await renderPanel(linear({ id: "mcp-template:linear", source: "mcp_template" }));
    expect(text()).not.toContain("What asks first");
    expect(group()).toBeNull();
  });

  it("saves the chosen setting at once with the server's revision and nothing else", async () => {
    mcp.updateMcpServerPolicy.mockResolvedValue(
      savedServer({ policy: { approvalPosture: "reads_free" } as McpServerRecord["policy"] }),
    );
    await renderPanel();
    await choose("reads_free");

    expect(mcp.updateMcpServerPolicy).toHaveBeenCalledExactlyOnceWith("linear", {
      expectedRevision: REVISION,
      approvalPosture: "reads_free",
    });
    expect(checkedRadios()).toEqual(["reads_free"]);
    // The next save starts from the version this one made, and the tool labels follow the saved setting.
    expect(cached()).toMatchObject({ approvalPosture: "reads_free", serverRevision: NEXT_REVISION });
    await vi.waitFor(() => expect(toolLine("list_issues")).toContain("Runs freely"));
    expect(checkedRadios()).toEqual(["reads_free"]);
    expect(alertText()).toBeUndefined();
  });

  it("is busy while saving and keeps the labels on the saved setting until the save lands", async () => {
    const saving = deferred<McpServerRecord>();
    mcp.updateMcpServerPolicy.mockReturnValue(saving.promise);
    await renderPanel();
    await choose("nothing_asks");

    expect(checkedRadios()).toEqual(["nothing_asks"]);
    expect(group()?.getAttribute("aria-busy")).toBe("true");
    // The tool labels follow the saved setting, not the choice still in flight.
    expect(toolLine("list_issues")).toContain("Asks first");
    // A second choice while one is saving is ignored.
    await choose("reads_free");
    expect(mcp.updateMcpServerPolicy).toHaveBeenCalledTimes(1);
    expect(checkedRadios()).toEqual(["nothing_asks"]);

    await act(async () => saving.resolve(savedServer()));
    expect(group()?.getAttribute("aria-busy")).toBeNull();
    expect(checkedRadios()).toEqual(["nothing_asks"]);
    await vi.waitFor(() => expect(toolLine("update_issue")).toContain("Runs freely"));
    expect(checkedRadios()).toEqual(["nothing_asks"]);
  });

  it("puts the selection back and says why when the save fails", async () => {
    mcp.updateMcpServerPolicy.mockRejectedValue(new Error("The server said no"));
    await renderPanel(linear({ approvalPosture: "reads_free" }));
    await choose("nothing_asks");

    expect(checkedRadios()).toEqual(["reads_free"]);
    expect(alertText()).toContain("The server said no");
    expect(group()?.getAttribute("aria-busy")).toBeNull();
    expect(cached()).toMatchObject({ approvalPosture: "reads_free", serverRevision: REVISION });
    expect(toolLine("update_issue")).toContain("Asks first");
    // A conflict-only action is not offered for an ordinary failure.
    expect(button("Reload")).toBeUndefined();
  });

  it("explains a 409 with the conflict message and a reload that reads the list again", async () => {
    mcp.updateMcpServerPolicy.mockRejectedValue(
      new ApiRequestError("conflict", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/mcp/servers/linear/policy",
        status: 409,
        body: { code: "WRITE_CONFLICT" },
      }),
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await renderPanel();
    await choose("reads_free");

    expect(alertText()).toContain("Changed elsewhere. Reload to see the latest.");
    expect(checkedRadios()).toEqual(["everything_asks"]);
    invalidate.mockClear();
    await act(async () => button("Reload")?.click());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    expect(alertText()).toBeUndefined();
  });

  it("clears an earlier failure when the next choice is made", async () => {
    mcp.updateMcpServerPolicy.mockRejectedValueOnce(new Error("The server said no"));
    mcp.updateMcpServerPolicy.mockResolvedValueOnce(savedServer());
    await renderPanel();
    await choose("reads_free");
    expect(alertText()).toContain("The server said no");
    await choose("nothing_asks");
    expect(alertText()).toBeUndefined();
    expect(checkedRadios()).toEqual(["nothing_asks"]);
  });

  it("shows Everything asks, switched off, for a connector whose tools are listed per chat", async () => {
    await renderPanel(linear({ requesterScoped: true }));
    expect(checkedRadios()).toEqual(["everything_asks"]);
    expect(group()?.disabled).toBe(true);
    for (const entry of document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      expect(entry.disabled).toBe(true);
    }
    expect(text()).toContain(PER_CHAT_LINE);
    expect(text()).not.toContain(FOOTER);
    await choose("reads_free");
    expect(mcp.updateMcpServerPolicy).not.toHaveBeenCalled();
  });

  it("does not offer a change when the server's saved version is missing", async () => {
    await renderPanel(linear({ serverRevision: undefined }));
    expect(group()?.disabled).toBe(true);
    expect(text()).toContain("This server's saved version isn't available, so it can't be changed here.");
    await choose("reads_free");
    expect(mcp.updateMcpServerPolicy).not.toHaveBeenCalled();
  });

  it("never shows the internal word for the setting", async () => {
    await renderPanel(linear({ approvalPosture: "nothing_asks" }));
    expect(text().toLowerCase()).not.toContain("posture");
  });
});
