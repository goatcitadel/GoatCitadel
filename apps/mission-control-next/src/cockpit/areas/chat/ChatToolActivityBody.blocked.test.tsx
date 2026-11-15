// @vitest-environment happy-dom
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatToolActivityBody } from "./ChatToolActivityBody";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (element: ReactElement) => act(async () => root.render(element));

function turnWith(run: Partial<ChatToolRunRecord>): ChatThreadTurnRecord {
  return {
    toolRuns: [
      {
        toolRunId: "run-1",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "fs.write",
        status: "blocked",
        startedAt: "2026-11-01T00:00:00.000Z",
        ...run,
      },
    ],
  } as unknown as ChatThreadTurnRecord;
}

const seeWhy = () =>
  Array.from(container.querySelectorAll("a")).filter((a) => a.textContent === "See why it's blocked");

describe("ChatToolActivityBody blocked tools", () => {
  it("links a tool blocked by a rule to the Capabilities tool panel", async () => {
    await render(<ChatToolActivityBody turn={turnWith({})} showTechnicalDetails={false} />);
    const links = seeWhy();
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toMatch(/^\/capabilities\/tools/u);
  });

  it("offers no link when you denied, withdrew or let the approval expire", async () => {
    for (const approvalOutcome of ["denied", "withdrawn", "expired"]) {
      await render(
        <ChatToolActivityBody turn={turnWith({ result: { approvalOutcome } })} showTechnicalDetails={false} />,
      );
      expect(seeWhy(), approvalOutcome).toHaveLength(0);
    }
  });

  it("offers no link for a tool that was not blocked", async () => {
    await render(<ChatToolActivityBody turn={turnWith({ status: "failed" })} showTechnicalDetails={false} />);
    expect(seeWhy()).toHaveLength(0);
  });
});
