import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { PluginPieceList, type ShownPiece } from "./PluginPieceList";

const LEFT_OVER: ShownPiece = {
  pieceId: "notes",
  kind: "skill",
  label: "meeting-notes",
  asksFirst: "Adds a skill.",
  skillSnapshotId: "check-1",
  check: {
    status: "blocked",
    code: "SOURCE_ALREADY_INSTALLED",
    message:
      "This skill was left behind by an earlier install and was never switched on. Remove it here, then this plugin can be installed.",
    removableSkillId: "extra:meeting-notes",
  },
};

function render(pieces: ShownPiece[], leftover?: { workspaceId: string }) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <PluginPieceList pieces={pieces} {...(leftover ? { leftover } : {})} />
    </QueryClientProvider>,
  );
}

describe("PluginPieceList", () => {
  it("offers Remove skill beside a left-over the check names, in the check's place", () => {
    const html = render([LEFT_OVER], { workspaceId: "ws-1" });
    expect(html).toContain("Remove it here, then this plugin can be installed.");
    expect(html).toContain("Remove skill");
  });

  it("offers nothing where no removal is passed in, or for a blocked piece the check doesn't name", () => {
    expect(render([LEFT_OVER])).not.toContain("Remove skill");
    const other: ShownPiece = {
      ...LEFT_OVER,
      check: {
        status: "blocked",
        code: "RUNTIME_ALREADY_EXISTS",
        message: "A skill with this name is already installed.",
      },
    };
    expect(render([other], { workspaceId: "ws-1" })).not.toContain("Remove skill");
  });
});
