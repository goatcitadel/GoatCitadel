import { expect, it } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { requesterMatchesPlanOrigin } from "./candidate-approval-continuation";

const plan = (actorId: string) => ({ origin: { workspaceId: "ws-origin", actorId } }) as unknown as ChangePlanRecord;
const linked = { linkage: { workspaceId: "ws-origin" } };

it("compares unredacted requesters exactly", () => {
  expect(requesterMatchesPlanOrigin(plan("basic:operator"), {}, "basic:operator")).toBe(true);
  expect(requesterMatchesPlanOrigin(plan("basic:operator"), linked, "basic:other")).toBe(false);
});

it("accepts a token requester only under the Gateway's public redaction and origin linkage", () => {
  // Literal value the Gateway approval replay returned for a token actor (public projection).
  const masked = "token:[REDACTED]";
  expect(requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), linked, masked)).toBe(true);
  expect(requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), {}, masked)).toBe(false);
  expect(
    requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), { linkage: { workspaceId: "ws-other" } }, masked),
  ).toBe(false);
  // A masked value never stands in for an origin the redactor would not mask.
  expect(requesterMatchesPlanOrigin(plan("basic:operator"), linked, masked)).toBe(false);
  expect(requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), linked, "token:ffffffffffffffff")).toBe(false);
});
