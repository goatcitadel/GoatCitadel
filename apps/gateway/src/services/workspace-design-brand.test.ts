import { describe, expect, it, vi } from "vitest";
import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import { resolveWorkspaceDesignBrand } from "./workspace-design-brand.js";

const DESIGN_DOC = "# Design\n\n```brand\nname: Acme\ncolors: #0ea5e9, #0f172a\nfonts: Inter\n```\n";

function profileWith(contextDocuments?: Array<{ docType: "product" | "design" }>): ChatTurnCapabilityProfileRecord {
  return {
    selection: {
      activatedSkills: [
        {
          capabilityId: "skill:bundled:impeccable",
          skillId: "bundled:impeccable",
          confidence: 0.93,
          reasons: ["routing_keyword"],
          treeSha256: "tree",
          instructionSha256: "instruction",
          instructionBytes: 10,
          modules: [{ name: "main", relativePath: "SKILL.md", sha256: "abc", bytes: 10 }],
          ...(contextDocuments
            ? {
                contextDocuments: contextDocuments.map((doc) => ({
                  ...doc,
                  scope: "workspace" as const,
                  sha256: "doc",
                  bytes: 10,
                  truncated: false,
                })),
              }
            : {}),
        },
      ],
    },
  } as unknown as ChatTurnCapabilityProfileRecord;
}

describe("resolveWorkspaceDesignBrand", () => {
  it("returns the DESIGN.md brand block when the frozen profile injected the design context", () => {
    const read = vi.fn(() => ({ exists: true, content: DESIGN_DOC }));

    expect(resolveWorkspaceDesignBrand(profileWith([{ docType: "design" }]), read)).toEqual({
      name: "Acme",
      colors: ["#0ea5e9", "#0f172a"],
      fonts: ["Inter"],
    });
    expect(read).toHaveBeenCalledWith("design");
  });

  it("reads nothing when the profile injected no design context", () => {
    const read = vi.fn(() => ({ exists: true, content: DESIGN_DOC }));

    expect(resolveWorkspaceDesignBrand(profileWith(), read)).toBeUndefined();
    expect(resolveWorkspaceDesignBrand(profileWith([{ docType: "product" }]), read)).toBeUndefined();
    expect(resolveWorkspaceDesignBrand(undefined, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("returns undefined when DESIGN.md has no brand block or is missing", () => {
    expect(
      resolveWorkspaceDesignBrand(profileWith([{ docType: "design" }]), () => ({
        exists: true,
        content: "# Design\n\nProse only.\n",
      })),
    ).toBeUndefined();
    expect(
      resolveWorkspaceDesignBrand(profileWith([{ docType: "design" }]), () => ({ exists: false, content: "" })),
    ).toBeUndefined();
  });
});
