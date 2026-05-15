import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { GCEmptyState } from "./GCEmptyState";

describe("GCEmptyState loop 26 tails", () => {
  it("renders its compact default with subtitle/action aliases", () => {
    const tree = create(
      <GCEmptyState title="No runs" subtitle="Start a run to see progress." action={<button>Start</button>} />,
    ).toJSON();

    expect(tree).toMatchObject({
      type: "section",
      props: {
        className: expect.stringContaining("gc-empty-state-compact"),
      },
    });
    expect(JSON.stringify(tree)).toContain("Start a run to see progress.");
    expect(JSON.stringify(tree)).toContain("gc-empty-primary-action");
  });

  it("renders explicit non-compact icon, secondary action, meta, and custom class branches", () => {
    const tree = create(
      <GCEmptyState
        title="No approvals"
        description="Nothing needs review."
        compact={false}
        className="approval-empty"
        icon={<span>!</span>}
        primaryAction={<button>Refresh</button>}
        secondaryAction={<button>Open inbox</button>}
        meta={<span>0 pending</span>}
      />,
    ).toJSON();

    const serialized = JSON.stringify(tree);
    expect(tree).toMatchObject({
      type: "section",
      props: {
        className: expect.not.stringContaining("gc-empty-state-compact"),
      },
    });
    expect(serialized).toContain("approval-empty");
    expect(serialized).toContain("gc-empty-icon");
    expect(serialized).toContain("gc-empty-secondary-action");
    expect(serialized).toContain("gc-empty-meta");
  });

  it("omits optional copy and action wrappers when no optional content exists", () => {
    const serialized = JSON.stringify(create(<GCEmptyState title="Empty" />).toJSON());

    expect(serialized).not.toContain("gc-empty-subtitle");
    expect(serialized).not.toContain("gc-empty-action");
  });
});
