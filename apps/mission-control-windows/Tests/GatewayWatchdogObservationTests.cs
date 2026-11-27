using GoatCitadel.MissionControl.Windows.Models;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class GatewayWatchdogObservationTests
{
    private static DesktopRuntimeStatus Status(string state, bool gateway = false, bool ui = false, RuntimeStartupFailure? failure = null)
    {
        var status = new DesktopRuntimeStatus
        {
            Status = gateway && ui ? "ready" : "stopped",
            Readiness = new RuntimeReadiness { Gateway = gateway, Ui = ui },
            StartupFailure = failure,
        };
        status.Pids.Gateway.State = state;
        return status;
    }

    [TestMethod]
    public void AReadyRuntimeIsHealthy() =>
        Assert.AreEqual(WatchdogObservationKind.Healthy, WatchdogObservation.FromStatus(Status("running", gateway: true, ui: true)).Kind);

    [TestMethod]
    public void ACrashedGatewayLeavesAStaleRecordAndIsUnhealthy() =>
        Assert.AreEqual(WatchdogObservationKind.Unhealthy, WatchdogObservation.FromStatus(Status("stale")).Kind);

    [TestMethod]
    public void AHungGatewayIsStillRunningAndIsUnhealthy() =>
        Assert.AreEqual(WatchdogObservationKind.Unhealthy, WatchdogObservation.FromStatus(Status("running")).Kind);

    [TestMethod]
    public void ACleanStopRemovesTheRecordAndIsNotACrash() =>
        Assert.AreEqual(WatchdogObservationKind.Stopped, WatchdogObservation.FromStatus(Status("missing")).Kind);

    [TestMethod]
    public void AMissingRecordWithAStartupFailureIsStillAFailure()
    {
        var failure = new RuntimeStartupFailure { Summary = "port in use", Retryable = true };
        Assert.AreEqual(WatchdogObservationKind.Unhealthy, WatchdogObservation.FromStatus(Status("missing", failure: failure)).Kind);
    }

    [TestMethod]
    public void ANonRetryableStartupFailureSaysSo()
    {
        var failure = new RuntimeStartupFailure { Summary = "database files are locked", Retryable = false };
        var observation = WatchdogObservation.FromStatus(Status("stale", failure: failure));
        Assert.AreEqual(WatchdogObservationKind.NotRetryable, observation.Kind);
        Assert.AreEqual("database files are locked", observation.Reason);
    }

    [TestMethod]
    public void ACrashedGatewayIsRelaunchedWithoutAStopTheLauncherWouldRefuse() =>
        // `goatcitadel stop` refuses a stale record (metadata_stale); `launch` spawns over it.
        Assert.AreEqual(WatchdogRestartPlan.LaunchOnly, WatchdogRestartPlanner.For(Status("stale")));

    [TestMethod]
    public void AHungGatewayIsStoppedFirstBecauseLaunchWouldOnlyWaitForIt() =>
        Assert.AreEqual(WatchdogRestartPlan.StopThenLaunch, WatchdogRestartPlanner.For(Status("running")));

    [TestMethod]
    public void AnUnknownOrUnownedProcessIsNeverStopped()
    {
        Assert.AreEqual(WatchdogRestartPlan.LaunchOnly, WatchdogRestartPlanner.For(null));
        foreach (var state in new[] { "missing", "unverified", "reused", "invalid" })
        {
            Assert.AreEqual(WatchdogRestartPlan.LaunchOnly, WatchdogRestartPlanner.For(Status(state)), state);
        }
    }

    [TestMethod]
    public void AGatewayThatIsUpWhileTheUiIsDownIsUnhealthy() =>
        Assert.AreEqual(WatchdogObservationKind.Unhealthy, WatchdogObservation.FromStatus(Status("running", gateway: true)).Kind);
}
