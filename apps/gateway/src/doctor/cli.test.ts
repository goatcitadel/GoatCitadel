import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  confirm: vi.fn(),
  loadLocalEnvFile: vi.fn(),
  loadResolvedProfile: vi.fn(),
  renderDoctorReport: vi.fn(),
  runDoctor: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  confirm: state.confirm,
}));

vi.mock("../env-file.js", () => ({
  loadLocalEnvFile: state.loadLocalEnvFile,
}));

vi.mock("../tui/profile.js", () => ({
  loadResolvedProfile: state.loadResolvedProfile,
}));

vi.mock("./engine.js", () => ({
  renderDoctorReport: state.renderDoctorReport,
  runDoctor: state.runDoctor,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
  state.confirm.mockReset();
  state.loadLocalEnvFile.mockReset();
  state.loadResolvedProfile.mockReset();
  state.renderDoctorReport.mockReset();
  state.runDoctor.mockReset();
});

describe("doctor CLI", () => {
  it("passes parsed flags, profile auth, and confirmation callback into the doctor engine", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.confirm.mockResolvedValue(true);
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "F:/profiles/ops.json",
      profile: {
        gatewayBaseUrl: "http://profile-gateway:8787",
        tokenQueryParam: "access_token",
      },
      auth: {
        mode: "token",
        token: "profile-token",
      },
    });
    state.runDoctor.mockResolvedValue({
      summary: {
        exitCode: 7,
      },
      checks: [],
    });
    process.argv = [
      "node",
      "doctor",
      "--profile",
      "ops",
      "--gateway",
      "http://gateway.local:8787",
      "--root-dir",
      "F:/code/personal-ai",
      "--audit-only",
      "--no-repair",
      "--deep",
      "--yes",
      "--json",
      "--read-only",
    ];

    await import("./cli.js");
    await vi.waitFor(() => expect(state.runDoctor).toHaveBeenCalled());

    expect(state.loadLocalEnvFile).toHaveBeenCalledTimes(1);
    expect(state.loadResolvedProfile).toHaveBeenCalledWith({
      profileName: "ops",
      gatewayOverride: "http://gateway.local:8787",
    });
    expect(state.runDoctor).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "F:/code/personal-ai",
        gatewayBaseUrl: "http://gateway.local:8787",
        profileName: "ops",
        profilePath: "F:/profiles/ops.json",
        deep: true,
        auditOnly: true,
        noRepair: true,
        yes: true,
        readOnly: true,
        authToken: "profile-token",
        authMode: "token",
        tokenQueryParam: "access_token",
      }),
    );
    await expect(state.runDoctor.mock.calls[0]?.[0].promptConfirm("Repair workspace?")).resolves.toBe(true);
    expect(state.confirm).toHaveBeenCalledWith({
      message: "Repair workspace?",
      default: false,
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          summary: {
            exitCode: 7,
          },
          checks: [],
        },
        null,
        2,
      ),
    );
    expect(state.renderDoctorReport).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(7);
  });

  it("renders the text report and accepts the --root and -y aliases", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "default",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
      },
      auth: {
        mode: "none",
      },
    });
    state.runDoctor.mockResolvedValue({
      summary: {
        exitCode: 0,
      },
      checks: [],
    });
    state.renderDoctorReport.mockReturnValue("Doctor report");
    process.argv = ["node", "doctor", "--root", "F:/repo", "-y"];

    await import("./cli.js");
    await vi.waitFor(() => expect(state.renderDoctorReport).toHaveBeenCalled());

    expect(state.runDoctor).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "F:/repo",
        gatewayBaseUrl: "http://127.0.0.1:8787",
        yes: true,
        auditOnly: false,
        noRepair: false,
        deep: false,
        readOnly: false,
      }),
    );
    expect(log).toHaveBeenCalledWith("Doctor report");
    expect(process.exitCode).toBe(0);
  });

  it("reports startup failures as CLI exit code 2", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.loadResolvedProfile.mockRejectedValue(new Error("profile missing"));
    process.argv = ["node", "doctor", "--profile", "missing"];

    await import("./cli.js");
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("profile missing"));

    expect(log).not.toHaveBeenCalled();
    expect(state.runDoctor).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
