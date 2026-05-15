import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../components/ConfigureHubLayout", () => ({
  ConfigureHubLayout: ({
    title,
    subtitle,
    summaries,
    children,
  }: {
    title: React.ReactNode;
    subtitle: React.ReactNode;
    summaries?: Array<{ label: React.ReactNode; value: React.ReactNode; note?: React.ReactNode }>;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      <div>
        {summaries?.map((summary) => (
          <article key={String(summary.label)}>
            <strong>{summary.label}</strong>
            <span>{summary.value}</span>
            {summary.note ? <p>{summary.note}</p> : null}
          </article>
        ))}
      </div>
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

import { createBackup, listBackups, verifyBackup } from "../api/client";
import { RuntimeHubPage } from "./RuntimeHubPage";

const listBackupsMock = vi.mocked(listBackups);
const createBackupMock = vi.mocked(createBackup);
const verifyBackupMock = vi.mocked(verifyBackup);

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => instanceText(button).includes(label));
}

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("RuntimeHubPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBackupsMock.mockResolvedValue({ items: [] });
    createBackupMock.mockResolvedValue({
      backupId: "backup-created",
      outputPath: "C:\\GoatCitadel\\backups\\backup-created.json",
    } as any);
    verifyBackupMock.mockResolvedValue({
      backupId: "backup-created",
      verified: true,
      contractVerified: true,
      filesVerified: 3,
      contractCoverage: { reasons: [] },
      issues: [],
    } as any);
  });

  it("keeps runtime controls ahead of backup and secondary sections", () => {
    const markup = renderToStaticMarkup(<RuntimeHubPage />);

    expect(markup).toContain("Runtime controls");
    expect(markup).toContain("Backup posture");
    expect(markup).toContain("Mesh");
    expect(markup).toContain("Local runtimes");
    expect(markup).not.toContain("Runtime posture");
    expect(markup.indexOf("Runtime controls")).toBeLessThan(markup.indexOf("Mesh"));
  });

  it("loads backup posture and renders the restore command for a selected manifest", async () => {
    listBackupsMock.mockResolvedValueOnce({
      items: [
        {
          backupId: "backup-latest",
          createdAt: "2026-05-14T15:00:00.000Z",
          files: [{ path: "settings.json" }, { path: "memory.db" }],
        },
      ],
    } as any);

    const renderer = create(<RuntimeHubPage />);
    await flush();

    const text = rendererText(renderer);
    expect(text).toContain("Backup history loaded");
    expect(text).toContain("backup-latest");
    expect(text).toContain("2 files");
    expect(text).toContain("Recoverable");

    const pathInput = renderer.root.findAllByType("input").find((input) => !input.props.readOnly);
    act(() => {
      pathInput?.props.onChange({ target: { value: "D:\\backups\\manual.json" } });
    });

    expect(renderer.root.findAllByType("input").find((input) => input.props.readOnly)?.props.value).toContain(
      'pnpm admin backup restore --file "D:\\backups\\manual.json" --confirm',
    );

    renderer.unmount();
  });

  it("creates and verifies backups while surfacing success and contract warnings", async () => {
    listBackupsMock.mockResolvedValue({ items: [] } as any);
    createBackupMock.mockResolvedValueOnce({
      backupId: "backup-created",
      outputPath: "C:\\GoatCitadel\\backups\\backup-created.json",
    } as any);
    verifyBackupMock.mockResolvedValueOnce({
      backupId: "backup-created",
      verified: true,
      contractVerified: false,
      filesVerified: 3,
      contractCoverage: { reasons: ["missing memory export", "missing settings copy"] },
      issues: [],
    } as any);

    const renderer = create(<RuntimeHubPage />);
    await flush();

    await act(async () => {
      await findButton(renderer, "Create backup")?.props.onClick();
    });
    await flush();

    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(rendererText(renderer)).toContain(
      "Created backup backup-created at C:\\GoatCitadel\\backups\\backup-created.json.",
    );

    await act(async () => {
      await findButton(renderer, "Verify backup")?.props.onClick();
    });
    await flush();

    expect(verifyBackupMock).toHaveBeenCalledWith("C:\\GoatCitadel\\backups\\backup-created.json");
    expect(rendererText(renderer)).toContain(
      "Backup integrity is valid, but 1.0 contract coverage is incomplete: missing memory export, missing settings copy.",
    );

    renderer.unmount();
  });

  it("surfaces load and verification failures without hiding runtime controls", async () => {
    listBackupsMock.mockRejectedValueOnce(new Error("backup index unavailable"));
    verifyBackupMock.mockRejectedValueOnce(new Error("manifest corrupted"));

    const renderer = create(<RuntimeHubPage />);
    await flush();

    expect(rendererText(renderer)).toContain("backup index unavailable");

    const pathInput = renderer.root.findAllByType("input").find((input) => !input.props.readOnly);
    act(() => {
      pathInput?.props.onChange({ target: { value: "D:\\backups\\bad.json" } });
    });
    await act(async () => {
      await findButton(renderer, "Verify backup")?.props.onClick();
    });
    await flush();

    expect(rendererText(renderer)).toContain("manifest corrupted");
    expect(rendererText(renderer)).toContain("Runtime controls");

    renderer.unmount();
  });
});
