using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class RuntimeStatusServiceTests
{
    [TestMethod]
    public async Task RefusedStopDoesNotBecomeSuccessfulJustBecauseLauncherExitedZero()
    {
        if (!OperatingSystem.IsWindows()) Assert.Inconclusive("The launcher fixture uses cmd.exe.");
        var root = Path.Join(Path.GetTempPath(), "goatcitadel-stop-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var launcher = Path.Join(root, "fixture.cmd");
            await File.WriteAllTextAsync(launcher, "@echo off\r\necho {\"action\":\"stop\",\"status\":\"ready\",\"readiness\":{\"gateway\":true,\"ui\":true},\"notStopped\":[{\"label\":\"gateway\",\"reason\":\"external_override\"}]}\r\n");
            var service = new RuntimeStatusService(new LauncherService(new LauncherEnvironment(
                new Dictionary<string, string?> { ["GOATCITADEL_HOME"] = root, ["GOATCITADEL_DESKTOP_LAUNCHER"] = launcher })));
            var error = await Assert.ThrowsExceptionAsync<InvalidOperationException>(async () =>
            {
                using var result = await service.StopAsync();
            });
            StringAssert.Contains(error.Message, "external_override");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [TestMethod]
    public async Task StopRequiresStoppedReadinessEvenWhenRefusalArrayIsEmpty()
    {
        if (!OperatingSystem.IsWindows()) Assert.Inconclusive("The launcher fixture uses cmd.exe.");
        var root = Path.Join(Path.GetTempPath(), "goatcitadel-stop-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var launcher = Path.Join(root, "fixture.cmd");
            await File.WriteAllTextAsync(launcher, "@echo off\r\necho {\"action\":\"stop\",\"status\":\"degraded\",\"readiness\":{\"gateway\":true,\"ui\":false},\"notStopped\":[]}\r\n");
            var service = new RuntimeStatusService(new LauncherService(new LauncherEnvironment(
                new Dictionary<string, string?> { ["GOATCITADEL_HOME"] = root, ["GOATCITADEL_DESKTOP_LAUNCHER"] = launcher })));
            await Assert.ThrowsExceptionAsync<InvalidOperationException>(async () => { using var result = await service.StopAsync(); });
        }
        finally { Directory.Delete(root, recursive: true); }
    }
    [TestMethod]
    public async Task ConfirmedStoppedResultRemainsUsableByTheDesktop()
    {
        if (!OperatingSystem.IsWindows()) Assert.Inconclusive("The launcher fixture uses cmd.exe.");
        var root = Path.Join(Path.GetTempPath(), "goatcitadel-stop-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var launcher = Path.Join(root, "fixture.cmd");
            await File.WriteAllTextAsync(launcher, "@echo off\r\necho {\"action\":\"stop\",\"status\":\"stopped\",\"readiness\":{\"gateway\":false,\"ui\":false},\"notStopped\":[]}\r\n");
            var service = new RuntimeStatusService(new LauncherService(new LauncherEnvironment(
                new Dictionary<string, string?> { ["GOATCITADEL_HOME"] = root, ["GOATCITADEL_DESKTOP_LAUNCHER"] = launcher })));
            using var result = await service.StopAsync();
            Assert.AreEqual("stopped", result.RootElement.GetProperty("status").GetString());
            Assert.AreEqual(0, result.RootElement.GetProperty("notStopped").GetArrayLength());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}