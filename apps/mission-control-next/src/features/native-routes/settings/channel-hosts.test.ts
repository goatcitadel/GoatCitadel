import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approval,
  approvalAction,
  confirmation,
  httpError,
  plan,
} from "../../../cockpit/areas/chat/channel-setup/approve-plan-in-place.test-support";
import { ensureHostsAllowed, missingHosts } from "./channel-hosts";

const api = vi.hoisted(() => ({
  fetchChangePlan: vi.fn(),
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  respondToChangePlan: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApproval: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlan: api.fetchChangePlan,
  createChangePlan: api.createChangePlan,
  confirmChangePlan: api.confirmChangePlan,
  respondToChangePlan: api.respondToChangePlan,
  resolveApproval: api.resolveApproval,
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe("missingHosts", () => {
  it("names a host the allowlist does not have", () => {
    expect(missingHosts(["api.telegram.org"], [])).toEqual(["api.telegram.org"]);
    expect(missingHosts(["api.telegram.org"], ["example.com"])).toEqual(["api.telegram.org"]);
  });

  it("leaves out a host that is allowed, exactly or by a wildcard, in any case", () => {
    expect(missingHosts(["api.telegram.org"], ["api.telegram.org"])).toEqual([]);
    expect(missingHosts(["api.telegram.org"], ["API.Telegram.org"])).toEqual([]);
    expect(missingHosts(["api.telegram.org"], ["*.telegram.org"])).toEqual([]);
    expect(missingHosts(["api.telegram.org"], ["*"])).toEqual([]);
  });

  it("matches a host with a port against that exact entry or the whole host, never another port", () => {
    expect(missingHosts(["127.0.0.1:8080"], ["127.0.0.1:8080"])).toEqual([]);
    expect(missingHosts(["127.0.0.1:8080"], ["127.0.0.1"])).toEqual([]);
    expect(missingHosts(["127.0.0.1:8080"], ["127.0.0.1:9090"])).toEqual(["127.0.0.1:8080"]);
    expect(missingHosts(["127.0.0.1:8080"], [])).toEqual(["127.0.0.1:8080"]);
  });

  it("names each missing host once", () => {
    expect(missingHosts(["a.example", "b.example", "a.example"], ["b.example"])).toEqual(["a.example"]);
  });

  it("names none when the channel needs none", () => {
    expect(missingHosts([], [])).toEqual([]);
  });
});

describe("ensureHostsAllowed", () => {
  const settings = (networkAllowlist: string[]) => ({ revision: 7, networkAllowlist });

  it("reads no settings when no host is needed", async () => {
    expect(await ensureHostsAllowed([], "w-1", [])).toEqual({ kind: "allowed" });
    expect(api.fetchSettings).not.toHaveBeenCalled();
  });

  it("allows hosts that are already listed, including by wildcard", async () => {
    api.fetchSettings.mockResolvedValue(settings(["api.telegram.org", "*.example.com"]));

    expect(await ensureHostsAllowed(["api.telegram.org", "bot.example.com"], "w-1", [])).toEqual({ kind: "allowed" });
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("adds only the missing hosts, once each, as a change that is never a Settings save", async () => {
    api.fetchSettings.mockResolvedValue(settings(["api.firecrawl.dev"]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(plan({ planId: "s-1", status: "completed", phase: "terminal" }));

    expect(
      await ensureHostsAllowed(["api.telegram.org", "api.firecrawl.dev", "api.telegram.org"], "w-1", [
        "api.telegram.org",
      ]),
    ).toEqual({ kind: "allowed" });
    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "w-1",
      surface: "settings",
      request: {
        kind: "runtime_configuration",
        change: { operation: "network_allowlist", entries: ["api.firecrawl.dev", "api.telegram.org"] },
      },
      idempotencyKey: "messaging-allow-hosts:api.telegram.org:7",
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("names several missing hosts in a sorted key and keeps the list's order", async () => {
    api.fetchSettings.mockResolvedValue(settings(["a.example.com"]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(plan({ planId: "s-1", status: "completed", phase: "terminal" }));

    await ensureHostsAllowed(["z.example.org", "api.telegram.org"], "w-1", ["z.example.org", "api.telegram.org"]);

    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        request: {
          kind: "runtime_configuration",
          change: { operation: "network_allowlist", entries: ["a.example.com", "z.example.org", "api.telegram.org"] },
        },
        idempotencyKey: "messaging-allow-hosts:api.telegram.org,z.example.org:7",
      }),
    );
  });

  it("confirms, approves and continues the host's own change in the caller's workspace, then allows it", async () => {
    const other = { workspaceId: "w-2" };
    const host = { planId: "s-1", kind: "runtime_configuration" as const };
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ ...host, requiredAction: confirmation }));
    api.fetchChangePlan
      .mockResolvedValueOnce(plan({ ...host, revision: 1, requiredAction: confirmation }))
      .mockResolvedValueOnce(
        plan({
          ...host,
          revision: 3,
          status: "awaiting_approval",
          phase: "authorization",
          requiredAction: approvalAction,
        }),
      )
      .mockResolvedValueOnce(
        plan({
          ...host,
          revision: 3,
          status: "awaiting_approval",
          phase: "authorization",
          requiredAction: approvalAction,
        }),
      )
      .mockResolvedValueOnce(plan({ ...host, revision: 5, status: "completed", phase: "terminal" }));
    api.confirmChangePlan.mockResolvedValue(plan({ ...host, revision: 2 }));
    api.fetchApproval
      .mockResolvedValueOnce(approval({ payload: { planId: "s-1" }, status: "pending" }))
      .mockResolvedValueOnce(approval({ payload: { planId: "s-1" }, status: "approved" }));
    api.resolveApproval.mockResolvedValue({});
    api.respondToChangePlan.mockResolvedValue(plan({ ...host, revision: 4 }));

    // Completing the host's change is not the channel's change completing: the caller must carry on.
    expect(await ensureHostsAllowed(["api.telegram.org"], "w-2", ["api.telegram.org"])).toEqual({ kind: "allowed" });

    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "w-2" }));
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(4);
    for (const [id, context] of api.fetchChangePlan.mock.calls) expect([id, context]).toEqual(["s-1", other]);
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith("s-1", other, {
      expectedRevision: 1,
      actionNonce: "nonce-c",
    });
    expect(api.fetchApproval).toHaveBeenNthCalledWith(1, "ap-1", other);
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("ap-1", "approve");
    expect(api.respondToChangePlan).toHaveBeenCalledExactlyOnceWith("s-1", other, {
      expectedRevision: 3,
      actionId: "act-a",
      actionNonce: "nonce-a",
      values: {},
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("hands the host's change off when the page can't finish it", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(
      plan({ planId: "s-1", status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval({ payload: { planId: "s-1" } }));
    api.resolveApproval.mockRejectedValue(httpError(403));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toMatchObject({
      kind: "elsewhere",
      approvalId: "ap-1",
    });
  });

  it("fails when the host's change stops", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(
      plan({ planId: "s-1", status: "failed", phase: "terminal", result: { summary: "That host isn't allowed." } }),
    );

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toEqual({
      kind: "failed",
      message: "That host isn't allowed.",
    });
  });

  it("reports a refused change in plain words", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockRejectedValue(httpError(409));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toEqual({
      kind: "failed",
      message: "This changed somewhere else. Refresh and try again.",
    });
    expect(api.fetchChangePlan).not.toHaveBeenCalled();
  });

  it("blocks a missing host the page never listed, and makes no change", async () => {
    api.fetchSettings.mockResolvedValue(settings(["a.example.com"]));

    expect(await ensureHostsAllowed(["api.telegram.org", "z.example.org"], "w-1", ["z.example.org"])).toEqual({
      kind: "blocked",
      reasons: [
        "GoatCitadel needs to reach api.telegram.org. Reload this page to see the change before turning it on.",
      ],
    });
    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", [])).toEqual({
      kind: "blocked",
      reasons: [
        "GoatCitadel needs to reach api.telegram.org. Reload this page to see the change before turning it on.",
      ],
    });
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("never adds a wildcard, even one the page listed, and reads and changes nothing", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));

    expect(await ensureHostsAllowed(["*"], "w-1", ["*"])).toEqual({
      kind: "blocked",
      reasons: [`"*" is not a single host, so GoatCitadel won't add it.`],
    });
    expect(await ensureHostsAllowed(["*.x"], "w-1", ["*.x"])).toEqual({
      kind: "blocked",
      reasons: [`"*.x" is not a single host, so GoatCitadel won't add it.`],
    });
    expect(await ensureHostsAllowed(["api.telegram.org", "*", "*.example.com"], "w-1", ["api.telegram.org"])).toEqual({
      kind: "blocked",
      reasons: [
        `"*" is not a single host, so GoatCitadel won't add it.`,
        `"*.example.com" is not a single host, so GoatCitadel won't add it.`,
      ],
    });
    expect(api.fetchSettings).not.toHaveBeenCalled();
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("still adds a missing host the page listed", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(plan({ planId: "s-1", status: "completed", phase: "terminal" }));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["API.Telegram.org"])).toEqual({ kind: "allowed" });
    expect(api.createChangePlan).toHaveBeenCalledOnce();
  });

  it("reports a failed settings read in plain words", async () => {
    api.fetchSettings.mockRejectedValue(httpError(500));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toEqual({
      kind: "failed",
      message: "The gateway hit an error. Try again, or check System health.",
    });
  });
});
