using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class GatewayWatchdogSettingsTests
{
    private string _root = "";

    [TestInitialize]
    public void CreateRoot() => _root = Directory.CreateTempSubdirectory("gc-watchdog-settings-").FullName;

    [TestCleanup]
    public void RemoveRoot()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private string WriteSettings(string json)
    {
        var path = GatewayWatchdogSettings.PathFor(_root);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, json);
        return path;
    }

    [TestMethod]
    public void UsesSafeDefaultsWhenThereIsNoFile()
    {
        var loaded = GatewayWatchdogSettings.Load(_root);
        Assert.AreEqual(GatewayWatchdogSettings.Defaults, loaded.Settings);
        Assert.IsNull(loaded.Problem);
    }

    [TestMethod]
    public void TheDefaultsMatchTheDesign()
    {
        var defaults = GatewayWatchdogSettings.Defaults;
        Assert.IsTrue(defaults.Enabled);
        Assert.AreEqual(3, defaults.FailedChecksBeforeRestart);
        CollectionAssert.AreEqual(
            new[] { TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2) },
            defaults.Backoff.ToArray());
        Assert.AreEqual(3, defaults.MaxRestartsPerWindow);
        Assert.AreEqual(TimeSpan.FromMinutes(10), defaults.Window);
    }

    [TestMethod]
    public void ReadsValidValues()
    {
        WriteSettings("""{ "failedChecksBeforeRestart": 5, "backoffSeconds": [10, 60], "maxRestartsPerWindow": 2, "windowMinutes": 30 }""");
        var settings = GatewayWatchdogSettings.Load(_root).Settings;
        Assert.AreEqual(5, settings.FailedChecksBeforeRestart);
        CollectionAssert.AreEqual(new[] { TimeSpan.FromSeconds(10), TimeSpan.FromMinutes(1) }, settings.Backoff.ToArray());
        Assert.AreEqual(2, settings.MaxRestartsPerWindow);
        Assert.AreEqual(TimeSpan.FromMinutes(30), settings.Window);
    }

    [TestMethod]
    public void ClampsValuesThatWouldMakeItMoreAggressive()
    {
        WriteSettings("""{ "failedChecksBeforeRestart": 0, "backoffSeconds": [0, 1], "maxRestartsPerWindow": 99, "windowMinutes": 0 }""");
        var settings = GatewayWatchdogSettings.Load(_root).Settings;
        Assert.AreEqual(GatewayWatchdogSettings.MinFailedChecks, settings.FailedChecksBeforeRestart);
        Assert.IsTrue(settings.Backoff.All(step => step >= GatewayWatchdogSettings.MinBackoff));
        Assert.AreEqual(GatewayWatchdogSettings.MaxRestartsCap, settings.MaxRestartsPerWindow);
        Assert.AreEqual(GatewayWatchdogSettings.MinWindow, settings.Window);
    }

    [TestMethod]
    public void AnUnreadableFileFallsBackToDefaultsAndNeverDisablesTheWatchdog()
    {
        WriteSettings("{ this is not json");
        var loaded = GatewayWatchdogSettings.Load(_root);
        Assert.AreEqual(GatewayWatchdogSettings.Defaults, loaded.Settings);
        Assert.IsNotNull(loaded.Problem);
    }

    [TestMethod]
    public void AWrongTypedFieldKeepsItsDefault()
    {
        WriteSettings("""{ "enabled": "no", "failedChecksBeforeRestart": "lots", "backoffSeconds": "fast" }""");
        var settings = GatewayWatchdogSettings.Load(_root).Settings;
        Assert.IsTrue(settings.Enabled, "only a literal false turns it off");
        Assert.AreEqual(GatewayWatchdogSettings.Defaults.FailedChecksBeforeRestart, settings.FailedChecksBeforeRestart);
        CollectionAssert.AreEqual(GatewayWatchdogSettings.Defaults.Backoff.ToArray(), settings.Backoff.ToArray());
    }

    [TestMethod]
    public void OnlyALiteralFalseTurnsItOff()
    {
        WriteSettings("""{ "enabled": false }""");
        Assert.IsFalse(GatewayWatchdogSettings.Load(_root).Settings.Enabled);
    }

    [TestMethod]
    public void KeepsAtMostFiveBackoffSteps()
    {
        WriteSettings("""{ "backoffSeconds": [5, 10, 20, 40, 80, 160, 320] }""");
        Assert.AreEqual(5, GatewayWatchdogSettings.Load(_root).Settings.Backoff.Count);
    }

    [TestMethod]
    public void AnOversizedFileIsIgnored()
    {
        WriteSettings("{ \"failedChecksBeforeRestart\": 5, \"pad\": \"" + new string('x', 70_000) + "\" }");
        var loaded = GatewayWatchdogSettings.Load(_root);
        Assert.AreEqual(GatewayWatchdogSettings.Defaults, loaded.Settings);
        Assert.IsNotNull(loaded.Problem);
    }
}
