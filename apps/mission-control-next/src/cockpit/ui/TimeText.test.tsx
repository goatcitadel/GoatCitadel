import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimeText } from "./TimeText";

describe("TimeText", () => {
  it("reads a missing time like the other time prefixes (U-GL-036)", () => {
    expect(renderToStaticMarkup(<TimeText value={undefined} prefix="Updated" />)).toContain(
      "Updated at an unknown time",
    );
  });

  it("says the time is unavailable when there is no prefix", () => {
    const markup = renderToStaticMarkup(<TimeText value={null} />);
    expect(markup).toContain("Time unavailable");
    expect(markup).not.toContain("unknown time");
  });
});
