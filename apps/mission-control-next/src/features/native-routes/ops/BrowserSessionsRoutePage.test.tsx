import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const browserSessionMocks = vi.hoisted(() => ({
  closeBrowserSession: vi.fn(),
  createBrowserSession: vi.fn(),
  createBrowserSessionGrant: vi.fn(),
  fetchBrowserSessionEvents: vi.fn(),
  fetchBrowserSessionGrants: vi.fn(),
  fetchBrowserSessionState: vi.fn(),
  fetchBrowserSessions: vi.fn(),
  revokeBrowserSessionGrant: vi.fn(),
  rotateBrowserSessionGrant: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => browserSessionMocks);

beforeEach(() => {
  browserSessionMocks.fetchBrowserSessions.mockReset();
  browserSessionMocks.fetchBrowserSessionGrants.mockReset();
  browserSessionMocks.fetchBrowserSessionState.mockReset();
  browserSessionMocks.fetchBrowserSessionEvents.mockReset();
  browserSessionMocks.createBrowserSession.mockReset();
  browserSessionMocks.createBrowserSessionGrant.mockReset();
  browserSessionMocks.closeBrowserSession.mockReset();
  browserSessionMocks.revokeBrowserSessionGrant.mockReset();
  browserSessionMocks.rotateBrowserSessionGrant.mockReset();
  browserSessionMocks.fetchBrowserSessions.mockResolvedValue([
    {
      sessionId: "browser-session-1",
      workspaceId: "default",
      label: "Research browser",
      status: "active",
      createdBy: "operator",
      createdAt: "2026-05-30T18:00:00.000Z",
      updatedAt: "2026-05-30T18:05:00.000Z",
    },
  ]);
  browserSessionMocks.fetchBrowserSessionGrants.mockResolvedValue([
    {
      grantId: "grant-1",
      sessionId: "browser-session-1",
      actorId: "agent-1",
      scopes: ["read", "state"],
      allowedHosts: ["example.com"],
      createdAt: "2026-05-30T18:01:00.000Z",
      expiresAt: "2099-05-30T18:16:00.000Z",
    },
  ]);
  browserSessionMocks.fetchBrowserSessionState.mockResolvedValue({
    session: {
      sessionId: "browser-session-1",
      workspaceId: "default",
      label: "Research browser",
      status: "active",
      createdBy: "operator",
      createdAt: "2026-05-30T18:00:00.000Z",
      updatedAt: "2026-05-30T18:05:00.000Z",
    },
    state: {
      availability: "present",
      source: "policy_engine_memory",
      retention: "volatile",
      valuesHidden: true,
      updatedAt: "2026-05-30T18:06:00.000Z",
      cookies: { count: 2, domains: ["example.com"] },
      localStorage: { originCount: 1, keyCount: 2, origins: ["https://example.com"] },
      sessionStorage: { originCount: 1, keyCount: 1, origins: ["https://example.com"] },
      context: {
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
        geolocationConfigured: true,
        extraHTTPHeadersCount: 1,
        httpCredentialsConfigured: true,
      },
    },
    eventSummary: {
      recentEventCount: 4,
      guardBlockCount: 2,
      grantedAccessCount: 1,
      lastAccessAt: "2026-05-30T18:03:00.000Z",
      lastStateMutationAt: "2026-05-30T18:01:00.000Z",
    },
  });
  browserSessionMocks.fetchBrowserSessionEvents.mockResolvedValue([
    {
      eventId: "event-1",
      sessionId: "browser-session-1",
      eventType: "tool_guard_blocked",
      actorId: "agent-1",
      payload: {
        toolName: "browser.storage.get",
        runId: "run-blocked-latest",
        host: "blocked.example",
      },
      createdAt: "2026-05-30T18:04:00.000Z",
    },
    {
      eventId: "event-2",
      sessionId: "browser-session-1",
      eventType: "tool_access_granted",
      actorId: "agent-1",
      payload: {
        toolName: "browser.navigate",
        runId: "run-browser-session-posture",
        host: "example.com",
        requiredScope: "read",
      },
      createdAt: "2026-05-30T18:03:00.000Z",
    },
    {
      eventId: "event-3",
      sessionId: "browser-session-1",
      eventType: "grant_created",
      actorId: "agent-1",
      payload: { scopes: ["read", "state"], allowedHosts: ["example.com"] },
      createdAt: "2026-05-30T18:01:00.000Z",
    },
    {
      eventId: "event-4",
      sessionId: "browser-session-1",
      eventType: "tool_guard_blocked",
      actorId: "agent-1",
      payload: {
        toolName: "browser.navigate",
        runId: "run-browser-session-posture",
        host: "blocked.example",
        cookieValue: "secret-cookie",
        localStorage: { token: "secret-token" },
      },
      createdAt: "2026-05-30T18:02:00.000Z",
    },
  ]);
});

describe("BrowserSessionsRoutePage", () => {
  it("renders sessions, grants, and events without exposing browser state contents", async () => {
    const renderer = await renderPage();
    const text = collectText(renderer.root);

    expect(browserSessionMocks.fetchBrowserSessions).toHaveBeenCalledWith({
      workspaceId: "default",
      status: "active",
      limit: 100,
    });
    expect(browserSessionMocks.fetchBrowserSessionGrants).toHaveBeenCalledWith("browser-session-1", {
      status: "all",
      limit: 100,
    });
    expect(browserSessionMocks.fetchBrowserSessionState).toHaveBeenCalledWith("browser-session-1");
    expect(text).toContain("Browser Sessions");
    expect(text).toContain("Research browser");
    expect(text).toContain("agent-1");
    expect(text).toContain("grant_created");
    expect(text).toContain("State and tool posture");
    expect(text).toContain("Governed grants ready");
    expect(text).toContain("tool_access_granted");
    expect(text).toContain("Latest access");
    expect(text).toContain("guard blocks");
    expect(text).toContain("Read-only state projection");
    expect(text).toContain("State retained");
    expect(text).toContain("2 keys");
    expect(text).toContain("locale en-US");
    expect(text).toContain("credentials configured");
    expect(text).toContain("browser.navigate");
    expect(text).toContain("browser.storage.get");
    expect(text).toContain("browser state values hidden");
    expect(text).toContain("cookie or storage values are not shown");
    expect(text).not.toContain("secret-cookie");
    expect(text).not.toContain("secret-token");
  });

  it("creates sessions and scoped grants with explicit host and TTL input", async () => {
    browserSessionMocks.createBrowserSession.mockResolvedValueOnce({
      sessionId: "browser-session-2",
      workspaceId: "default",
      label: "New browser",
      status: "active",
      createdBy: "operator",
      createdAt: "2026-05-30T18:10:00.000Z",
      updatedAt: "2026-05-30T18:10:00.000Z",
    });
    browserSessionMocks.createBrowserSessionGrant.mockResolvedValueOnce({
      grantId: "grant-2",
      sessionId: "browser-session-1",
      actorId: "agent-2",
      scopes: ["read"],
      allowedHosts: [],
      createdAt: "2026-05-30T18:11:00.000Z",
    });
    const renderer = await renderPage();

    await act(async () => {
      findInput(renderer.root, "Research browser").props.onChange({ target: { value: "New browser" } });
    });
    await act(async () => {
      findButton(renderer.root, "Create governed session").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(browserSessionMocks.createBrowserSession).toHaveBeenCalledWith({
      workspaceId: "default",
      label: "New browser",
    });

    await act(async () => {
      findInput(renderer.root, "operator or agent id").props.onChange({ target: { value: "agent-2" } });
      findInput(renderer.root, "example.com, docs.example.com").props.onChange({
        target: { value: "docs.example.com, example.com" },
      });
    });
    await act(async () => {
      findButton(renderer.root, "Create scoped grant").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(browserSessionMocks.createBrowserSessionGrant).toHaveBeenCalledWith("browser-session-1", {
      actorId: "agent-2",
      scopes: ["read"],
      allowedHosts: ["docs.example.com", "example.com"],
      ttlSeconds: 900,
    });
  });

  it("returns to the active filter after creating a session from another filter", async () => {
    browserSessionMocks.fetchBrowserSessions.mockImplementation(async ({ status }: { status: string }) =>
      status === "closed"
        ? [
            {
              sessionId: "browser-session-closed",
              workspaceId: "default",
              label: "Closed browser",
              status: "closed",
              createdBy: "operator",
              createdAt: "2026-05-30T17:00:00.000Z",
              updatedAt: "2026-05-30T17:05:00.000Z",
              closedAt: "2026-05-30T17:05:00.000Z",
            },
          ]
        : [
            {
              sessionId: "browser-session-2",
              workspaceId: "default",
              label: "New browser",
              status: "active",
              createdBy: "operator",
              createdAt: "2026-05-30T18:10:00.000Z",
              updatedAt: "2026-05-30T18:10:00.000Z",
            },
          ],
    );
    browserSessionMocks.createBrowserSession.mockResolvedValueOnce({
      sessionId: "browser-session-2",
      workspaceId: "default",
      label: "New browser",
      status: "active",
      createdBy: "operator",
      createdAt: "2026-05-30T18:10:00.000Z",
      updatedAt: "2026-05-30T18:10:00.000Z",
    });
    const renderer = await renderPage();

    await act(async () => {
      findExactButton(renderer.root, "Closed").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      findInput(renderer.root, "Research browser").props.onChange({ target: { value: "New browser" } });
    });
    await act(async () => {
      findButton(renderer.root, "Create governed session").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(browserSessionMocks.createBrowserSession).toHaveBeenCalledWith({
      workspaceId: "default",
      label: "New browser",
    });
    expect(browserSessionMocks.fetchBrowserSessions).toHaveBeenLastCalledWith({
      workspaceId: "default",
      status: "active",
      limit: 100,
    });
    expect(findExactButton(renderer.root, "Active").props["aria-pressed"]).toBe(true);
    expect(collectText(renderer.root)).toContain("New browser");
    expect(collectText(renderer.root)).toContain("Browser session created");
  });

  it("closes sessions and rotates or revokes active scoped grants", async () => {
    browserSessionMocks.closeBrowserSession.mockResolvedValueOnce({
      sessionId: "browser-session-1",
      status: "closed",
    });
    browserSessionMocks.rotateBrowserSessionGrant.mockResolvedValueOnce({
      grantId: "grant-rotated",
      sessionId: "browser-session-1",
      actorId: "agent-1",
      scopes: ["read", "state"],
      allowedHosts: ["example.com"],
      createdAt: "2026-05-30T18:02:00.000Z",
    });
    browserSessionMocks.revokeBrowserSessionGrant.mockResolvedValueOnce({
      grantId: "grant-1",
      sessionId: "browser-session-1",
      actorId: "agent-1",
      scopes: ["read", "state"],
      allowedHosts: ["example.com"],
      createdAt: "2026-05-30T18:01:00.000Z",
      revokedAt: "2026-05-30T18:03:00.000Z",
    });
    const renderer = await renderPage();

    await act(async () => {
      findButton(renderer.root, "Rotate").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(browserSessionMocks.rotateBrowserSessionGrant).toHaveBeenCalledWith("browser-session-1", "grant-1");

    await act(async () => {
      findButton(renderer.root, "Revoke").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(browserSessionMocks.revokeBrowserSessionGrant).toHaveBeenCalledWith("browser-session-1", "grant-1");

    await act(async () => {
      findButton(renderer.root, "Close session and revoke grants").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(browserSessionMocks.closeBrowserSession).toHaveBeenCalledWith("browser-session-1");
  });

  it("blocks scoped grant creation without an actor or selected scope", async () => {
    const renderer = await renderPage();

    await act(async () => {
      findInput(renderer.root, "operator or agent id").props.onChange({ target: { value: "" } });
    });
    await act(async () => {
      findButton(renderer.root, "Create scoped grant").props.onClick();
    });
    expect(collectText(renderer.root)).toContain("Grant actor is required.");
    expect(browserSessionMocks.createBrowserSessionGrant).not.toHaveBeenCalled();

    await act(async () => {
      findInput(renderer.root, "operator or agent id").props.onChange({ target: { value: "agent-1" } });
      findExactButton(renderer.root, "read").props.onClick();
    });
    await act(async () => {
      findButton(renderer.root, "Create scoped grant").props.onClick();
    });
    expect(collectText(renderer.root)).toContain("Choose at least one grant scope.");
    expect(browserSessionMocks.createBrowserSessionGrant).not.toHaveBeenCalled();
  });

  it("keeps session detail visible when events fail to load", async () => {
    browserSessionMocks.fetchBrowserSessionEvents.mockRejectedValueOnce(new Error("events offline"));
    const renderer = await renderPage();
    const text = collectText(renderer.root);

    expect(text).toContain("Research browser");
    expect(text).toContain("Some data could not load");
    expect(text).toContain("events offline");
  });

  it("labels absent volatile state as not retained instead of empty", async () => {
    browserSessionMocks.fetchBrowserSessionState.mockResolvedValueOnce({
      session: {
        sessionId: "browser-session-1",
        workspaceId: "default",
        label: "Research browser",
        status: "active",
        createdBy: "operator",
        createdAt: "2026-05-30T18:00:00.000Z",
        updatedAt: "2026-05-30T18:05:00.000Z",
      },
      state: {
        availability: "not_available",
        source: "policy_engine_memory",
        retention: "volatile",
        valuesHidden: true,
        cookies: { count: 0, domains: [] },
        localStorage: { originCount: 0, keyCount: 0, origins: [] },
        sessionStorage: { originCount: 0, keyCount: 0, origins: [] },
        context: {
          geolocationConfigured: false,
          extraHTTPHeadersCount: 0,
          httpCredentialsConfigured: false,
        },
      },
      eventSummary: {
        recentEventCount: 0,
        guardBlockCount: 0,
        grantedAccessCount: 0,
      },
    });
    const renderer = await renderPage();
    const text = collectText(renderer.root);

    expect(text).toContain("Not retained");
    expect(text).toContain("no domains");
    expect(text).not.toContain("Empty state");
  });
});

async function renderPage(): Promise<ReactTestRenderer> {
  const { BrowserSessionsRoutePage } = await import("./BrowserSessionsRoutePage");
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <BrowserSessionsRoutePage
        route={{ area: "ops", section: "sessions", view: "browser-sessions", theme: "ops" } as never}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findExactButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).trim() === label)[0];
  if (!match) {
    throw new Error(`Unable to find exact button: ${label}`);
  }
  return match;
}

function findInput(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "input" && node.props.placeholder === placeholder)[0];
  if (!match) {
    throw new Error(`Unable to find input: ${placeholder}`);
  }
  return match;
}

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}
