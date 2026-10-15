import { describe, expect, it } from "vitest";
import { APPROVAL_EXPIRY_ACTOR_ID } from "@goatcitadel/contracts";
import { presentActor } from "./inbox-vocabulary";

describe("presentActor", () => {
  it("names operators only for recorded decisions and never shows the actor id", () => {
    expect(presentActor("operator-7")).toBe("An operator");
    expect(presentActor("agent-research", "event")).toBe("An agent or operator");
    expect(presentActor("system:scheduler", "event")).toBe("GoatCitadel");
    expect(presentActor(APPROVAL_EXPIRY_ACTOR_ID)).toBe("Expiry check");
    expect(presentActor(undefined, "event")).toBe("Not recorded");
  });
});
