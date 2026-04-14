import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageGuideCard } from "./PageGuideCard";
import { ShellDetailPanelProvider } from "./ShellDetailPanelContext";
import { UiPreferencesProvider } from "../state/ui-preferences";

describe("PageGuideCard", () => {
  it("renders compact guide copy without an inline details button", () => {
    const markup = renderToStaticMarkup(
      <UiPreferencesProvider>
        <ShellDetailPanelProvider isOpen={false} onOpenPanel={() => {}} onClosePanel={() => {}}>
          <PageGuideCard
            pageId="tasks"
            what="Track queue state and recovery."
            when="When you need to inspect delegated execution."
            actions={["Open a task", "Review the durable run", "Update the next checkpoint"]}
          />
        </ShellDetailPanelProvider>
      </UiPreferencesProvider>,
    );

    expect(markup).toContain("Guide");
    expect(markup).toContain("Track queue state and recovery.");
    expect(markup).not.toContain("Open details");
    expect(markup).not.toContain("Hide details");
  });
});
