// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsActionList, SettingsField, SettingsLoadWarnings, SettingsSectionShell } from "./SettingsShared";

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
    expect(markup).toMatch(/<span id="([^"]+)">Name<\/span><input aria-labelledby="\1" name="name"\/>/u);
  });

  it("keeps help text and prefilled values out of the direct control's accessible name", () => {
    const markup = renderToStaticMarkup(
      <SettingsField label="Mode">
        <select defaultValue="power">
          <option value="power">Power</option>
        </select>
        <p>Changes the runtime cost posture.</p>
      </SettingsField>,
    );
    expect(markup).toMatch(/<span id="([^"]+)">Mode<\/span><select aria-labelledby="\1">/u);
  });

  it("preserves an explicit accessible name on a direct control", () => {
    const markup = renderToStaticMarkup(
      <SettingsField label="Name">
        <input aria-label="New workspace name" />
      </SettingsField>,
    );
    expect(markup).toContain('aria-label="New workspace name"');
    expect(markup).not.toContain("aria-labelledby");
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

describe("SettingsLoadWarnings degraded semantics", () => {
  it("announces partial source failures and exposes a retry action", () => {
    const markup = renderToStaticMarkup(
      <SettingsLoadWarnings
        issues={[{ label: "Add-on catalog", message: "Deterministic outage" }]}
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Deterministic outage");
    expect(markup).toContain("Retry");
  });
});

describe("SettingsActionList keyboard scrolling", () => {
  it("makes a bounded scroll region focusable and names it", () => {
    const markup = renderToStaticMarkup(
      <SettingsActionList
        ariaLabel="Permission profile grants"
        items={[{ id: "one", label: "One", description: "First record" }]}
      />,
    );
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Permission profile grants"');
    expect(markup).toContain('tabindex="0"');
  });

  it("gives default Open actions unique owner-oriented accessible names", () => {
    const markup = renderToStaticMarkup(
      <SettingsActionList
        ariaLabel="Trust policy owners"
        items={[
          { id: "permissions", label: "Permissions", description: "Governed profiles", onClick: () => undefined },
          { id: "runtime", label: "Runtime", description: "Runtime policy", onClick: () => undefined },
        ]}
      />,
    );
    expect(markup).toContain('aria-label="Open Permissions"');
    expect(markup).toContain('aria-label="Open Runtime"');
  });
});
