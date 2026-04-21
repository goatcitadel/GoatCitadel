import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShellStatusCenter } from "./ShellStatusCenter";

describe("ShellStatusCenter", () => {
  it("only renders actionable entries as buttons", () => {
    const markup = renderToStaticMarkup(
      <ShellStatusCenter
        expanded
        onToggle={() => undefined}
        onEntryAction={() => undefined}
        summary={{
          tone: "success",
          label: "Decisions clear",
          note: "Gateway reachability and access checks passed.",
          approvalCount: 0,
          sections: [
            {
              id: "runtime",
              title: "Runtime and routing",
              summary: "No runtime",
              entries: [
                {
                  id: "runtime-posture",
                  label: "Runtime posture",
                  value: "No runtime",
                  note: "Provider routing pending",
                  tone: "muted",
                },
                {
                  id: "approvals",
                  label: "Approvals",
                  value: "Approvals clear",
                  note: "No approvals are waiting for operator action.",
                  tone: "success",
                  actionLabel: "Open queue",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(markup).toContain('class="shell-status-entry-card"');
    expect(markup).toContain('class="shell-status-entry-card interactive"');
  });
});
