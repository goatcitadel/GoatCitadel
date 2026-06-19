// TRUST: a deny Ward blocks a tool action even when allow Wards also match.
//
// Exercises the SHIPPED deny-wins precedence in packages/contracts (evaluateWards,
// citadel-wards.ts:31-46). A black-box competitor has no equivalent contract, so
// this scenario is marked in-process for GoatCitadel and skipped for competitors
// unless they expose the same decision over HTTP (they don't today).

import { pass, fail, skip } from "../lib/harness.mjs";
import { importGoatCitadel } from "../lib/goatcitadel-modules.mjs";

export default {
  id: "trust.deny-wins-ward",
  axis: "TRUST",
  title: "Deny-wins: a deny Ward beats overlapping allow Wards",
  description:
    "Given Wards that both allow and deny the same action pattern, the resolved effect is 'deny'. " +
    "Proves the policy layer fails closed on conflict rather than last-write-wins.",
  requiresEdges: [],
  mode: "in-process",

  async run(target) {
    if (target.kind === "competitor") {
      return skip(`${target.id} exposes no Ward decision API; deny-wins is a GoatCitadel contract`);
    }
    if (!target.distReady) {
      return skip(target.skipReason ?? "goatcitadel dist not built");
    }

    const { evaluateWards } = await importGoatCitadel("contracts/citadel-wards");

    const wards = [
      { name: "allow-shell", actionPattern: "shell.*", effect: "allow" },
      { name: "deny-rm", actionPattern: "shell.exec", effect: "deny" },
      { name: "approve-net", actionPattern: "shell.exec", effect: "require_approval" },
    ];

    const denied = evaluateWards(wards, "shell.exec");
    const unrelated = evaluateWards(wards, "memory.read");

    if (denied !== "deny") {
      return fail(`expected effect 'deny' for conflicting Wards, got '${denied}'`, { wards });
    }
    if (unrelated !== "allow") {
      return fail(`expected 'allow' for an unmatched action, got '${unrelated}'`);
    }
    return pass(`evaluateWards → '${denied}' for shell.exec (deny beat allow + require_approval); unmatched action → 'allow'`, {
      decision: denied,
      unmatched: unrelated,
    });
  },
};
