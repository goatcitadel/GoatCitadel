using System.Text.Json;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class DesktopStartupDiagnosticsTests
{
    private readonly string _root = Path.Join(Path.GetTempPath(), "goat-desktop-startup-" + Guid.NewGuid().ToString("N"));
    private string SnapshotPath => Path.Join(_root, "runtime", "logs", "desktop-startup.json");

    [TestCleanup]
    public void Cleanup()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    [TestMethod]
    public void RecordsActualProcessNavigationAndResetsStaleSuccessOnNewStartup()
    {
        var diagnostics = new DesktopStartupDiagnostics(_root);
        diagnostics.RecordPhase("webview-initialized", browserVersion: "153.0.1.0");
        diagnostics.RecordNavigation("http://127.0.0.1:5175/settings/onboarding?token=private#secret", "GoatCitadel Get started", true);
        using (var snapshot = JsonDocument.Parse(File.ReadAllText(SnapshotPath)))
        {
            Assert.AreEqual(Environment.ProcessId, snapshot.RootElement.GetProperty("processId").GetInt32());
            Assert.AreEqual("http://127.0.0.1:5175/settings/onboarding", snapshot.RootElement.GetProperty("url").GetString());
            Assert.AreEqual("GoatCitadel Get started", snapshot.RootElement.GetProperty("title").GetString());
            Assert.IsTrue(snapshot.RootElement.GetProperty("navigationSucceeded").GetBoolean());
            Assert.AreEqual("153.0.1.0", snapshot.RootElement.GetProperty("browserVersion").GetString());
            Assert.IsFalse(snapshot.RootElement.GetRawText().Contains("private", StringComparison.Ordinal));
        }
        _ = new DesktopStartupDiagnostics(_root);
        using var restarted = JsonDocument.Parse(File.ReadAllText(SnapshotPath));
        Assert.AreEqual("starting", restarted.RootElement.GetProperty("phase").GetString());
        Assert.IsFalse(restarted.RootElement.GetProperty("navigationSucceeded").GetBoolean());
    }

    [DataTestMethod]
    [DataRow("about:blank")]
    [DataRow("https://example.com/settings/onboarding")]
    [DataRow("http://name:secret@localhost:5175/settings/onboarding")]
    public void DoesNotRecordUnsafeTargetsAsSuccessfulNavigation(string source)
    {
        new DesktopStartupDiagnostics(_root).RecordNavigation(source, "Private title", true);
        using var snapshot = JsonDocument.Parse(File.ReadAllText(SnapshotPath));
        Assert.IsFalse(snapshot.RootElement.GetProperty("navigationSucceeded").GetBoolean());
        Assert.AreEqual(JsonValueKind.Null, snapshot.RootElement.GetProperty("url").ValueKind);
        Assert.AreEqual(JsonValueKind.Null, snapshot.RootElement.GetProperty("title").ValueKind);
    }

    [TestMethod]
    public void FailureClearsSuccessWithoutPersistingExceptionSecrets()
    {
        var diagnostics = new DesktopStartupDiagnostics(_root);
        diagnostics.RecordNavigation("http://localhost:5175/settings/onboarding", "Get started", true);
        diagnostics.RecordPhase("runtime-failed", new IOException("Bearer private-token"));
        using var snapshot = JsonDocument.Parse(File.ReadAllText(SnapshotPath));
        Assert.IsFalse(snapshot.RootElement.GetProperty("navigationSucceeded").GetBoolean());
        Assert.AreEqual("IOException", snapshot.RootElement.GetProperty("errorType").GetString());
        Assert.IsFalse(snapshot.RootElement.GetRawText().Contains("private-token", StringComparison.Ordinal));
    }
}
