// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LibraryActionList, LibrarySectionShell } from "./library-primitives";

describe("LibrarySectionShell error branch (F-M12)", () => {
  it("renders the ErrorState primitive with role=alert and a wired retry", () => {
    const markup = renderToStaticMarkup(
      <LibrarySectionShell loading={false} error="Could not load skills." onRetry={() => undefined}>
        <div>body</div>
      </LibrarySectionShell>,
    );
    // Adopts ErrorState (role=alert), not the old silent .mc-next-directory-alert.
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("mc-next-error-state");
    expect(markup).not.toContain("mc-next-directory-alert");
    expect(markup).toContain("Could not load skills.");
    expect(markup).toContain("Retry");
  });

  it("omits the retry button when no onRetry is provided", () => {
    const markup = renderToStaticMarkup(
      <LibrarySectionShell loading={false} error="boom">
        <div>body</div>
      </LibrarySectionShell>,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("Retry");
  });

  it("renders children when there is no error", () => {
    const markup = renderToStaticMarkup(
      <LibrarySectionShell loading={false} error={null}>
        <div>library body</div>
      </LibrarySectionShell>,
    );
    expect(markup).toContain("library body");
    expect(markup).not.toContain('role="alert"');
  });
});

describe("LibraryActionList keyboard scrolling", () => {
  it("makes a bounded scroll region focusable and names it", () => {
    const markup = renderToStaticMarkup(
      <LibraryActionList
        ariaLabel="Skill import history"
        items={[{ id: "one", label: "One", description: "First record" }]}
      />,
    );
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Skill import history"');
    expect(markup).toContain('tabindex="0"');
  });
});
