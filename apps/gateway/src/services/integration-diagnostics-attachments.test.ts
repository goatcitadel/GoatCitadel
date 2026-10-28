import { describe, expect, it, vi } from "vitest";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import type { ChannelSetupIssue, ChannelSetupTestResult, IntegrationConnection } from "@goatcitadel/contracts";
import { listChannelSetupDefinitions } from "./channel-setup-definitions.js";
import { evaluateChannelSetupEligibility } from "./channel-setup-eligibility.js";
import {
  buildIntegrationConnectionChecks,
  type IntegrationDiagnosticsPort,
} from "./integration-diagnostics-service.js";

/**
 * Ruling R45: a channel that sends text only has no attachment sources. That is a fact about the channel, not a setup
 * problem, so it must be stated plainly and must never hold Finalize back.
 */
const TEXT_ONLY_MESSAGE = "This channel sends text. Attachments aren't supported.";

/** Every guided channel whose capabilities advertise no attachment source. Pinned: a new entry needs a decision. */
const TEXT_ONLY_CHANNELS = ["line", "matrix", "nextcloud-talk", "qqbot", "wecom", "zalo"];

function guidedChannelKeys(): string[] {
  return listChannelSetupDefinitions().map((definition) => definition.catalog.key);
}

function hasAttachmentSources(key: string): boolean {
  return describeChannelCapabilities(key, {}).supportedAttachmentSources.length > 0;
}

function connectionOf(key: string): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label: key,
    revision: "1",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  };
}

function port(): IntegrationDiagnosticsPort {
  return {
    config: {
      toolPolicy: { tools: { profile: "default" }, sandbox: { networkAllowlist: [] } },
    } as unknown as IntegrationDiagnosticsPort["config"],
    fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("{}", { status: 200 })),
    getDiscordRuntimeStatus: vi.fn(() => undefined),
    isConnectionUrlAllowlisted: vi.fn(() => true),
    readConnectionConfigValue: vi.fn((values: Record<string, unknown>, key: string) => {
      const value = values[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn(() => undefined),
  };
}

function attachmentsCheck(key: string) {
  const check = buildIntegrationConnectionChecks(port(), connectionOf(key)).find(
    (candidate) => candidate.key === "attachments",
  );
  if (!check) throw new Error(`${key} reports no attachments check`);
  return check;
}

/** What the setup test does with this one check: a non-pass becomes an issue, then Finalize eligibility is decided. */
function eligibilityOfAttachmentsAlone(key: string) {
  const check = attachmentsCheck(key);
  const issues: ChannelSetupIssue[] =
    check.status === "pass"
      ? []
      : [{ key: check.key, level: check.status === "fail" ? "error" : "warn", message: check.message }];
  const result: ChannelSetupTestResult = {
    draftId: "22222222-2222-2222-2222-222222222222",
    draftRevision: 1,
    status: issues.some((issue) => issue.level === "error") ? "error" : issues.length > 0 ? "warn" : "ok",
    levels: [],
    issues,
    checkedAt: "2026-03-29T00:00:00.000Z",
  };
  return evaluateChannelSetupEligibility(result, connectionOf(key));
}

describe("the attachments diagnostic for a text-only channel (R45)", () => {
  it("is the guided channels with no attachment source, taken from the capability data", () => {
    expect(
      guidedChannelKeys()
        .filter((key) => !hasAttachmentSources(key))
        .sort(),
    ).toEqual(TEXT_ONLY_CHANNELS);
  });

  it.each(TEXT_ONLY_CHANNELS)("%s says plainly that it sends text and has no attachments", (key) => {
    expect(attachmentsCheck(key)).toEqual({ key: "attachments", status: "pass", message: TEXT_ONLY_MESSAGE });
  });

  it.each(TEXT_ONLY_CHANNELS)("%s: the attachments result does not hold Finalize back", (key) => {
    expect(eligibilityOfAttachmentsAlone(key)).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("uses no word the operator copy rules ban", () => {
    for (const key of TEXT_ONLY_CHANNELS) {
      expect(attachmentsCheck(key).message).not.toMatch(
        /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
      );
    }
  });
});

describe("the attachments diagnostic for a channel that can send attachments", () => {
  const withSources = guidedChannelKeys().filter(hasAttachmentSources);

  it("is every other guided channel", () => {
    expect([...withSources, ...TEXT_ONLY_CHANNELS].sort()).toEqual([...guidedChannelKeys()].sort());
    expect(withSources.length).toBeGreaterThan(0);
  });

  it.each(withSources)("%s still lists the sources it supports", (key) => {
    const sources = describeChannelCapabilities(key, {}).supportedAttachmentSources;

    expect(attachmentsCheck(key)).toEqual({
      key: "attachments",
      status: "pass",
      message: `Supported attachment sources: ${sources.join(", ")}.`,
    });
  });
});
