import { describe, expect, it } from "vitest";

describe("mission-control module load smoke", () => {
  it("loads core pages/components without import-time failures", async () => {
    const modules = await Promise.all([
      import("./api/client"),
      import("./content/copy"),
      import("./state/ui-preferences"),
      import("./state/refresh-bus"),
      import("./hooks/useRefreshSubscription"),
      import("./pages/ChatPage"),
      import("./pages/PromptLabPage"),
      import("./pages/ImprovementPage"),
      import("./pages/TasksPage"),
      import("./pages/SettingsPage"),
      import("./pages/McpPage"),
      import("./pages/MemoryPage"),
      import("./pages/IntegrationsPage"),
      import("./pages/CronPage"),
      import("./pages/FilesPage"),
      import("./pages/CostConsolePage"),
      import("./pages/SkillsPage"),
      import("./pages/WorkspacesPage"),
      import("./components/PageGuideCard"),
      import("./components/ChatModelPicker"),
      import("./components/GlobalFreshnessPill"),
      import("./components/NotificationStack"),
      import("./components/ui"),
    ]);

    expect(modules.length).toBeGreaterThan(10);
  }, 45_000);
});
