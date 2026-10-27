// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse, McpServerRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel, InspectorProvider } from "../../../app/inspector";
import { queryKeys } from "../../../data/query-keys";
import { ConnectorPanel } from "./ConnectorPanel";
import { ConnectorsTab } from "./ConnectorsTab";
import type { ConnectorInstallState } from "./use-connector-install";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const mcp = vi.hoisted(() => ({
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  fetchMcpTools: vi.fn(),
  fetchMcpServer: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/mcp-operations", () => mcp);
const connectorsApi = vi.hoisted(() => ({ fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => connectorsApi);
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));

/**
 * The install flow, faked at its module boundary: each row reads the flow the test sets for its template or its
 * server, and the hook's actions are spies. The flow's own behavior has its tests in use-connector-install.test.tsx.
 */
const flows = vi.hoisted(() => {
  type Entry = { state: { phase: string } & Record<string, unknown>; serverId?: string };
  const IDLE: Entry = { state: { phase: "idle" } };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const keyOf = (item: { source: string; templateId?: string; serverId?: string }) =>
    item.source === "mcp_template" ? `template:${item.templateId}` : `server:${item.serverId}`;
  return {
    start: vi.fn(),
    resume: vi.fn(),
    submitManualCode: vi.fn(),
    cancel: vi.fn(),
    keyOf,
    read: (item: { source: string; templateId?: string; serverId?: string }) => entries.get(keyOf(item)) ?? IDLE,
    set(key: string, entry: Entry | undefined) {
      if (entry) entries.set(key, entry);
      else entries.delete(key);
      for (const listener of listeners) listener();
    },
    clear() {
      entries.clear();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock("./use-connector-install", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useConnectorInstall: (item: CapabilityConnectorItem) => {
      const entry = useSyncExternalStore(flows.subscribe, () => flows.read(item));
      return {
        state: entry.state,
        serverId: entry.serverId ?? item.serverId,
        start: (options: { enableChatConnectors: boolean }) => flows.start(item.id, options),
        resume: (from: string) => flows.resume(item.id, from),
        submitManualCode: (code: string, state: string) => flows.submitManualCode(code, state),
        cancel: () => flows.cancel(item.id),
      };
    },
    useConnectorInstallStatus: (item: CapabilityConnectorItem) =>
      useSyncExternalStore(flows.subscribe, () => flows.read(item)).state,
  };
});

const REVISION = "a".repeat(64);
const KEY = queryKeys.capabilityConnectors("ws-1");
const AUTHORIZE_URL = "https://auth.linear.app/oauth/authorize?scope=read+write&state=state-1";

function item(overrides: Partial<CapabilityConnectorItem>): CapabilityConnectorItem {
  return {
    id: "mcp-template:example",
    name: "Example",
    description: "An example app.",
    kind: "mcp",
    source: "mcp_template",
    category: "automation",
    state: "available",
    reason: "not_installed",
    group: "available",
    auth: "none",
    runsOnThisDevice: false,
    networkHosts: [],
    templateId: "example",
    chat: { available: true },
    hiddenInWorkspace: false,
    ...overrides,
  };
}

const LINEAR = item({
  id: "mcp-template:linear",
  name: "Linear",
  description: "Issues and projects",
  category: "development",
  auth: "oauth",
  networkHosts: ["mcp.linear.app", "auth.linear.app"],
  templateId: "linear",
  riskNotes: ["Can create and close issues.", "Can post comments as you."],
});
const EXAMPLE = item({ networkHosts: ["mcp.example.com"] });
/** Linear once it is saved: a server row that keeps its template's id. */
const SAVED_LINEAR = item({
  id: "mcp-server:srv-1",
  name: "Linear",
  description: "Issues and projects",
  source: "mcp_server",
  category: "development",
  state: "needs_sign_in",
  reason: "sign_in_needed",
  group: "connected",
  auth: "oauth",
  networkHosts: ["mcp.linear.app"],
  templateId: "linear",
  serverId: "srv-1",
  serverRevision: REVISION,
});
const CONNECTED_LINEAR = { ...SAVED_LINEAR, state: "connected", reason: "ready" } as const;

function response(items: CapabilityConnectorItem[], approvalReliefAvailable = true): CapabilityConnectorsResponse {
  return { workspaceId: "ws-1", items, issues: [], approvalReliefAvailable, generatedAt: "2026-10-27T10:00:00.000Z" };
}

function savedServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "srv-1",
    revision: REVISION,
    label: "Linear",
    transport: "http",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "development",
    trustTier: "verified",
    costTier: "free",
    policy: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as unknown as McpServerRecord;
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const body = () => document.body;
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
const link = (label: string) =>
  [...document.body.querySelectorAll<HTMLAnchorElement>("a")].find((entry) => entry.textContent === label);
const checkbox = () => body().querySelector<HTMLInputElement>('input[type="checkbox"]');
const href = (anchor: HTMLAnchorElement | undefined) =>
  new URL(anchor!.getAttribute("href")!, "http://cockpit.invalid");
/** Each step of the progress list as "<step> · <state word>". */
const steps = () =>
  [...body().querySelectorAll("[data-install-step]")].map(
    (entry) =>
      `${entry.querySelector("[data-step-title]")?.textContent} · ${entry.querySelector("[data-step-word]")?.textContent}`,
  );
const status = () => body().querySelector('[role="status"]')?.textContent ?? "";
/** What the panel's live regions say now, leaving out the silent ones. */
const spoken = () =>
  [...body().querySelectorAll('[role="status"]')].map((entry) => entry.textContent ?? "").filter(Boolean);
const field = (label: string) => {
  const target = [...body().querySelectorAll("label")].find((entry) => entry.textContent === label);
  return document.getElementById(target!.htmlFor) as HTMLInputElement;
};
/** The page's text with Technical details left out. */
const visibleText = () => {
  const copy = body().cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll("details")) details.remove();
  return copy.textContent ?? "";
};

function setFlow(entry: CapabilityConnectorItem, state: ConnectorInstallState, serverId?: string) {
  act(() => flows.set(flows.keyOf(entry), { state, ...(serverId ? { serverId } : {}) }));
}

async function renderPanel(itemId: string, items: CapabilityConnectorItem[], reliefAvailable = true) {
  client.setQueryData(KEY, response(items, reliefAvailable));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorProvider>
          <ConnectorPanel itemId={itemId} />
        </InspectorProvider>
      </QueryClientProvider>,
    ),
  );
}

/**
 * The list as a later read leaves it; `updatedAt` places that read after anything the panel saw. The query cache tells
 * its observers on a timer, so the update waits for that inside `act`.
 */
async function readListAgain(items: CapabilityConnectorItem[], updatedAt = Date.now() + 60_000) {
  await act(async () => {
    client.setQueryData(KEY, response(items), { updatedAt });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  for (const mock of [
    ...Object.values(mcp),
    ...Object.values(connectorsApi),
    route.navigate,
    flows.start,
    flows.resume,
    flows.submitManualCode,
    flows.cancel,
  ])
    mock.mockReset();
  flows.clear();
  mcp.fetchMcpTools.mockResolvedValue({ items: [] });
  mcp.fetchMcpServer.mockResolvedValue(savedServer());
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

describe("Install panel", () => {
  it("shows the sign-in host and the hosts it will allow", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    expect(text()).toContain("MCP · Development");
    expect(text()).toContain("Not installed");
    expect(text()).toContain("What it lets GoatCitadel do");
    expect(text()).toContain("Issues and projects");
    // Each risk note is its own sentence.
    const notes = [...body().querySelectorAll("p")].map((entry) => entry.textContent);
    expect(notes).toContain("Can create and close issues.");
    expect(notes).toContain("Can post comments as you.");
    expect(text()).toContain("How it connects");
    expect(text()).toContain("Signs in at mcp.linear.app");
    expect(text()).toContain("Installing adds mcp.linear.app, auth.linear.app to your network allowlist.");
  });

  it("says what asks first once it is installed", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    expect(text()).toContain("What asks first");
    expect(text()).toContain(
      "Reads run on their own. Anything that creates or changes something asks you first. You can change this later.",
    );
  });

  it("says every action asks on an install set up for remote access", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE], false);
    expect(text()).toContain("This install is set up for remote access, so every action asks you first.");
    expect(text()).not.toContain("Reads run on their own");
  });

  it("names the button by how the app signs in", async () => {
    await renderPanel(LINEAR.id, [LINEAR, EXAMPLE]);
    expect(button("Sign in and install")).toBeDefined();
    expect(button("Install")).toBeUndefined();
    await renderPanel(EXAMPLE.id, [LINEAR, EXAMPLE]);
    expect(button("Sign in and install")).toBeUndefined();
    await act(async () => button("Install")?.click());
    expect(flows.start).toHaveBeenCalledExactlyOnceWith(EXAMPLE.id, { enableChatConnectors: false });
  });

  it("offers no Install for an API-key app", async () => {
    const keyed = item({ auth: "api_key", reason: "needs_api_key" });
    await renderPanel(keyed.id, [keyed]);
    expect(button("Install")).toBeUndefined();
    expect(button("Sign in and install")).toBeUndefined();
    expect(text()).toContain("Needs an API key");
    expect(href(link("Set up in Settings")).pathname + href(link("Set up in Settings")).hash).toBe(
      "/settings/connections#mcp-servers",
    );
  });

  it("sends an app whose sign-in isn't set up to Settings instead of installing it", async () => {
    const unset = item({ auth: "oauth", reason: "missing_sign_in_setup" });
    await renderPanel(unset.id, [unset]);
    expect(button("Sign in and install")).toBeUndefined();
    expect(text()).toContain("Sign-in isn't set up for this app yet.");
    expect(link("Set up in Settings")).toBeDefined();
  });

  it("pre-ticks Also let Chat use connectors when MCP in Chat is off", async () => {
    const blocked = { ...EXAMPLE, chat: { available: false, blockedBy: "mcp_in_chat_off" } } as const;
    await renderPanel(blocked.id, [blocked]);
    expect(checkbox()?.checked).toBe(true);
    expect(checkbox()?.closest("label")?.textContent).toBe("Also let Chat use connectors");
    // The checkbox is the way forward, so the sentence that only explains the block is left out.
    expect(text()).not.toContain("Chat can't use connectors yet");
    await act(async () => button("Install")?.click());
    expect(flows.start).toHaveBeenLastCalledWith(blocked.id, { enableChatConnectors: true });

    await act(async () => checkbox()?.click());
    expect(checkbox()?.checked).toBe(false);
    await act(async () => button("Install")?.click());
    expect(flows.start).toHaveBeenLastCalledWith(blocked.id, { enableChatConnectors: false });
  });

  it("says Chat waits on background runs, with no checkbox", async () => {
    const blocked = { ...EXAMPLE, chat: { available: false, blockedBy: "background_runs_off" } } as const;
    await renderPanel(blocked.id, [blocked]);
    expect(checkbox()).toBeNull();
    expect(text()).toContain("Chat can't use connectors while background runs are off.");
    expect(href(link("See Chat access in Settings")).hash).toBe("#mcp-servers");
    await act(async () => button("Install")?.click());
    expect(flows.start).toHaveBeenCalledExactlyOnceWith(blocked.id, { enableChatConnectors: false });
  });

  it("says nothing about Chat when Chat can already use connectors", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    expect(checkbox()).toBeNull();
    expect(text()).not.toContain("Chat can't use connectors");
  });
});

