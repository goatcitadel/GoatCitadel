// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { DocumentPatchProposalRecord } from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { expect, it } from "vitest";
import { DocumentLibraryLink } from "./DocumentProposalTarget";

const proposal = {
  proposalId: "proposal-a",
  workspaceId: "default",
  targetKind: "personal_note",
} as DocumentPatchProposalRecord;

it("the Open notes link is at least 24 px tall in any density (U-IN-005)", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <UiPreferencesProvider>
        <DocumentLibraryLink proposal={proposal} />
      </UiPreferencesProvider>,
    );
  });
  try {
    const link = [...container.querySelectorAll("a")].find((entry) => entry.textContent === "Open notes")!;
    expect(link.className).toContain("cockpit-target");
    expect(link.className).not.toMatch(/(^|\s)min-h-6(\s|$)/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
