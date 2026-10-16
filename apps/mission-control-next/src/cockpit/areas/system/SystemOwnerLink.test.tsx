// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { BACKUP_INSPECT_PATH } from "./health-overview";
it("uses actual runtime and backup owners, retaining owner context and missing owner outcomes", () => {
  const originalLocation = window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState(null, "", "/system?shell=cockpit");
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    act(() =>
      root.render(
        <>
          <SystemOwnerLink href="/settings/local-ai#local-ai" scope="w">
            Review models
          </SystemOwnerLink>
          <SystemOwnerLink href="/ops/runtime?workspaceId=w" scope="w">
            Review runtime
          </SystemOwnerLink>
          <SystemOwnerLink href="/system/runtime?workspaceId=w#ops-runtime-backups" scope="w">
            Review backups
          </SystemOwnerLink>
          <SystemOwnerLink href="/ops/runtime?shell=classic&workspaceId=w#backups" scope="w">
            Legacy runtime continuation
          </SystemOwnerLink>
          <SystemOwnerLink href="/unknown" scope="w">
            Review unknown
          </SystemOwnerLink>
        </>,
      ),
    );
    const links = [...container.querySelectorAll("a")];
    expect(links[0]?.getAttribute("href")).toContain("/settings/local-ai");
    expect(links[0]?.getAttribute("href")).toContain("shell=cockpit");
    // Legacy runtime URLs reach the unchanged full native control owner.
    expect(links[1]?.getAttribute("href")).toBe("/system/runtime?workspaceId=w&shell=cockpit");
    expect(links[1]?.textContent).toBe("Review runtime");
    expect(links[2]?.getAttribute("href")).toBe("/system/runtime?workspaceId=w&shell=cockpit#ops-runtime-backups");
    expect(links[2]?.textContent).toBe("Review backups");
    expect(BACKUP_INSPECT_PATH).toBe("/system/runtime#ops-runtime-backups");
    expect(links[3]?.getAttribute("href")).toBe("/system/runtime?shell=cockpit&workspaceId=w#backups");
    expect(links[3]?.textContent).toBe("Legacy runtime continuation");
    expect(container.textContent).toContain("This page is not available here");
  } finally {
    act(() => root.unmount());
    window.history.replaceState(null, "", originalLocation);
  }
});
