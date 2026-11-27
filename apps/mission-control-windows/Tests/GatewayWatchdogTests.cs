using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class GatewayWatchdogTests
{
    private DateTimeOffset _now = new(2026, 11, 27, 12, 0, 0, TimeSpan.Zero);

    private GatewayWatchdog Create(GatewayWatchdogSettings? settings = null) =>
        new(settings ?? GatewayWatchdogSettings.Defaults, () => _now);

    private static WatchdogObservation Down(string reason = "gateway not ready") => WatchdogObservation.Unhealthy(reason);

    private WatchdogDecision ObserveAfter(GatewayWatchdog watchdog, TimeSpan elapsed, WatchdogObservation observation)
    {
        _now += elapsed;
        return watchdog.Observe(observation);
    }

    /// <summary>Feeds failed checks 10 s apart until the watchdog decides something other than waiting.</summary>
    private WatchdogDecision FailUntilDecision(GatewayWatchdog watchdog, int maxChecks = 50)
    {
        for (var check = 0; check < maxChecks; check++)
        {
            var decision = ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down());
            if (decision.Action != WatchdogAction.None) return decision;
        }
        return WatchdogDecision.Wait;
    }

    [TestMethod]
    public void NeverRestartsAHealthyGateway()
    {
        var watchdog = Create();
        for (var check = 0; check < 20; check++)
        {
            Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Healthy).Action);
        }
    }

    [TestMethod]
    public void DoesNothingUntilTheGatewayHasBeenReadyOnce()
    {
        // A Gateway that never started has its own startup recovery screen; the watchdog must not loop on it.
        var watchdog = Create();
        Assert.AreEqual(WatchdogAction.None, FailUntilDecision(watchdog).Action);
    }

    [TestMethod]
    public void RestartsAfterTheConfiguredNumberOfFailedChecksInARow()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down()).Action);
        Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down()).Action);
        var decision = ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down("status check timed out"));
        Assert.AreEqual(WatchdogAction.Restart, decision.Action);
        Assert.AreEqual(1, decision.Attempt);
        Assert.AreEqual(3, decision.MaxAttempts);
        Assert.AreEqual("status check timed out", decision.Reason);
    }

    [TestMethod]
    public void AHealthyCheckResetsTheFailureCount()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down());
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down());
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Healthy);
        Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down()).Action);
        Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down()).Action);
    }

    [TestMethod]
    public void AFailedStatusReadCountsAsAFailedCheck()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.StatusFailed("launcher timed out"));
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.StatusFailed("launcher timed out"));
        Assert.AreEqual(WatchdogAction.Restart, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.StatusFailed("launcher timed out")).Action);
    }

    [TestMethod]
    public void WaitsLongerBetweenEachRestart()
    {
        var settings = GatewayWatchdogSettings.Defaults with
        {
            Backoff = new[] { TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2) },
            MaxRestartsPerWindow = 5,
            Window = TimeSpan.FromMinutes(30),
        };
        var watchdog = Create(settings);
        watchdog.Observe(WatchdogObservation.Healthy);
        var first = FailUntilDecision(watchdog);
        Assert.AreEqual(WatchdogAction.Restart, first.Action);
        var firstAt = _now;

        var second = FailUntilDecision(watchdog);
        Assert.AreEqual(WatchdogAction.Restart, second.Action);
        Assert.IsTrue(_now - firstAt >= TimeSpan.FromSeconds(30), "second restart must wait the first backoff");
        var secondAt = _now;

        var third = FailUntilDecision(watchdog);
        Assert.AreEqual(WatchdogAction.Restart, third.Action);
        Assert.IsTrue(_now - secondAt >= TimeSpan.FromMinutes(2), "later restarts use the last backoff step");
        Assert.AreEqual(3, third.Attempt);
    }

    [TestMethod]
    public void GivesUpOnceAfterTooManyRestartsInTheWindowAndThenStaysQuiet()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        for (var restart = 1; restart <= 3; restart++)
        {
            Assert.AreEqual(WatchdogAction.Restart, FailUntilDecision(watchdog).Action, $"restart {restart}");
        }

        var giveUp = FailUntilDecision(watchdog);
        Assert.AreEqual(WatchdogAction.GiveUp, giveUp.Action);
        Assert.IsTrue(watchdog.GaveUp);
        Assert.AreEqual(WatchdogAction.None, FailUntilDecision(watchdog).Action);
        Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromHours(2), Down()).Action);
    }

    [TestMethod]
    public void RestartsOlderThanTheWindowNoLongerCount()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        FailUntilDecision(watchdog);
        FailUntilDecision(watchdog);
        ObserveAfter(watchdog, TimeSpan.FromMinutes(11), WatchdogObservation.Healthy);
        Assert.AreEqual(WatchdogAction.Restart, FailUntilDecision(watchdog).Action);
        Assert.AreEqual(WatchdogAction.Restart, FailUntilDecision(watchdog).Action);
        Assert.IsFalse(watchdog.GaveUp);
    }

    [TestMethod]
    public void AStartupFailureTheLauncherCallsNonRetryableGivesUpAtOnce()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        var decision = ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.NotRetryable("database files are locked"));
        Assert.AreEqual(WatchdogAction.GiveUp, decision.Action);
        Assert.AreEqual("database files are locked", decision.Reason);
    }

    [TestMethod]
    public void IgnoresChecksWhilePausedForAnOperatorStop()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        watchdog.Pause();
        Assert.AreEqual(WatchdogAction.None, FailUntilDecision(watchdog).Action);
    }

    [TestMethod]
    public void AnOperatorLaunchClearsAGiveUpAndRearmsOnTheNextReadyCheck()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        watchdog.Observe(WatchdogObservation.NotRetryable("locked"));
        Assert.IsTrue(watchdog.GaveUp);

        watchdog.ResetForOperatorLaunch();
        Assert.IsFalse(watchdog.GaveUp);
        Assert.AreEqual(WatchdogAction.None, FailUntilDecision(watchdog).Action, "not armed until ready again");
        watchdog.Observe(WatchdogObservation.Healthy);
        Assert.AreEqual(WatchdogAction.Restart, FailUntilDecision(watchdog).Action);
    }

    [TestMethod]
    public void ARuntimeStoppedOnPurposeElsewhereIsNeverRestarted()
    {
        // `goatcitadel stop` in a terminal removes the process record; that is a choice, not a crash.
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        for (var check = 0; check < 20; check++)
        {
            Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Stopped).Action);
        }
    }

    [TestMethod]
    public void AStoppedCheckDoesNotCountTowardARestartButACrashAfterwardsDoes()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down());
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down());
        Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Stopped).Action);
        Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down()).Action, "the count started over");

        // Started again from a terminal, then crashed: the watchdog still covers it.
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Healthy);
        Assert.AreEqual(WatchdogAction.Restart, FailUntilDecision(watchdog).Action);
    }

    [TestMethod]
    public void RemembersWhyItGaveUpUntilTheOperatorStartsItAgain()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        watchdog.Observe(WatchdogObservation.NotRetryable("database files are locked"));
        Assert.AreEqual("database files are locked", watchdog.GiveUpReason);
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), Down("a later check"));
        Assert.AreEqual("database files are locked", watchdog.GiveUpReason, "later checks keep the original reason");

        watchdog.ResetForOperatorLaunch();
        Assert.IsNull(watchdog.GiveUpReason);
    }

    [TestMethod]
    public void EveryOperatorActionStartsANewGenerationSoQueuedRestartsCanTellTheyAreStale()
    {
        var watchdog = Create();
        var start = watchdog.OperatorGeneration;
        watchdog.Pause();
        var afterStop = watchdog.OperatorGeneration;
        watchdog.ResetForOperatorLaunch();
        Assert.IsTrue(afterStop > start);
        Assert.IsTrue(watchdog.OperatorGeneration > afterStop);
    }

    [TestMethod]
    public void AGatewayItsOwnStopLeftDownIsNotMistakenForADeliberateStop()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        Assert.AreEqual(WatchdogAction.Restart, FailUntilDecision(watchdog).Action);
        watchdog.MarkStoppedByWatchdog();

        // The restart's stop removed the Gateway record, then the relaunch did not bring it back.
        WatchdogDecision decision = WatchdogDecision.Wait;
        for (var check = 0; check < 50 && decision.Action == WatchdogAction.None; check++)
        {
            decision = ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Stopped);
        }
        Assert.AreEqual(WatchdogAction.Restart, decision.Action, "the watchdog keeps trying");
    }

    [TestMethod]
    public void OnceTheGatewayIsBackADeliberateStopIsHonouredAgain()
    {
        var watchdog = Create();
        watchdog.Observe(WatchdogObservation.Healthy);
        FailUntilDecision(watchdog);
        watchdog.MarkStoppedByWatchdog();
        ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Healthy);
        for (var check = 0; check < 20; check++)
        {
            Assert.AreEqual(WatchdogAction.None, ObserveAfter(watchdog, TimeSpan.FromSeconds(10), WatchdogObservation.Stopped).Action);
        }
    }

    [TestMethod]
    public void NeverRestartsWhenTheOperatorTurnedItOff()
    {
        var watchdog = Create(GatewayWatchdogSettings.Defaults with { Enabled = false });
        watchdog.Observe(WatchdogObservation.Healthy);
        Assert.AreEqual(WatchdogAction.None, FailUntilDecision(watchdog).Action);
    }
}
