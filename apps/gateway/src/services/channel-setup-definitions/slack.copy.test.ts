import { describe, expect, it } from "vitest";
import * as slackModule from "./slack.js";

describe("Slack setup copy", () => {
  it("does not promise a hosted GoatCitadel Slack app", () => {
    // The copy lives inside the definition builder, so build the definition and
    // stringify whatever each export returns (functions are called, data is kept).
    const built = Object.values(slackModule).map((exported) =>
      typeof exported === "function" ? (exported as () => unknown)() : exported,
    );
    const text = JSON.stringify(built);

    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain("hosted GoatCitadel");
    expect(text).not.toContain("GoatCitadel Slack app");
    expect(text).not.toContain("Hosted Slack");
    expect(text).toContain("your Slack app");
  });
});
