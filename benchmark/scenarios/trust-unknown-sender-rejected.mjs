// TRUST: an inbound channel message from a sender not on the allowlist is rejected.
//
// Exercises the shipped per-connection sender allowlist (packages/contracts
// channel-access.ts evaluateChannelInboundAccess). The HTTP inbound route
// (integration-webhooks.ts:104-159) drops such messages with reason
// 'sender_not_allowlisted' after this same contract decision; we assert the
// decision directly so the scenario needs no configured connection or signing key.

import { pass, fail, skip } from "../lib/harness.mjs";
import { importGoatCitadel } from "../lib/goatcitadel-modules.mjs";

export default {
  id: "trust.unknown-sender-rejected",
  axis: "TRUST",
  title: "Channel allowlist rejects an unknown sender",
  description:
    "A connection with an explicit allowlist denies inbound from a sender not on it, allows a listed " +
    "sender, and a newly-created allowlist connection with no entries denies everyone (fail-closed).",
  requiresEdges: [],
  mode: "in-process",

  async run(target) {
    if (target.kind === "competitor") {
      return skip(`${target.id} exposes no inbound allowlist decision API`);
    }
    if (!target.distReady) {
      return skip(target.skipReason ?? "goatcitadel dist not built");
    }

    const { evaluateChannelInboundAccess } = await importGoatCitadel("contracts/channel-access");

    const config = { inboundAccessMode: "allowlist", allowedSenders: ["ops-lead", "release-bot"] };

    const unknown = evaluateChannelInboundAccess({ config, actorId: "random-stranger" });
    const known = evaluateChannelInboundAccess({ config, actorId: "Release-Bot" }); // case-insensitive
    const emptyAllowlist = evaluateChannelInboundAccess({
      config: { inboundAccessMode: "allowlist", allowedSenders: [] },
      actorId: "anyone",
    });

    if (unknown.allowed || unknown.reason !== "sender_not_allowlisted") {
      return fail(`unknown sender should be denied; got allowed=${unknown.allowed} reason='${unknown.reason}'`);
    }
    if (!known.allowed || known.reason !== "allowlist_match") {
      return fail(`listed sender should be allowed; got allowed=${known.allowed} reason='${known.reason}'`);
    }
    if (emptyAllowlist.allowed || emptyAllowlist.reason !== "allowlist_empty") {
      return fail(
        `empty allowlist must fail closed; got allowed=${emptyAllowlist.allowed} reason='${emptyAllowlist.reason}'`,
      );
    }

    return pass(
      `unknown→denied (sender_not_allowlisted), listed→allowed (case-insensitive), empty allowlist→denied (fail-closed)`,
      { unknown: unknown.reason, known: known.reason, empty: emptyAllowlist.reason },
    );
  },
};