describe("Install progress", () => {
  it("shows each step with a word while it installs, and no Stop before the app is saved", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    setFlow(LINEAR, { phase: "working", step: "plan" });
    const busy = body().querySelector<HTMLButtonElement>('button[aria-busy="true"]');
    expect(busy?.textContent).toBe("Installing…");
    expect(steps()).toEqual([
      "Allow and save · In progress",
      "Sign in · Not started",
      "Switch on · Not started",
      "Connect · Not started",
    ]);
    expect(status()).toBe("Installing…");
    expect(button("Stop")).toBeUndefined();
    // A plain click on the busy button starts nothing new.
    await act(async () => busy?.click());
    expect(flows.start).not.toHaveBeenCalled();
  });

  it("shows Waiting on you in Inbox with a link", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, { phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
    expect(text()).toContain("Waiting on you in Inbox");
    expect(text()).toContain("This request expires after 15 minutes.");
    const target = href(link("Open in Inbox"));
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-1");
    expect(target.searchParams.get("workspaceId")).toBe("default");
    expect(steps()).toEqual([
      "Approve in Inbox · Waiting",
      "Allow and save · Not started",
      "Switch on · Not started",
      "Connect · Not started",
    ]);
    expect(status()).toBe("Waiting on you in Inbox");
    expect(text()).not.toContain("Installed");
    await act(async () => button("Stop")?.click());
    expect(flows.cancel).toHaveBeenCalledExactlyOnceWith(EXAMPLE.id);

    // Approved: the step it waited on stays in the list, done.
    setFlow(EXAMPLE, { phase: "working", step: "plan" });
    expect(steps().slice(0, 2)).toEqual(["Approve in Inbox · Done", "Allow and save · In progress"]);
  });

  it("asks to finish signing in in the browser, with the pasted code behind a disclosure", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    setFlow(
      LINEAR,
      { phase: "signing_in", authorizeUrl: AUTHORIZE_URL, signInHost: "auth.linear.app", scopes: "read, write" },
      "srv-1",
    );
    expect(text()).toContain("Finish signing in in your browser");
    const page = link("Open sign-in page");
    expect(page?.getAttribute("href")).toBe(AUTHORIZE_URL);
    expect(page?.getAttribute("target")).toBe("_blank");
    expect(page?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(text()).toContain("Signs in at auth.linear.app");
    expect(text()).toContain("read, write");
    expect(steps()).toEqual([
      "Allow and save · Done",
      "Sign in · Waiting",
      "Switch on · Not started",
      "Connect · Not started",
    ]);
    expect(body().querySelector("details summary")?.textContent).toBe("Paste the code instead");

    const code = field("Authorization code");
    const returned = field("Returned state");
    expect(code.type).toBe("password");
    expect(code.maxLength).toBe(8192);
    expect(returned.maxLength).toBe(128);
    expect(button("Finish signing in")?.disabled).toBe(true);
    await type(code, "code-1");
    expect(button("Finish signing in")?.disabled).toBe(true);
    await type(returned, "state-1");
    await act(async () => button("Finish signing in")?.click());
    expect(flows.submitManualCode).toHaveBeenCalledExactlyOnceWith("code-1", "state-1");

    await act(async () => button("Stop")?.click());
    expect(flows.cancel).toHaveBeenCalledExactlyOnceWith(LINEAR.id);
  });

  it("says when a pasted code doesn't match, beside the fields it kept", async () => {
    const mismatch = "That doesn't match this sign-in. Paste the code and state from the sign-in page again.";
    await renderPanel(LINEAR.id, [LINEAR]);
    const signingIn = {
      phase: "signing_in",
      authorizeUrl: AUTHORIZE_URL,
      signInHost: "auth.linear.app",
      scopes: "read, write",
    } as const;
    setFlow(LINEAR, signingIn, "srv-1");
    await type(field("Authorization code"), "code-1");
    await type(field("Returned state"), "state-typo");
    setFlow(LINEAR, { ...signingIn, manualError: mismatch }, "srv-1");
    const code = field("Authorization code");
    expect(code.value).toBe("code-1");
    expect(code.getAttribute("aria-invalid")).toBe("true");
    const describedBy = code.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe(mismatch);
    expect(field("Returned state").getAttribute("aria-describedby")).toBe(describedBy);
    expect(status()).toBe(mismatch);
  });

  it("names the failed step and what changed", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    setFlow(
      LINEAR,
      {
        phase: "failed",
        step: "switch_on",
        message: "Couldn't switch Linear on. Reload and try again.",
        changed: ["Allowed mcp.linear.app. Saved Linear, switched off.", "Signed in."],
        detail: "PATCH /api/v1/mcp/servers/srv-1 returned 500",
      },
      "srv-1",
    );
    expect(text()).toContain("Couldn't switch it on.");
    expect(text()).toContain("Couldn't switch Linear on. Reload and try again.");
    expect(text()).toContain("What changed");
    const changed = [...body().querySelectorAll("[data-install-changed] li")].map((entry) => entry.textContent);
    expect(changed).toEqual(["Allowed mcp.linear.app. Saved Linear, switched off.", "Signed in."]);
    expect(steps()).toEqual([
      "Allow and save · Done",
      "Sign in · Done",
      "Switch on · Didn't finish",
      "Connect · Not started",
    ]);
    expect(status()).toBe("Couldn't switch it on.");
    expect(text()).not.toContain("returned 500");
    await act(async () => button("Try again")?.click());
    expect(flows.start).toHaveBeenCalledExactlyOnceWith(LINEAR.id, { enableChatConnectors: false });
  });

  it("says nothing was changed when a failure changed nothing, and can be dismissed", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, {
      phase: "failed",
      step: "approval",
      message: "You declined this install in Inbox. Nothing was changed.",
      changed: [],
    });
    expect(text()).toContain("Nothing was changed.");
    await act(async () => button("Dismiss")?.click());
    expect(flows.cancel).toHaveBeenCalledExactlyOnceWith(EXAMPLE.id);
  });

  it("names no step when the install ends after it saved the app", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    // The save went through and a later write failed: the plan step can't be said to have failed.
    setFlow(LINEAR, {
      phase: "failed",
      step: "plan",
      message: "The install didn't finish.",
      changed: [
        "Allowed mcp.linear.app. Saved Linear, switched off. Couldn't set what asks first. Trying again is safe.",
      ],
      detail: "posture write failed",
    });
    expect(text()).not.toContain("Couldn't allow and save it.");
    expect(steps()).toEqual([]);
    // Said once on the page (the status line reads it out on its own).
    const said = [...body().querySelectorAll('p:not([role="status"])')].filter(
      (entry) => entry.textContent === "The install didn't finish.",
    );
    expect(said).toHaveLength(1);
    expect(text()).toContain("Saved Linear, switched off.");
    expect(status()).toBe("The install didn't finish.");
  });

  it.each([
    ["a read that couldn't check it", "plan", "Couldn't check the install. Reload to see where it stands."],
    [
      "a finished install whose app wasn't found",
      "plan",
      "The install finished, but the new app wasn't found. Reload to see it.",
    ],
    ["a Stop that didn't go through", "approval", "Couldn't stop the install. Reload to see where it stands."],
  ] as const)("says only what happened for %s", async (_label, step, message) => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, { phase: "failed", step, message, changed: [] });
    expect(text()).not.toContain("Couldn't allow and save it.");
    expect(text()).not.toContain("Couldn't get it approved.");
    expect(steps()).toEqual([]);
    expect(text()).toContain(message);
    expect(status()).toBe(message);
  });

  it("keeps a failure's error text inside Technical details", async () => {
    prefs.showTechnicalDetails = true;
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, {
      phase: "failed",
      step: "plan",
      message: "The install didn't finish.",
      changed: [],
      detail: "connector_install_save_failed: disk full",
    });
    expect(body().querySelector("details")?.textContent).toContain("connector_install_save_failed: disk full");
    expect(visibleText()).not.toContain("disk full");
  });

  it("offers Stop once the app is saved, and never while the install is applying or stopping", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, { phase: "working", step: "approval" });
    expect(button("Stop")).toBeUndefined();
    setFlow(EXAMPLE, { phase: "working", step: "connect" }, "srv-1");
    expect(status()).toBe("Connecting…");
    await act(async () => button("Stop")?.click());
    expect(flows.cancel).toHaveBeenCalledExactlyOnceWith(EXAMPLE.id);
  });

  it("shows a stopped install's message and what changed", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, {
      phase: "stopped",
      message: "Stopped. Example is saved but switched off.",
      changed: ["Allowed mcp.example.com. Saved Example, switched off."],
    });
    expect(text()).toContain("Stopped. Example is saved but switched off.");
    const changed = [...body().querySelectorAll("[data-install-changed] li")].map((entry) => entry.textContent);
    expect(changed).toEqual(["Allowed mcp.example.com. Saved Example, switched off."]);
    expect(button("Install")).toBeDefined();
  });
});

