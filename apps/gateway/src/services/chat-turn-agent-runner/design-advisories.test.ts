import { describe, expect, it } from "vitest";
import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import { buildToolResultDesignAdvisories, hasDesignSkillReceipt } from "./design-advisories.js";

function profileWith(skillIds: string[]): ChatTurnCapabilityProfileRecord {
  return {
    selection: {
      activatedSkills: skillIds.map((skillId) => ({
        capabilityId: `skill:${skillId}`,
        skillId,
        confidence: 0.9,
        reasons: ["routing_keyword"],
        treeSha256: "tree",
        instructionSha256: "instruction",
        instructionBytes: 10,
        modules: [{ name: "main", relativePath: "SKILL.md", sha256: "abc", bytes: 10 }],
      })),
    },
  } as unknown as ChatTurnCapabilityProfileRecord;
}

const GRADIENT_CSS = ".hero h1 { background-clip: text; -webkit-text-fill-color: transparent; }";

describe("hasDesignSkillReceipt", () => {
  it("recognises impeccable and design-intelligence receipts only", () => {
    expect(hasDesignSkillReceipt(profileWith(["bundled:impeccable"]))).toBe(true);
    expect(hasDesignSkillReceipt(profileWith(["bundled:design-intelligence"]))).toBe(true);
    expect(hasDesignSkillReceipt(profileWith(["bundled:coding"]))).toBe(false);
    expect(hasDesignSkillReceipt(profileWith([]))).toBe(false);
    expect(hasDesignSkillReceipt(undefined)).toBe(false);
  });
});

describe("buildToolResultDesignAdvisories", () => {
  it("scans the written content of a UI file when the turn carries a design receipt", () => {
    const advisories = buildToolResultDesignAdvisories({
      capabilityProfile: profileWith(["bundled:impeccable"]),
      toolName: "fs.write",
      args: { path: "src/hero.css", content: GRADIENT_CSS },
    });

    expect(advisories?.map((advisory) => advisory.ruleId)).toEqual(["gradient-text"]);
    expect(advisories?.[0]).toMatchObject({ line: 1, craftFloorRule: "skill-ban-gradient-text" });
  });

  it("scans model-authored html handed to documents.create under a design receipt", () => {
    const html = `<!doctype html><html><head><style>${GRADIENT_CSS}</style></head><body></body></html>`;
    const advisories = buildToolResultDesignAdvisories({
      capabilityProfile: profileWith(["bundled:impeccable"]),
      toolName: "documents.create",
      args: { path: "./workspace/out/page.html", format: "html", title: "Page", html },
    });

    expect(advisories).toEqual([expect.objectContaining({ ruleId: "gradient-text", line: 1, scope: "file" })]);
    expect(
      buildToolResultDesignAdvisories({
        capabilityProfile: profileWith(["bundled:impeccable"]),
        toolName: "documents.create",
        args: { path: "./workspace/out/page.html", format: "html", title: "Page", body: GRADIENT_CSS },
      }),
    ).toBeUndefined();
  });

  it("returns nothing without a design receipt, for non-UI files, or for other tools", () => {
    const args = { path: "src/hero.css", content: GRADIENT_CSS };

    expect(
      buildToolResultDesignAdvisories({ capabilityProfile: undefined, toolName: "fs.write", args }),
    ).toBeUndefined();
    expect(
      buildToolResultDesignAdvisories({
        capabilityProfile: profileWith(["bundled:coding"]),
        toolName: "fs.write",
        args,
      }),
    ).toBeUndefined();
    expect(
      buildToolResultDesignAdvisories({
        capabilityProfile: profileWith(["bundled:impeccable"]),
        toolName: "fs.write",
        args: { path: "src/hero.ts", content: GRADIENT_CSS },
      }),
    ).toBeUndefined();
    expect(
      buildToolResultDesignAdvisories({
        capabilityProfile: profileWith(["bundled:impeccable"]),
        toolName: "fs.read",
        args,
      }),
    ).toBeUndefined();
    expect(
      buildToolResultDesignAdvisories({
        capabilityProfile: profileWith(["bundled:impeccable"]),
        toolName: "fs.write",
        args: { path: "src/clean.css", content: ".panel { padding: 16px; }" },
      }),
    ).toBeUndefined();
  });

  it("scans only the new text of a patch and accepts every UI extension", () => {
    const patched = buildToolResultDesignAdvisories({
      capabilityProfile: profileWith(["bundled:impeccable"]),
      toolName: "fs.patch",
      args: {
        path: "src/App.tsx",
        expectedSha256: "a".repeat(64),
        oldText: '<p className="eyebrow">Old</p>',
        newText: '<div className="backdrop-blur-md">New</div>',
      },
    });
    expect(patched?.map((advisory) => advisory.ruleId)).toEqual(["glass-by-default"]);
    // A patch's line counts within the replacement text, not the file; the advisory says so.
    expect(patched?.[0]).toMatchObject({ line: 1, scope: "patch" });
    expect(
      buildToolResultDesignAdvisories({
        capabilityProfile: profileWith(["bundled:impeccable"]),
        toolName: "fs.write",
        args: { path: "src/hero.css", content: GRADIENT_CSS },
      })?.[0],
    ).toMatchObject({ scope: "file" });

    for (const extension of ["tsx", "jsx", "css", "html", "vue", "svelte"]) {
      expect(
        buildToolResultDesignAdvisories({
          capabilityProfile: profileWith(["bundled:impeccable"]),
          toolName: "fs.write",
          args: { path: `src/page.${extension}`, content: GRADIENT_CSS },
        }),
      ).toHaveLength(1);
    }
  });

  it("never echoes the written content", () => {
    const secret = "sk-live-SECRET-9";
    const advisories = buildToolResultDesignAdvisories({
      capabilityProfile: profileWith(["bundled:impeccable"]),
      toolName: "fs.write",
      args: { path: "src/hero.css", content: `${GRADIENT_CSS} /* ${secret} */` },
    });

    expect(JSON.stringify(advisories)).not.toContain(secret);
  });
});
