import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import { resolveWorkspaceDesignBrand } from "./workspace-design-brand.js";

const DESIGN_DOC = "# Design\n\n```brand\nname: Acme\ncolors: #0ea5e9, #0f172a\nfonts: Inter\n```\n";

// The frozen receipt records the full stored document exactly as the governed render hashes it.
function receiptFor(content: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

function profileWith(
  contextDocuments?: Array<{ docType: "product" | "design" }>,
  frozenContent = DESIGN_DOC,
): ChatTurnCapabilityProfileRecord {
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
                  ...receiptFor(frozenContent),
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

  it("does not brand from a DESIGN.md that changed after the profile froze", () => {
    const edited = DESIGN_DOC.replace("#0ea5e9", "#ff0000");
    const read = vi.fn(() => ({ exists: true, content: edited }));

    expect(resolveWorkspaceDesignBrand(profileWith([{ docType: "design" }], DESIGN_DOC), read)).toBeUndefined();
    expect(read).toHaveBeenCalledWith("design");
  });

  it("returns undefined when DESIGN.md has no brand block or is missing", () => {
    // Freeze the same prose document so this exercises the missing brand block, not hash drift.
    const proseOnly = "# Design\n\nProse only.\n";
    expect(
      resolveWorkspaceDesignBrand(profileWith([{ docType: "design" }], proseOnly), () => ({
        exists: true,
        content: proseOnly,
      })),
    ).toBeUndefined();
    expect(
      resolveWorkspaceDesignBrand(profileWith([{ docType: "design" }]), () => ({ exists: false, content: "" })),
    ).toBeUndefined();
  });
});
