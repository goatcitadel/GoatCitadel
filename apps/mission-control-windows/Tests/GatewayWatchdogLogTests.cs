using System.Text.Json;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class GatewayWatchdogLogTests
{
    private string _root = "";

    [TestInitialize]
    public void CreateRoot() => _root = Directory.CreateTempSubdirectory("gc-watchdog-log-").FullName;

    [TestCleanup]
    public void RemoveRoot()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private static readonly DateTimeOffset At = new(2026, 11, 27, 12, 0, 0, TimeSpan.Zero);

    [TestMethod]
    public void AppendsOneJsonLinePerEvent()
    {
        var log = new GatewayWatchdogLog(_root);
        log.Record(At, new WatchdogDecision(WatchdogAction.Restart, "gateway not ready", 1, 3));
        log.Record(At.AddMinutes(1), new WatchdogDecision(WatchdogAction.GiveUp, "too many restarts", 3, 3));

        var lines = File.ReadAllLines(GatewayWatchdogLog.PathFor(_root));
        Assert.AreEqual(2, lines.Length);
        using var first = JsonDocument.Parse(lines[0]);
        Assert.AreEqual(1, first.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.AreEqual("restart", first.RootElement.GetProperty("action").GetString());
        Assert.AreEqual("gateway not ready", first.RootElement.GetProperty("reason").GetString());
        Assert.AreEqual(1, first.RootElement.GetProperty("attempt").GetInt32());
        Assert.AreEqual(At.ToString("O"), first.RootElement.GetProperty("at").GetString());
        using var second = JsonDocument.Parse(lines[1]);
        Assert.AreEqual("give_up", second.RootElement.GetProperty("action").GetString());
    }

    [TestMethod]
    public void KeepsOnlyTheNewestEntries()
    {
        var log = new GatewayWatchdogLog(_root);
        for (var index = 0; index < GatewayWatchdogLog.MaxEntries + 25; index++)
        {
            log.Record(At.AddSeconds(index), new WatchdogDecision(WatchdogAction.Restart, $"reason {index}", 1, 3));
        }

        var lines = File.ReadAllLines(GatewayWatchdogLog.PathFor(_root));
        Assert.AreEqual(GatewayWatchdogLog.MaxEntries, lines.Length);
        StringAssert.Contains(lines[^1], $"reason {GatewayWatchdogLog.MaxEntries + 24}");
    }

    [TestMethod]
    public void BoundsTheRecordedReason()
    {
        var log = new GatewayWatchdogLog(_root);
        log.Record(At, new WatchdogDecision(WatchdogAction.Restart, new string('x', 5_000), 1, 3));
        using var entry = JsonDocument.Parse(File.ReadAllLines(GatewayWatchdogLog.PathFor(_root))[0]);
        Assert.IsTrue(entry.RootElement.GetProperty("reason").GetString()!.Length <= GatewayWatchdogLog.MaxReasonLength);
    }

    [TestMethod]
    public void NeverThrowsWhenTheLogCannotBeWritten()
    {
        // A file where the log folder should be makes every write fail; the watchdog must keep running.
        var blocked = Path.Join(_root, "runtime");
        File.WriteAllText(blocked, "not a folder");
        var log = new GatewayWatchdogLog(_root);
        log.Record(At, new WatchdogDecision(WatchdogAction.Restart, "gateway not ready", 1, 3));
    }
}
