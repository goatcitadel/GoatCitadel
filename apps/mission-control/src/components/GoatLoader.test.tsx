import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { GoatLoader } from "./GoatLoader";

describe("GoatLoader", () => {
  it("renders the shared signal loader with the default accessible status label", () => {
    const renderer = create(<GoatLoader />);
    const status = renderer.root.findByProps({ role: "status" });

    expect(status.props["aria-live"]).toBe("polite");
    expect(status.props.className).toBe("signal-loader ");
    expect(JSON.stringify(renderer.toJSON())).toContain("Working...");
  });

  it("passes custom label and compact state through to SignalLoader", () => {
    const renderer = create(<GoatLoader label="Syncing traces" compact />);
    const status = renderer.root.findByProps({ role: "status" });

    expect(status.props.className).toContain("compact");
    expect(JSON.stringify(renderer.toJSON())).toContain("Syncing traces");
  });
});
