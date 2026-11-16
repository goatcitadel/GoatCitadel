using GoatCitadel.MissionControl.Windows.Models;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class DesktopStartupCopyTests
{
    private const string Summary = "The local database did not start within 180 seconds. Open Logs shows its last messages.";

    [TestMethod]
    public void RecoveryNamesTheRecordedReason()
    {
        var status = RuntimeStatusService.ParseStatus("{\"status\":\"stopped\",\"readiness\":{\"gateway\":false,\"ui\":false},\"startupFailure\":{\"summary\":\"" + Summary + "\",\"retryable\":true,\"at\":\"2026-11-15T10:00:00.000Z\"}}");
        Assert.AreEqual("GoatCitadel could not start. " + Summary, DesktopStartupCopy.RecoveryMessage(status));
    }

    [TestMethod]
    public void RecoveryWithoutARecordKeepsTheGeneralSentence()
    {
        var status = RuntimeStatusService.ParseStatus("{\"status\":\"degraded\",\"readiness\":{\"gateway\":true,\"ui\":false}}");
        Assert.IsNull(status.StartupFailure);
        Assert.AreEqual("Runtime is degraded. Gateway and Mission Control did not both become ready.", DesktopStartupCopy.RecoveryMessage(status));
    }

    [TestMethod]
    public void ABlankRecordedSummaryIsNotShown()
    {
        var status = new DesktopRuntimeStatus { Status = "stopped", StartupFailure = new RuntimeStartupFailure { Summary = "  " } };
        Assert.AreEqual("Runtime is stopped. Gateway and Mission Control did not both become ready.", DesktopStartupCopy.RecoveryMessage(status));
    }

    [TestMethod]
    public void LaunchFailureFallsBackToTheLauncherErrorWithoutARecord()
    {
        Assert.AreEqual("GoatCitadel launcher exited with 1: boom", DesktopStartupCopy.LaunchFailureMessage(null, "GoatCitadel launcher exited with 1: boom"));
        Assert.AreEqual("GoatCitadel launcher exited with 1: boom", DesktopStartupCopy.LaunchFailureMessage(new DesktopRuntimeStatus(), "GoatCitadel launcher exited with 1: boom"));
    }

    [TestMethod]
    public void LaunchFailureUsesTheRecordedReasonWhenThereIsOne()
    {
        var status = new DesktopRuntimeStatus { Status = "stopped", StartupFailure = new RuntimeStartupFailure { Summary = Summary, Retryable = true } };
        Assert.AreEqual("GoatCitadel could not start. " + Summary, DesktopStartupCopy.LaunchFailureMessage(status, "GoatCitadel launcher exited with 1: boom"));
    }

    [TestMethod]
    public void StartingShowsElapsedSecondsAfterFive()
    {
        Assert.AreEqual("Starting the local runtime...", DesktopStartupCopy.StartingMessage(TimeSpan.FromSeconds(3)));
        Assert.AreEqual("Starting the local runtime... 40 s so far. The first start can take a few minutes.", DesktopStartupCopy.StartingMessage(TimeSpan.FromSeconds(40)));
    }
}
