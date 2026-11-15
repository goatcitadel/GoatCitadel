// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillEvaluationLink } from "./SkillEvaluationLink";

const stub = vi.hoisted(() => ({ lastProps: undefined as Record<string, unknown> | undefined }));
vi.mock("../../../ui/ClassicOwnerLink", () => ({
  ClassicOwnerLink: (props: Record<string, unknown>) => {
    stub.lastProps = props;
    return (
      <a href={String(props.href)} data-scope={String(props.scope)}>
        {String(props.label)}
      </a>
    );
  },
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  stub.lastProps = undefined;
});

function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "children" in node) return text((node as { children: unknown }).children);
  return "";
}

describe("SkillEvaluationLink", () => {
  it("names evaluation runs and links to the classic view (U-LB-005)", async () => {
    await act(async () => {
      renderer = create(<SkillEvaluationLink skillId="planner" />);
    });
    const content = text(renderer!.toJSON());
    expect(content).toContain("Evaluation");
    expect(content).toContain(
      "Evaluation runs try a skill on test scenarios, a baseline and an improvement run before you rely on it. They are only in the classic view.",
    );
    expect(stub.lastProps).toMatchObject({
      href: "/library/skills",
      label: "Run skill evaluations · classic view",
      scope: JSON.stringify(["skill-evaluation", "planner"]),
    });
  });
});