describe("Saved server sign-in and connect", () => {
  it.each([
    ["needs_sign_in", "sign_in_needed", "Connect", "sign_in"],
    ["sign_in_expired", "sign_in_expired", "Reconnect", "sign_in"],
    ["broken", "error", "Try again", "connect"],
  ] as const)("gives a saved server in %s (%s) a %s button that resumes at %s", async (state, reason, label, from) => {
    const row = { ...SAVED_LINEAR, state, reason };
    await renderPanel(row.id, [row]);
    await act(async () => button(label)?.click());
    expect(flows.resume).toHaveBeenCalledExactlyOnceWith(row.id, from);
    expect(flows.start).not.toHaveBeenCalled();
  });

  it("leaves a service that isn't a saved server to its Settings link", async () => {
    const gmail = item({
      id: "integration:conn-gmail",
      name: "Gmail",
      kind: "built_in",
      source: "integration",
      state: "needs_sign_in",
      reason: "sign_in_needed",
      group: "connected",
      auth: "google",
      templateId: undefined,
      connectionId: "conn-gmail",
    });
    await renderPanel(gmail.id, [gmail]);
    expect(button("Connect")).toBeUndefined();
    expect(link("Advanced setup in Settings")).toBeDefined();
  });

  it("shows a saved server's progress while it connects", async () => {
    const broken = { ...SAVED_LINEAR, state: "broken", reason: "error" } as const;
    await renderPanel(broken.id, [broken]);
    await act(async () => button("Try again")?.click());
    setFlow(broken, { phase: "working", step: "connect" }, "srv-1");
    expect(body().querySelector('button[aria-busy="true"]')?.textContent).toBe("Connecting…");
    expect(steps()).toEqual(["Connect · In progress"]);
    expect(button("Stop")).toBeDefined();
    setFlow(broken, {
      phase: "failed",
      step: "connect",
      message: "Couldn't connect Linear. Try again in a moment.",
      changed: [],
    });
    expect(text()).toContain("Couldn't connect it.");
    expect(steps()).toEqual(["Connect · Didn't finish"]);
  });
});

