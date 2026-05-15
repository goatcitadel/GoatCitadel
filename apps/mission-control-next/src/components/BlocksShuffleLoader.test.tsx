import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlocksShuffleLoader } from "./BlocksShuffleLoader";

describe("BlocksShuffleLoader", () => {
  it("renders the compact labeled loader variant", () => {
    const markup = renderToStaticMarkup(<BlocksShuffleLoader compact label="Loading runtime" />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain("mc-next-blocks-loader compact");
    expect(markup).toContain("Loading runtime");
  });

  it("omits the label shell when no label is provided", () => {
    const markup = renderToStaticMarkup(<BlocksShuffleLoader />);

    expect(markup).toContain("mc-next-blocks-loader");
    expect(markup).not.toContain("mc-next-blocks-loader-label");
  });
});
