import { renderToStaticMarkup } from "react-dom/server";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { describe, expect, it } from "vitest";
import { ChatRunCard, isPlanOnly } from "./ChatRunCard";

describe("ChatRunCard", () => {
  it("does not pair an older delegation with the latest turn's durable link", () => {
    const props = {
      delegationRun: {
        attachedTurnId: "older-turn",
        label: "Older delegation",
        objective: "Older work",
        status: "running",
        steps: [],
      },
    } as unknown as MissionThreadedActiveSessionSurfaceProps;
    const markup = renderToStaticMarkup(
      <ChatRunCard props={props} turnId="latest-turn" durableRunId="durable-latest" />,
    );
    expect(markup).toContain("Background run");
    expect(markup).toContain("/work/runs/durable-latest");
    expect(markup).not.toContain("Older delegation");
  });

  const runWith = (statuses: string[]) =>
    ({
      delegationRun: {
        label: "Plan",
        objective: "Plan three steps",
        status: "completed",
        steps: statuses.map((status, index) => ({ stepId: "s" + index, status, role: "worker" })),
      },
    }) as unknown as MissionThreadedActiveSessionSurfaceProps;

  it("shows a completed run whose steps all stayed queued as a plan only, with no link into Work", () => {
    const markup = renderToStaticMarkup(
      <ChatRunCard props={runWith(["pending", "pending", "pending", "pending"])} durableRunId="durable-1" />,
    );
    expect(markup).toContain("Supervised work · Plan only");
    expect(markup).toContain("Plan written; none of its 4 steps ran.");
    expect(markup).not.toContain("Open run in Work");
    expect(markup).not.toContain("Done");
    expect(markup).not.toContain("0 of 4 steps done");
  });

  it("still counts finished steps for a completed run that did work", () => {
    const markup = renderToStaticMarkup(
      <ChatRunCard props={runWith(["completed", "pending"])} durableRunId="durable-1" />,
    );
    expect(markup).toContain("1 of 2 steps done");
    expect(markup).toContain("Open run in Work");
    expect(markup).not.toContain("Plan only");
  });

  it("calls only a completed run with every step queued a plan only", () => {
    expect(isPlanOnly({ status: "completed", steps: [{ status: "pending" }] })).toBe(true);
    expect(isPlanOnly({ status: "completed", steps: [] })).toBe(false);
    expect(isPlanOnly({ status: "running", steps: [{ status: "pending" }] })).toBe(false);
    expect(isPlanOnly({ status: "failed", steps: [{ status: "pending" }] })).toBe(false);
    expect(isPlanOnly({ status: "completed", steps: [{ status: "pending" }, { status: "skipped" }] })).toBe(false);
  });
});