describe("Focus through the install", () => {
  const landing = () => body().querySelector<HTMLElement>("[data-focus-landing]");
  const busy = () => body().querySelector<HTMLButtonElement>('button[aria-busy="true"]');

  it("stays on the busy button, then lands on the saved server's view when the install is done", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    button("Install")?.focus();
    setFlow(EXAMPLE, { phase: "working", step: "plan" });
    expect(document.activeElement).toBe(busy());
    setFlow(EXAMPLE, { phase: "working", step: "connect" }, "srv-1");
    expect(document.activeElement).toBe(busy());
    const connected = item({
      id: "mcp-server:srv-1",
      source: "mcp_server",
      state: "connected",
      reason: "ready",
      group: "connected",
      serverId: "srv-1",
      serverRevision: REVISION,
    });
    setFlow(EXAMPLE, { phase: "done", serverId: "srv-1" }, "srv-1");
    await readListAgain([connected]);
    expect(body().querySelector('[role="switch"]')).not.toBeNull();
    expect(document.activeElement).toBe(landing());
    expect(landing()?.textContent).toContain("Ready to use");
  });

  it("lands on the header when the saved server's view offers a button of its own", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    button("Sign in and install")?.focus();
    setFlow(LINEAR, { phase: "working", step: "connect" }, "srv-1");
    // The list still has the read from before sign-in finished, so the saved row offers Connect.
    setFlow(LINEAR, { phase: "done", serverId: "srv-1" }, "srv-1");
    await readListAgain([SAVED_LINEAR]);
    expect(button("Connect")).toBeDefined();
    expect(document.activeElement).toBe(landing());
  });

  it("moves from Stop to the install button once the install has stopped", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, { phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
    button("Stop")?.focus();
    await act(async () => button("Stop")?.click());
    // Withdrawing: Stop is gone, and the busy button holds focus.
    setFlow(EXAMPLE, { phase: "working", step: "approval" });
    expect(button("Stop")).toBeUndefined();
    expect(document.activeElement).toBe(busy());
    setFlow(EXAMPLE, { phase: "stopped", message: "Install stopped. Nothing was changed.", changed: [] });
    expect(document.activeElement).toBe(button("Install"));
  });

  it("moves from Dismiss to the install button", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, { phase: "failed", step: "connect", message: "Couldn't connect Example.", changed: [] });
    button("Dismiss")?.focus();
    await act(async () => button("Dismiss")?.click());
    setFlow(EXAMPLE, { phase: "idle" });
    expect(document.activeElement).toBe(button("Install"));
  });

  it("moves from Finish signing in to the busy button once the pasted code is taken", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    setFlow(
      LINEAR,
      { phase: "signing_in", authorizeUrl: AUTHORIZE_URL, signInHost: "auth.linear.app", scopes: "read, write" },
      "srv-1",
    );
    await type(field("Authorization code"), "code-1");
    await type(field("Returned state"), "state-1");
    button("Finish signing in")?.focus();
    await act(async () => button("Finish signing in")?.click());
    setFlow(LINEAR, { phase: "working", step: "finish_sign_in" }, "srv-1");
    expect(button("Finish signing in")).toBeUndefined();
    expect(document.activeElement).toBe(busy());
    expect(busy()?.textContent).toBe("Finishing sign-in…");
  });

  it("lands on the saved server's view when a dismissed result leaves it no button", async () => {
    const off = { ...SAVED_LINEAR, state: "turned_off", reason: "turned_off", group: "turned_off" } as const;
    await renderPanel(off.id, [off]);
    setFlow(off, { phase: "stopped", message: "Stopped. Linear is saved but switched off.", changed: [] }, "srv-1");
    button("Dismiss")?.focus();
    await act(async () => button("Dismiss")?.click());
    setFlow(off, { phase: "idle" });
    expect(button("Dismiss")).toBeUndefined();
    expect(document.activeElement).toBe(landing());
  });

  it("leaves focus alone when it is somewhere else on the page", async () => {
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "Elsewhere";
    document.body.append(elsewhere);
    try {
      await renderPanel(EXAMPLE.id, [EXAMPLE]);
      setFlow(EXAMPLE, { phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
      elsewhere.focus();
      setFlow(EXAMPLE, { phase: "stopped", message: "Install stopped. Nothing was changed.", changed: [] });
      setFlow(EXAMPLE, { phase: "idle" });
      expect(document.activeElement).toBe(elsewhere);
      // Nothing focused at all (the page itself) isn't the panel's either.
      elsewhere.blur();
      setFlow(EXAMPLE, { phase: "failed", step: "connect", message: "Couldn't connect Example.", changed: [] });
      setFlow(EXAMPLE, { phase: "idle" });
      expect(document.activeElement).toBe(document.body);
    } finally {
      elsewhere.remove();
    }
  });
});

