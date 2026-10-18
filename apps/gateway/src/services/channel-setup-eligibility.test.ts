import { describe, expect, it } from "vitest";
import type { ChannelSetupTestResult, IntegrationConnection } from "@goatcitadel/contracts";
import { evaluateChannelSetupEligibility } from "./channel-setup-eligibility.js";
const connection = { key: "telegram", config: {} } as IntegrationConnection;
function result(overrides: Partial<ChannelSetupTestResult> = {}): ChannelSetupTestResult {
  return {
    draftId: "draft",
    draftRevision: 1,
    status: "ok",
    levels: [],
    issues: [],
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}
describe("Gateway channel finalization eligibility", () => {
  it("requires an exact successful send receipt before allowing acknowledged optional cleanup", () => {
    const test = result({
      status: "warn",
      issues: [{ key: "telegram_sandbox_cleanup", level: "warn", message: "Cleanup permission unavailable" }],
      probe: {
        kind: "telegram",
        checkedAt: new Date().toISOString(),
        steps: [
          {
            key: "telegram_sandbox_send",
            label: "Send",
            status: "pass",
            message: "Accepted",
            providerMessageId: "123",
            disposition: "blocking",
          },
          {
            key: "telegram_sandbox_cleanup",
            label: "Cleanup",
            status: "warn",
            message: "Manual cleanup needed",
            disposition: "advisory",
            cleanupStatus: "manual_required",
          },
        ],
      },
    });
    expect(evaluateChannelSetupEligibility(test, connection)).toMatchObject({
      allowed: false,
      requiresAcknowledgement: true,
    });
    expect(evaluateChannelSetupEligibility(test, connection, true).allowed).toBe(true);
    test.probe!.steps[0]!.providerMessageId = undefined;
    expect(evaluateChannelSetupEligibility(test, connection, true).allowed).toBe(false);
  });
  it.each(["credential_rejected", "permission_mismatch", "destination_mismatch", "platform_unavailable"])(
    "never waives a required %s warning",
    (category) => {
      expect(
        evaluateChannelSetupEligibility(
          result({ status: "warn", issues: [{ key: "required_check", level: "warn", message: category }] }),
          connection,
          true,
        ).allowed,
      ).toBe(false);
    },
  );
  it("allows save with default-deny inbound deferred without claiming the conversation works", () => {
    const test = result({
      status: "warn",
      issues: [{ key: "inbound_access_allowlist_empty", level: "warn", message: "No senders allowed" }],
    });
    expect(evaluateChannelSetupEligibility(test, connection).allowed).toBe(true);
    expect(test.issues[0]!.disposition).toBe("deferred");
  });
  it.each(["fail", "warn"] as const)("blocks a required probe %s even if its issue projection is absent", (status) => {
    const test = result({
      probe: {
        kind: "telegram",
        checkedAt: new Date().toISOString(),
        steps: [
          {
            key: "telegram_auth",
            label: "Auth",
            status,
            message: "Unknown authorization result",
            disposition: "blocking",
          },
        ],
      },
    });
    expect(evaluateChannelSetupEligibility(test, connection, true).allowed).toBe(false);
  });
  it("blocks error status even when only informational issues were projected", () => {
    expect(
      evaluateChannelSetupEligibility(
        result({ status: "error", issues: [{ key: "info", level: "info", message: "Info" }] }),
        connection,
        true,
      ).allowed,
    ).toBe(false);
  });
  it("defers the optional Matrix default-room warning but keeps it blocking once a room is set", () => {
    const matrix = { key: "matrix", config: {} } as IntegrationConnection;
    const test = result({
      status: "warn",
      issues: [{ key: "target", level: "warn", message: "No default Matrix room" }],
    });
    expect(evaluateChannelSetupEligibility(test, matrix).allowed).toBe(true);
    expect(test.issues[0]!.disposition).toBe("deferred");
    const withRoom = { key: "matrix", config: { defaultRoomId: "!r:x.com" } } as unknown as IntegrationConnection;
    const again = result({
      status: "warn",
      issues: [{ key: "target", level: "warn", message: "No default Matrix room" }],
    });
    expect(evaluateChannelSetupEligibility(again, withRoom).allowed).toBe(false);
  });
  it("defers the optional QQBot and WeCom default-target warning but keeps it blocking once a target is set", () => {
    for (const key of ["qqbot", "wecom"]) {
      const bare = { key, config: {} } as IntegrationConnection;
      const test = result({
        status: "warn",
        issues: [{ key: "target", level: "warn", message: "No default target" }],
      });
      expect(evaluateChannelSetupEligibility(test, bare).allowed).toBe(true);
      expect(test.issues[0]!.disposition).toBe("deferred");
      const withTarget = { key, config: { defaultTarget: "user:u1" } } as unknown as IntegrationConnection;
      const again = result({
        status: "warn",
        issues: [{ key: "target", level: "warn", message: "No default target" }],
      });
      expect(evaluateChannelSetupEligibility(again, withTarget).allowed).toBe(false);
    }
  });
  it("does not let the advisory WeCom callback warning block an outbound-only finalization", () => {
    const wecom = { key: "wecom", config: {} } as IntegrationConnection;
    const test = result({
      status: "warn",
      issues: [{ key: "wecom_callback", level: "warn", message: "Inbound callback: inbound is disabled" }],
      probe: {
        kind: "wecom_application",
        checkedAt: new Date().toISOString(),
        steps: [
          { key: "wecom_auth", label: "Auth", status: "pass", message: "ok" },
          {
            key: "wecom_callback",
            label: "Inbound callback",
            status: "warn",
            disposition: "advisory",
            message: "inbound is disabled",
          },
          {
            key: "wecom_sandbox_send",
            label: "Send",
            status: "pass",
            message: "ok",
            providerMessageId: "m1",
          },
        ],
      },
    });
    expect(evaluateChannelSetupEligibility(test, wecom).allowed).toBe(true);
    // The same warning from any other step stays blocking.
    const other = result({
      status: "warn",
      probe: {
        kind: "wecom_application",
        checkedAt: new Date().toISOString(),
        steps: [{ key: "wecom_agent", label: "App", status: "warn", disposition: "advisory", message: "x" }],
      },
    });
    expect(evaluateChannelSetupEligibility(other, wecom).allowed).toBe(false);
  });
});
