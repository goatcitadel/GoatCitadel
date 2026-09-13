import { describe, expect, it, vi } from "vitest";
import { ConflictError, type PersonalityCatalogResponse } from "@goatcitadel/contracts";
import { listChatCommandCatalog, parseChatCommand, type ChatCommandDependencies } from "./chat-command-service.js";

const catalog: PersonalityCatalogResponse = {
  revision: "a".repeat(64),
  defaultPersonalityId: "operator",
  items: [
    {
      id: "default",
      label: "Default",
      category: "core",
      description: "No personality overlay.",
      tone: "",
      style: "",
      systemOverlay: "",
      soulFile: "docs/personalities/core/default.md",
      safetyNotes: ["Tone only."],
      visibility: "builtin",
      builtin: true,
      editable: false,
      modified: false,
    },
    {
      id: "operator",
      label: "Operator",
      category: "core",
      description: "Crisp mission-control style.",
      tone: "Composed",
      style: "Operational",
      systemOverlay: "Use crisp language.",
      soulFile: "docs/personalities/core/operator.md",
      safetyNotes: ["Tone only."],
      visibility: "builtin",
      builtin: true,
      editable: true,
      modified: false,
    },
  ],
};

function createDeps(defaultPersonalityId = "operator"): ChatCommandDependencies {
  const currentCatalog = { ...catalog, defaultPersonalityId };
  return {
    getSession: vi.fn(async () => ({ sessionId: "session-1" })),
    getPersonalityCatalog: vi.fn(async () => currentCatalog),
    setDefaultPersonality: vi.fn(async (id: string) => ({
      ...catalog,
      defaultPersonalityId: id,
    })),
  } as unknown as ChatCommandDependencies;
}

describe("chat personality command", () => {
  it("is listed in the command catalog and /help", async () => {
    expect(listChatCommandCatalog().some((item) => item.command === "/personality")).toBe(true);

    const result = await parseChatCommand(createDeps(), "session-1", "/help");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("/personality [id|none]");
  });

  it("lists the current default and available personalities", async () => {
    const result = await parseChatCommand(createDeps(), "session-1", "/personality");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Current Chat personality: Operator (operator).");
    expect(result.message).toContain("- default: No personality overlay.");
    expect(result.message).toContain("- operator: Crisp mission-control style.");
  });

  it("sets and clears the global Chat personality default", async () => {
    const deps = createDeps();

    let result = await parseChatCommand(deps, "session-1", "/personality operator");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Chat personality set to Operator (operator).");
    expect(deps.setDefaultPersonality).toHaveBeenCalledWith("operator", catalog.revision);

    result = await parseChatCommand(deps, "session-1", "/personality none");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Chat personality cleared.");
    expect(deps.setDefaultPersonality).toHaveBeenCalledWith("default", catalog.revision);
  });

  it("rejects unknown personality ids", async () => {
    const deps = createDeps();

    const result = await parseChatCommand(deps, "session-1", "/personality not-real");

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unknown personality "not-real"');
    expect(deps.setDefaultPersonality).not.toHaveBeenCalled();
  });

  it("does not refresh and retry a default command after its catalog revision conflicts", async () => {
    const deps = createDeps();
    vi.mocked(deps.setDefaultPersonality).mockRejectedValue(new ConflictError({ code: "WRITE_CONFLICT", message: "Catalog changed" }));
    await expect(parseChatCommand(deps, "session-1", "/personality teacher")).resolves.toMatchObject({ ok: false });
    await expect(parseChatCommand(deps, "session-1", "/personality operator")).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(deps.setDefaultPersonality).toHaveBeenCalledExactlyOnceWith("operator", catalog.revision);
  });
});