describe("Panel across the install", () => {
  it("keeps the install on screen after the template row leaves the list, then lands on Manage", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    setFlow(LINEAR, { phase: "working", step: "plan" });
    // The plan saved the server: the list now holds the server's row instead of the template's.
    setFlow(
      LINEAR,
      { phase: "signing_in", authorizeUrl: AUTHORIZE_URL, signInHost: "auth.linear.app", scopes: "read, write" },
      "srv-1",
    );
    await readListAgain([SAVED_LINEAR]);
    expect(text()).not.toContain("isn't in the list anymore");
    expect(text()).toContain("Finish signing in in your browser");

    setFlow(LINEAR, { phase: "done", serverId: "srv-1" }, "srv-1");
    await readListAgain([CONNECTED_LINEAR]);
    expect(body().querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("Turn it on or off: Linear");
    expect(button("Remove")).toBeDefined();
    expect(button("Sign in and install")).toBeUndefined();
    expect(text()).toContain("Ready to use");
    expect(flows.cancel).not.toHaveBeenCalled();
  });

  it("shows a failed install on the server it saved, and reads it out once", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    const failed: ConnectorInstallState = {
      phase: "failed",
      step: "switch_on",
      message: "Couldn't switch Linear on. Reload and try again.",
      changed: ["Allowed mcp.linear.app. Saved Linear, switched off.", "Signed in."],
    };
    // The flow is found from both rows, as the store finds it once the plan saved the server.
    setFlow(LINEAR, failed, "srv-1");
    setFlow(SAVED_LINEAR, failed, "srv-1");
    const off = { ...SAVED_LINEAR, state: "turned_off", reason: "turned_off", group: "turned_off" } as const;
    await readListAgain([off]);
    expect(body().querySelector('[role="switch"]')).not.toBeNull();
    expect(text().match(/Couldn't switch Linear on\./g)).toHaveLength(1);
    expect(spoken()).toEqual(["Couldn't switch it on."]);
    expect(steps()).toEqual([
      "Allow and save · Done",
      "Sign in · Done",
      "Switch on · Didn't finish",
      "Connect · Not started",
    ]);
  });

  it("lists a no-sign-in install's own steps on the server it saved", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    const failed: ConnectorInstallState = {
      phase: "failed",
      step: "switch_on",
      message: "Couldn't switch Example on. Reload and try again.",
      changed: ["Allowed mcp.example.com. Saved Example, switched off."],
    };
    setFlow(EXAMPLE, failed, "srv-2");
    const saved = item({
      id: "mcp-server:srv-2",
      source: "mcp_server",
      state: "turned_off",
      reason: "turned_off",
      group: "turned_off",
      networkHosts: ["mcp.example.com"],
      serverId: "srv-2",
      serverRevision: REVISION,
    });
    setFlow(saved, failed, "srv-2");
    await readListAgain([saved]);
    expect(body().querySelector('[role="switch"]')).not.toBeNull();
    // The app has no sign-in, and the save it did is listed.
    expect(steps()).toEqual(["Allow and save · Done", "Switch on · Didn't finish", "Connect · Not started"]);
  });

  it("reads out the sign-in of a saved server its template's panel turned into", async () => {
    await renderPanel(LINEAR.id, [LINEAR]);
    // Installed somewhere else while the panel was open: the template's own flow stays idle.
    await readListAgain([SAVED_LINEAR]);
    await act(async () => button("Connect")?.click());
    expect(flows.resume).toHaveBeenCalledExactlyOnceWith(SAVED_LINEAR.id, "sign_in");
    setFlow(SAVED_LINEAR, { phase: "working", step: "sign_in" }, "srv-1");
    expect(spoken()).toEqual(["Starting sign-in…"]);
  });

  it("keeps a just-finished install while the list catches up", async () => {
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    setFlow(EXAMPLE, { phase: "done", serverId: "srv-1" }, "srv-1");
    expect(text()).toContain("Installed.");
    // A read that landed now but began before the install ended still lists the template; it proves nothing.
    await readListAgain([EXAMPLE], Date.now() - 60_000);
    expect(text()).toContain("Installed.");
    expect(button("Install")).toBeUndefined();
    expect(flows.cancel).not.toHaveBeenCalled();
  });

  it("doesn't trust an old Done once the saved server is gone", async () => {
    flows.set(flows.keyOf(EXAMPLE), { state: { phase: "done", serverId: "srv-1" }, serverId: "srv-1" });
    await renderPanel(EXAMPLE.id, [EXAMPLE]);
    expect(flows.cancel).not.toHaveBeenCalled();
    // A read after the panel saw Done still lists the template and no server: the server was removed since.
    await readListAgain([EXAMPLE]);
    await vi.waitFor(() => expect(flows.cancel).toHaveBeenCalledExactlyOnceWith(EXAMPLE.id));
    setFlow(EXAMPLE, { phase: "idle" });
    expect(button("Install")).toBeDefined();
    expect(text()).not.toContain("Installed.");
  });

  it("opens the saved server's Manage panel from its template's address", async () => {
    route.search = `?item=${encodeURIComponent(LINEAR.id)}`;
    connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([CONNECTED_LINEAR]));
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InspectorProvider>
            <ConnectorsTab />
            <InspectorPanel />
          </InspectorProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(body().querySelector('[aria-label="Inspector: Linear"]')).not.toBeNull());
    expect(body().querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("Turn it on or off: Linear");
    expect(text()).not.toContain("isn't in the list anymore");
    // Closing clears the address once, and the panel doesn't open itself again.
    await act(async () => body().querySelector<HTMLButtonElement>('button[aria-label="Close inspector"]')?.click());
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/connectors", { replace: true });
  });

  it("closes a panel its template's address opened once the saved server is removed", async () => {
    route.search = `?item=${encodeURIComponent(LINEAR.id)}`;
    connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([CONNECTED_LINEAR]));
    mcp.deleteMcpServer.mockResolvedValue({ deleted: true });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InspectorProvider>
            <ConnectorsTab />
            <InspectorPanel />
          </InspectorProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(button("Remove")).toBeDefined());
    connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([LINEAR]));
    await act(async () => button("Remove")?.click());
    await act(async () => button("Remove Linear")?.click());
    expect(mcp.deleteMcpServer).toHaveBeenCalledExactlyOnceWith("srv-1", REVISION);
    await vi.waitFor(() => expect(body().querySelector('[data-inspector-body="true"]')).toBeNull());
  });
});
