using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class DesktopRuntimeLifecycleTests
{
    [TestMethod]
    public async Task LatePreStopReadCannotApplyReadyOrRestartPolling()
    {
        using var lifecycle = new DesktopRuntimeLifecycle();
        Assert.IsTrue(lifecycle.TryCaptureStatus(out var beforeStop));
        var read = new TaskCompletionSource<string>();
        var applied = new List<string>();
        async Task Observe()
        {
            var result = await read.Task;
            if (lifecycle.IsCurrent(beforeStop)) applied.Add(result);
        }
        var pending = Observe();
        var stopped = lifecycle.BeginTransition();
        read.SetResult("ready");
        await pending;
        Assert.IsTrue(beforeStop.Token.IsCancellationRequested);
        Assert.AreEqual(0, applied.Count);
        Assert.IsTrue(lifecycle.IsCurrent(stopped));
    }

    [DataTestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task StatusStartedDuringStopCannotApplyReady(bool settlesAfterStop)
    {
        using var lifecycle = new DesktopRuntimeLifecycle();
        Assert.IsTrue(lifecycle.TryCaptureStatus(out var beforeStop));
        var stop = lifecycle.BeginStop();
        var read = new TaskCompletionSource<string>();
        var view = "stopping";
        var readStarted = false;

        async Task ObserveStatus()
        {
            if (!lifecycle.TryCaptureStatus(out var status)) return;
            readStarted = true;
            var result = await read.Task;
            if (lifecycle.IsCurrent(status)) view = result;
        }

        void CompleteStop()
        {
            Assert.IsTrue(lifecycle.TryCompleteStop(stop));
            view = "stopped";
        }

        var pending = ObserveStatus();
        if (settlesAfterStop) CompleteStop();
        read.SetResult("ready");
        await pending;

        Assert.AreEqual(settlesAfterStop ? "stopped" : "stopping", view);
        Assert.IsFalse(readStarted);
        Assert.IsFalse(lifecycle.IsCurrent(beforeStop));
        if (!settlesAfterStop) CompleteStop();
        Assert.IsFalse(lifecycle.IsCurrent(stop));
        Assert.IsTrue(lifecycle.TryCaptureStatus(out var fresh));
        Assert.IsTrue(lifecycle.IsCurrent(fresh));
    }


    [TestMethod]
    public async Task InternallyCaughtInitializationFailureCannotOverwriteStoppedView()
    {
        using var lifecycle = new DesktopRuntimeLifecycle();
        var initialization = lifecycle.BeginTransition();
        var fail = new TaskCompletionSource();
        var view = "starting";
        async Task Initialize()
        {
            try { await fail.Task; throw new InvalidOperationException("fixture WebView failure"); }
            catch (InvalidOperationException) { if (lifecycle.IsCurrent(initialization)) view = "recovery"; }
        }
        var pending = Initialize();
        lifecycle.BeginTransition();
        view = "stopped";
        fail.SetResult();
        await pending;
        Assert.AreEqual("stopped", view);
    }
    [TestMethod]
    public void StaleStopCompletionDoesNotClearNewerTransitionOrPendingStop()
    {
        using var lifecycle = new DesktopRuntimeLifecycle();
        var firstStop = lifecycle.BeginStop();
        var retry = lifecycle.BeginTransition();
        Assert.IsTrue(lifecycle.TryCaptureStatus(out var retryStatus));
        Assert.IsFalse(lifecycle.TryCompleteStop(firstStop));
        Assert.IsTrue(lifecycle.IsCurrent(retry));
        Assert.IsTrue(lifecycle.IsCurrent(retryStatus));

        var secondStop = lifecycle.BeginStop();
        Assert.IsFalse(lifecycle.TryCompleteStop(firstStop));
        Assert.IsFalse(lifecycle.TryCaptureStatus(out _));
        Assert.IsTrue(lifecycle.TryCompleteStop(secondStop));
        Assert.IsTrue(lifecycle.TryCaptureStatus(out var refusedStopRefresh));
        Assert.IsTrue(lifecycle.IsCurrent(refusedStopRefresh));
    }

    [TestMethod]
    public void RetryAndExitInvalidateEarlierWebViewOrLaunchContinuation()
    {
        using var lifecycle = new DesktopRuntimeLifecycle();
        var launch = lifecycle.BeginTransition();
        var retry = lifecycle.BeginTransition();
        Assert.IsFalse(lifecycle.IsCurrent(launch));
        Assert.IsTrue(lifecycle.IsCurrent(retry));
        lifecycle.Dispose();
        Assert.IsFalse(lifecycle.IsCurrent(retry));
        Assert.IsTrue(retry.Token.IsCancellationRequested);
    }
}