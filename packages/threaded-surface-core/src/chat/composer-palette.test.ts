import { describe, expect, it, vi } from "vitest";
import {
  ComposerPaletteSourceRegistry,
  createUrlPaletteItem,
  detectComposerPaletteTrigger,
  rankComposerPaletteItems,
  type ComposerPaletteItem,
} from "./composer-palette";

function item(source: ComposerPaletteItem["source"], key: string, command = key): ComposerPaletteItem {
  return {
    key,
    command,
    description: `${source} item`,
    applyValue: command,
    source,
    sourceLabel: source,
    availabilityLabel: "Available",
    action: { type: "insert_command", value: command },
  };
}

describe("composer palette", () => {
  it("recognizes slash, contextual, and compatibility skill triggers", () => {
    expect(detectComposerPaletteTrigger(" /mod")).toEqual({ mode: "commands", query: "mod" });
    expect(detectComposerPaletteTrigger("read @project")).toEqual({ mode: "context", query: "project" });
    expect(detectComposerPaletteTrigger("use $review")).toEqual({ mode: "skills", query: "review" });
    expect(detectComposerPaletteTrigger("plain message")).toBeNull();
  });

  it("prioritizes the active trigger family while searching every source", () => {
    const items = [item("commands", "review-command", "/review"), item("skills", "review-skill", "$review")];
    expect(rankComposerPaletteItems(items, "commands", "review").map((entry) => entry.source)).toEqual([
      "commands",
      "skills",
    ]);
    expect(rankComposerPaletteItems(items, "skills", "review").map((entry) => entry.source)).toEqual([
      "skills",
      "commands",
    ]);
  });

  it("ranks name matches before description matches and ignores the trigger character", () => {
    const entry = (key: string, command: string, description: string): ComposerPaletteItem => ({
      ...item("commands", key, command),
      description,
    });
    const items = [
      entry("plan", "/plan", "Show or set advisory planning mode, then hold for approval."),
      entry("new", "/new", "Start a fresh session. Keeps the help text short."),
      entry("model", "/model", "Override provider/model for this session."),
      entry("help", "/help", "Show the commands you can use."),
      entry("shell", "/shell", "Run one governed command."),
    ];
    expect(rankComposerPaletteItems(items, "commands", "he").map((entry) => entry.key)).toEqual([
      "help",
      "shell",
      "plan",
      "new",
    ]);
    expect(rankComposerPaletteItems(items, "commands", "pla").map((entry) => entry.key)[0]).toBe("plan");
  });

  it("ignores the availability label and lists a repeated command once", () => {
    const first = { ...item("commands", "skill-list", "/skill"), applyValue: "/skill", description: "List skills." };
    const second = { ...item("commands", "skill-enable", "/skill"), applyValue: "/skill", description: "Enable one." };
    expect(rankComposerPaletteItems([first, second], "commands", "").map((entry) => entry.key)).toEqual(["skill-list"]);
    expect(rankComposerPaletteItems([first], "commands", "availab")).toEqual([]);
  });

  it("degrades failed sources independently and caches successful loads per session", async () => {
    const loadCommands = vi.fn(() => [item("commands", "status", "/status")]);
    const loadFiles = vi.fn(() => Promise.reject(new Error("files offline")));
    const registry = new ComposerPaletteSourceRegistry([
      { id: "commands", label: "Commands", load: loadCommands },
      { id: "files", label: "Files", load: loadFiles },
    ]);

    const input = { sessionKey: "session-1", workspaceId: "workspace-1", mode: "all" as const, query: "" };
    const first = await registry.search(input);
    const second = await registry.search(input);

    expect(first.items.map((entry) => entry.key)).toEqual(["status"]);
    expect(first.failures).toEqual([{ source: "files", sourceLabel: "Files", message: "files offline" }]);
    expect(second.items).toHaveLength(1);
    expect(loadCommands).toHaveBeenCalledTimes(1);
    expect(loadFiles).toHaveBeenCalledTimes(2);
  });

  it("accepts only absolute HTTP(S) URL attachment candidates", () => {
    expect(createUrlPaletteItem("https://example.test/docs")?.action).toEqual({
      type: "attach_url",
      url: "https://example.test/docs",
    });
    expect(createUrlPaletteItem("file:///secret.txt")).toBeNull();
    expect(createUrlPaletteItem("example.test/docs")).toBeNull();
  });
});
