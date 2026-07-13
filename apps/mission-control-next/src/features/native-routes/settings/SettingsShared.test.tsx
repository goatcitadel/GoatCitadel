// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsField, SettingsSectionShell } from "./SettingsShared";

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

describe("SettingsField semantics", () => {
  it("keeps the wrapping-label pattern for a single form control", () => {
    const markup = renderToStaticMarkup(
      <SettingsField label="Name">
        <input name="name" />
      </SettingsField>,
    );
    expect(markup).toContain("<label");
    expect(markup).not.toContain('role="group"');
  });

  it("uses a labelled group instead of nesting labels for composite controls", () => {
    const markup = renderToStaticMarkup(
      <SettingsField label="Enabled surfaces" group>
        <label>
          <input type="checkbox" /> Chat
        </label>
        <label>
          <input type="checkbox" /> Tools
        </label>
      </SettingsField>,
    );
    expect(markup).toContain('role="group"');
    expect(markup).toMatch(/aria-labelledby="[^"]+"/u);
    expect(markup.match(/<label/g)?.length).toBe(2);
  });
});
