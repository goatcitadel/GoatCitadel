import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildBlueprintProofItems, CitadelBlueprintRoutePage } from "./CitadelBlueprintRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  exportCitadelBlueprint: vi.fn(),
  validateCitadelBlueprint: vi.fn(),
  importCitadelBlueprint: vi.fn(),
  isApiRequestError: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  exportCitadelBlueprint: apiMocks.exportCitadelBlueprint,
  validateCitadelBlueprint: apiMocks.validateCitadelBlueprint,
  importCitadelBlueprint: apiMocks.importCitadelBlueprint,
  isApiRequestError: apiMocks.isApiRequestError,
}));

function makeProps(): NativeRoutePagesProps {
  return {
    route: { area: "library", section: "citadel-blueprint", theme: "library" },
    activeWorkspaceId: "default",
    activeWorkspaceName: "Acme",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  };
}

function treeString(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function instanceText(node: ReactTestInstance | string): string {
  if (typeof node === "string") {
    return node;
  }
  return (node.children ?? []).map((child) => instanceText(child)).join(" ");
}

function buttonByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const [node] = renderer.root.findAll((n) => n.type === "button" && instanceText(n).includes(label));
  if (!node) {
    throw new Error(`No button "${label}"`);
  }
  return node;
}

describe("CitadelBlueprintRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.exportCitadelBlueprint.mockResolvedValue({ schemaVersion: "goatcitadel.blueprint.v1", name: "Acme" });
    apiMocks.validateCitadelBlueprint.mockResolvedValue({ ok: true, errors: [] });
    apiMocks.importCitadelBlueprint.mockResolvedValue({ citadelId: "default" });
    apiMocks.isApiRequestError.mockImplementation(
      (error: unknown) => typeof error === "object" && error !== null && "status" in error,
    );
  });

  it("renders the Blueprint header", () => {
    apiMocks.exportCitadelBlueprint.mockReturnValue(new Promise(() => {}));
    const markup = renderToStaticMarkup(<CitadelBlueprintRoutePage {...makeProps()} />);
    expect(markup).toContain("Blueprint");
  });

  it("shows the exported Blueprint JSON when staged", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });
    expect(apiMocks.exportCitadelBlueprint).toHaveBeenCalledWith("default");
    expect(treeString(renderer!)).toContain("goatcitadel.blueprint.v1");
    expect(treeString(renderer!)).toContain("Secret posture");
    expect(treeString(renderer!)).toContain("secret-free contract");
  });

  it("validates then imports a pasted Blueprint", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });
    await act(async () => {
      renderer!.root
        .findByType("textarea")
        .props.onChange({ target: { value: '{"schemaVersion":"goatcitadel.blueprint.v1"}' } });
    });
    await act(async () => {
      buttonByLabel(renderer!, "Validate").props.onClick();
    });
    expect(apiMocks.validateCitadelBlueprint).toHaveBeenCalledWith({ schemaVersion: "goatcitadel.blueprint.v1" });
    expect(treeString(renderer!)).toContain("Valid");

    await act(async () => {
      buttonByLabel(renderer!, "Import").props.onClick();
    });
    expect(apiMocks.importCitadelBlueprint).toHaveBeenCalledWith("default", {
      schemaVersion: "goatcitadel.blueprint.v1",
    });
  });

  it("reports a not-staged workspace as nothing to export", async () => {
    apiMocks.exportCitadelBlueprint.mockRejectedValue({ status: 404 });
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });
    expect(treeString(renderer!)).toContain("nothing to export");
  });

  it("builds export proof rows from the staged blueprint artifact", () => {
    expect(buildBlueprintProofItems('{"schemaVersion":"goatcitadel.blueprint.v1"}', "default")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Workspace", meta: "default" }),
        expect.objectContaining({ title: "Schema", meta: "goatcitadel.blueprint.v1" }),
        expect.objectContaining({ title: "Secret posture", meta: "secret-free contract" }),
      ]),
    );
  });
});
