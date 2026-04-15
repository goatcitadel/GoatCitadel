import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  createBackup: vi.fn(),
  listBackups: vi.fn(() => Promise.resolve({ items: [] })),
  verifyBackup: vi.fn(),
}));

vi.mock("../components/EmbeddedPageChrome", () => ({
  EmbeddedPageChromeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({ primary, inspector }: { primary: React.ReactNode; inspector: React.ReactNode }) => (
    <div className="operator-split-layout">
      <div className="operator-split-primary">{primary}</div>
      <div className="operator-split-inspector">{inspector}</div>
    </div>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/TuneHubLayout", () => ({
  TuneHubLayout: ({
    title,
    subtitle,
    children,
  }: {
    title: React.ReactNode;
    subtitle: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

vi.mock("./LlamaCppPage", () => ({
  LlamaCppPage: () => <div>Llama runtime</div>,
}));

vi.mock("./MeshPage", () => ({
  MeshPage: () => <div>Mesh controls</div>,
}));

vi.mock("./NpuPage", () => ({
  NpuPage: () => <div>NPU controls</div>,
}));

vi.mock("./SettingsPage", () => ({
  SettingsPage: () => <div>Runtime settings form</div>,
}));

import { RuntimeHubPage } from "./RuntimeHubPage";

describe("RuntimeHubPage", () => {
  it("keeps runtime controls ahead of backup and secondary sections", () => {
    const markup = renderToStaticMarkup(<RuntimeHubPage />);

    expect(markup).toContain("Runtime controls");
    expect(markup).toContain("Backup posture");
    expect(markup).toContain("Mesh");
    expect(markup).toContain("Local runtimes");
    expect(markup).not.toContain("Runtime posture");
    expect(markup.indexOf("Runtime controls")).toBeLessThan(markup.indexOf("Mesh"));
  });
});
