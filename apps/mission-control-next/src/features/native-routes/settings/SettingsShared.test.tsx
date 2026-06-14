// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSectionShell } from "./SettingsShared";

describe("SettingsSectionShell error branch (F-M12)", () => {
  it("renders the ErrorState primitive with role=alert and a wired retry", () => {
    const markup = renderToStaticMarkup(
      <SettingsSectionShell loading={false} error="Could not load settings." onRetry={() => undefined}>
        <div>body</div>
      </SettingsSectionShell>,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("mc-next-error-state");
    expect(markup).not.toContain("mc-next-directory-alert");
    expect(markup).toContain("Could not load settings.");
    expect(markup).toContain("Retry");
  });

  it("omits the retry button when no onRetry is provided", () => {
    const markup = renderToStaticMarkup(
      <SettingsSectionShell loading={false} error="boom">
        <div>body</div>
      </SettingsSectionShell>,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("Retry");
  });

  it("renders children when there is no error", () => {
    const markup = renderToStaticMarkup(
      <SettingsSectionShell loading={false} error={null}>
        <div>settings body</div>
      </SettingsSectionShell>,
    );
    expect(markup).toContain("settings body");
    expect(markup).not.toContain('role="alert"');
  });
});
