import { describe, expect, it, vi } from "vitest";
import { buildChatComposerPaletteSources } from "./useChatComposerPaletteController";

describe("chat composer palette sources", () => {
  it("exposes only active presets, callable skills, active projects, and workspace-scoped files", async () => {
    const loadFiles = vi.fn(async () => ({
      items: [{ relativePath: "docs/brief.md", size: 2048, modifiedAt: "2026-07-27T12:00:00.000Z" }],
    }));
    const sources = buildChatComposerPaletteSources({
      commandCatalog: [],
      inlineCommandSuggestions: [],
      providerOptions: [],
      agents: [
        {
          agentId: "active-preset",
          lifecycleStatus: "active",
          status: "active",
          name: "Researcher",
          title: "Researcher",
          summary: "Finds evidence",
          aliases: [],
          specialties: [],
          presetDefaults: { presetLabel: "Research" },
        },
        {
          agentId: "archived-preset",
          lifecycleStatus: "archived",
          status: "idle",
          name: "Archived",
          title: "Archived",
          summary: "Unavailable",
          aliases: [],
          specialties: [],
          presetDefaults: { presetLabel: "Archived" },
        },
      ] as never,
      installedSkills: [
        { skillId: "callable", name: "Callable", state: "enabled", callable: true, tags: [], keywords: [] },
        { skillId: "candidate", name: "Candidate", state: "enabled", callable: false, tags: [], keywords: [] },
      ] as never,
      projects: [
        { projectId: "active", name: "Active", lifecycleStatus: "active", workspacePath: "workspace/active" },
        { projectId: "archived", name: "Archived", lifecycleStatus: "archived", workspacePath: "workspace/old" },
      ] as never,
      knowledgeAttachments: [],
      externalSourcesAvailable: false,
      typedRunVariablesEnabled: false,
      loadFiles: loadFiles as never,
    });
    const context = { sessionKey: "session-1", workspaceId: "workspace-1" };

    const agents = await sources.find((source) => source.id === "agents")!.load(context);
    const skills = await sources.find((source) => source.id === "skills")!.load(context);
    const projects = await sources.find((source) => source.id === "projects")!.load(context);
    const files = await sources.find((source) => source.id === "files")!.load(context);

    expect(agents.map((item) => item.key)).toEqual(["agent-active-preset"]);
    expect(skills.map((item) => item.key)).toEqual(["skill-callable"]);
    expect(projects.map((item) => item.key)).toEqual(["project-active"]);
    expect(files.map((item) => item.key)).toEqual(["file-docs/brief.md"]);
    expect(loadFiles).toHaveBeenCalledWith(".", 250, { workspaceId: "workspace-1" });
  });
});
