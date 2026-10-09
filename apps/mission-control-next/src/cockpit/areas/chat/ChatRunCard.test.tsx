import { renderToStaticMarkup } from "react-dom/server";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { describe, expect, it } from "vitest";
import { ChatRunCard } from "./ChatRunCard";

describe("ChatRunCard", () => {
  it("does not pair an older delegation with the latest turn's durable link", () => {
    const props = { delegationRun: { attachedTurnId: "older-turn", label: "Older delegation", objective: "Older work", status: "running", steps: [] } } as unknown as MissionThreadedActiveSessionSurfaceProps;
    const markup = renderToStaticMarkup(<ChatRunCard props={props} turnId="latest-turn" durableRunId="durable-latest" />);
    expect(markup).toContain("Background run");
    expect(markup).toContain("/work/runs/durable-latest");
    expect(markup).not.toContain("Older delegation");
  });
});
