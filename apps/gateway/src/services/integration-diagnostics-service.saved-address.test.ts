import { describe, expect, it, vi } from "vitest";
import { resolveConnectionConfigSecret } from "./channel-secret-resolution.js";
import { guideFinish } from "./channel-setup-definitions/guide-finish.test-support.js";
import {
  buildIntegrationConnectionChecks,
  type IntegrationDiagnosticsPort,
} from "./integration-diagnostics-service.js";

/**
 * A pasted webhook address is the secret, so a saved connection holds a reference to it, not the address. The address
 * checks (is it https, is its host allowed) must read the address the reference points to, for the connection that
 * saved it; a reference they cannot read is a missing address, and the address is never reported.
 */
const OWN_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const referenceFor = (connectionId: string) =>
  `keychain:goatcitadel:channel-connection:${connectionId}:webhookUrl:0001`;
const accountFor = (connectionId: string) => `channel-connection:${connectionId}:webhookUrl:0001`;

const CHANNELS = [
  {
    catalogId: "channel.google-chat",
    label: "Google Chat webhook URL",
    address: "https://chat.googleapis.com/v1/spaces/AAAAxxxx/messages?key=synthetic-key&token=synthetic-saved-address",
  },
  {
    catalogId: "channel.teams",
    label: "Teams webhook URL",
    address:
      "https://defaultenvironment.00.environment.api.powerplatform.com/powerautomate/automations/direct/cu/20/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sig=synthetic-saved-address",
  },
  {
    catalogId: "channel.slack",
    label: "Slack webhook URL",
    address: "https://hooks.slack.com/services/T0000/B0000/synthetic-saved-address",
  },
  {
    catalogId: "channel.discord",
    label: "Discord webhook URL",
    address: "https://discord.com/api/webhooks/123456789012345678/synthetic-saved-address",
  },
] as const;

function urlCheckFor(
  catalogId: string,
  config: Record<string, unknown>,
  store: Record<string, string>,
  allowlisted = true,
) {
  const { connectionOf, port } = guideFinish(catalogId);
  const read = vi.fn((account: string) => store[account]);
  const deps: IntegrationDiagnosticsPort = {
    ...port(),
    isConnectionUrlAllowlisted: vi.fn(() => allowlisted),
    resolveConnectionSecret: (values, directKey, envKey, owningCatalogId, owner) =>
      resolveConnectionConfigSecret({ getSecret: read }, values, directKey, envKey, owningCatalogId, owner),
  };
  const checks = buildIntegrationConnectionChecks(deps, connectionOf(config));
  return { check: checks.find((check) => check.key === "url"), checks, read };
}

describe.each(CHANNELS)("the $label check on a saved connection", ({ catalogId, label, address }) => {
  it("reads the address its own reference points to", () => {
    const { check, checks } = urlCheckFor(
      catalogId,
      { webhookUrl: referenceFor(OWN_ID) },
      { [accountFor(OWN_ID)]: address },
    );

    expect(check).toEqual({
      key: "url",
      status: "pass",
      message: `${label} host is on the network allowlist.`,
    });
    expect(JSON.stringify(checks)).not.toContain("synthetic-saved-address");
    expect(JSON.stringify(checks)).not.toContain(referenceFor(OWN_ID));
  });

  it("still refuses a saved address that is plain http beyond this computer", () => {
    const { check } = urlCheckFor(
      catalogId,
      { webhookUrl: referenceFor(OWN_ID) },
      { [accountFor(OWN_ID)]: address.replace("https://", "http://") },
    );

    expect(check).toEqual({ key: "url", status: "fail", message: `${label} uses non-local plain HTTP.` });
  });

  it("warns when the saved address's host is not on the network allowlist", () => {
    const { check } = urlCheckFor(
      catalogId,
      { webhookUrl: referenceFor(OWN_ID) },
      { [accountFor(OWN_ID)]: address },
      false,
    );

    expect(check).toMatchObject({ key: "url", status: "warn" });
  });

  it("never reads another connection's reference, and calls the address missing", () => {
    const { check, read } = urlCheckFor(
      catalogId,
      { webhookUrl: referenceFor(OTHER_ID) },
      { [accountFor(OTHER_ID)]: address },
    );

    expect(read).not.toHaveBeenCalled();
    // A saved address that can't be read is a missing address, whether or not the channel needs one: the setup used to
    // say nothing about it for the optional webhooks of Slack and Discord.
    expect(check).toEqual({ key: "url", status: "fail", message: `${label} is missing.` });
  });

  it("calls the address missing when secure storage no longer holds it", () => {
    const { check } = urlCheckFor(catalogId, { webhookUrl: referenceFor(OWN_ID) }, {});

    expect(check).toEqual({ key: "url", status: "fail", message: `${label} is missing.` });
  });

  it("calls the address missing for a reference that is not a channel reference, and never reads it", () => {
    const { check, checks, read } = urlCheckFor(
      catalogId,
      { webhookUrl: "keychain:goatcitadel:provider:openai:0001" },
      { "provider:openai:0001": address },
    );

    expect(read).not.toHaveBeenCalled();
    expect(check).toEqual({ key: "url", status: "fail", message: `${label} is missing.` });
    expect(JSON.stringify(checks)).not.toContain("synthetic-saved-address");
  });

  it("does not ask the resolver about a reference that is not a channel reference", () => {
    const { connectionOf, port } = guideFinish(catalogId);
    const resolveConnectionSecret = vi.fn(() => address);
    const checks = buildIntegrationConnectionChecks(
      { ...port(), isConnectionUrlAllowlisted: vi.fn(() => true), resolveConnectionSecret },
      connectionOf({ webhookUrl: "keychain:goatcitadel:approval-remote-action:0001" }),
    );

    expect(resolveConnectionSecret).not.toHaveBeenCalled();
    expect(checks.find((check) => check.key === "url")).toEqual({
      key: "url",
      status: "fail",
      message: `${label} is missing.`,
    });
  });

  it("checks an address saved as plain text the way it always was", () => {
    const { check, read } = urlCheckFor(catalogId, { webhookUrl: address }, {});

    expect(check).toMatchObject({ key: "url", status: "pass" });
    expect(read).not.toHaveBeenCalled();
  });
});
