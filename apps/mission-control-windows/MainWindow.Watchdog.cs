using GoatCitadel.MissionControl.Windows.Models;
using GoatCitadel.MissionControl.Windows.Services;

namespace GoatCitadel.MissionControl.Windows;

/// <summary>
/// Desktop watchdog wiring (docs/RUNTIME_REPAIR_SWEEP.md, "Outside Watchdog"). The decision logic lives in
/// <see cref="GatewayWatchdog"/>; this file only feeds it status checks and carries out its decision through the
/// existing stop and launch paths, which go through the launcher's ownership checks.
/// </summary>
public sealed partial class MainWindow
{
    private GatewayWatchdog? _watchdog;
    private GatewayWatchdogLog? _watchdogLog;
    private bool _watchdogRestartInFlight;

    private GatewayWatchdog Watchdog => _watchdog ??= CreateWatchdog();

    private GatewayWatchdog CreateWatchdog()
    {
        try
        {
            var installRoot = _launcherService.ResolveLauncher().InstallRoot;
            var (settings, problem) = GatewayWatchdogSettings.Load(installRoot);
            if (problem is not null) _startupDiagnostics?.RecordPhase("watchdog-settings-defaulted", new InvalidDataException(problem));
            _watchdogLog = new GatewayWatchdogLog(installRoot);
            return new GatewayWatchdog(settings);
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            // Without an install root there is nowhere to read settings or log; the defaults still protect the runtime.
            return new GatewayWatchdog(GatewayWatchdogSettings.Defaults);
        }
    }

    private void ObserveRuntimeStatusForWatchdog(DesktopRuntimeStatus status)
    {
        HandleWatchdogDecision(Watchdog.Observe(WatchdogObservation.FromStatus(status)));
    }

    private void ObserveRuntimeStatusFailureForWatchdog(Exception error) =>
        HandleWatchdogDecision(Watchdog.Observe(WatchdogObservation.StatusFailed(error.Message)));

    private const string WatchdogGaveUpAdvice =
        "It won't restart on its own until you start it again. Use Retry, or check the logs in the runtime folder.";

    /// <summary>Keeps the give-up explanation visible on later status checks, which re-render the recovery panel.</summary>
    private string WithWatchdogNote(string message) =>
        _watchdog is { GaveUp: true } watchdog
            ? $"GoatCitadel stopped responding and couldn't be restarted: {watchdog.GiveUpReason} {WatchdogGaveUpAdvice} Latest check: {message}"
            : message;

    private void HandleWatchdogDecision(WatchdogDecision decision)
    {
        if (decision.Action == WatchdogAction.None || _cleanedUp) return;
        _watchdogLog?.Record(DateTimeOffset.UtcNow, decision);
        // An operator stop or launch between now and the queued callback overtakes this decision.
        var generation = Watchdog.OperatorGeneration;
        // Act after the status check that produced this decision has finished rendering.
        DispatcherQueue.TryEnqueue(() =>
        {
            if (_cleanedUp || Watchdog.OperatorGeneration != generation) return;
            if (decision.Action == WatchdogAction.Restart)
            {
                ShowToast($"GoatCitadel stopped responding. Restarting it (try {decision.Attempt} of {decision.MaxAttempts}).");
                _ = WatchdogRestartAsync(generation);
                return;
            }

            RenderRecovery(WithWatchdogNote(decision.Reason));
            _notificationService.ShowRuntimeStopped($"It stopped responding and couldn't be restarted. {WatchdogGaveUpAdvice}");
        });
    }

    private async Task WatchdogRestartAsync(long generation)
    {
        if (_watchdogRestartInFlight || _cleanedUp || _profileRecoveryChanging) return;
        if (Watchdog.OperatorGeneration != generation) return;
        _watchdogRestartInFlight = true;
        try
        {
            // A crashed Gateway is relaunched directly: stop would refuse its stale record and block recovery. Only a
            // hung one still running is stopped first, through the launcher, which refuses any process it can't
            // prove it owns.
            if (WatchdogRestartPlanner.For(_lastRuntime) == WatchdogRestartPlan.StopThenLaunch)
            {
                // Until the Gateway is ready again, a record this stop removed is not an operator's stop.
                Watchdog.MarkStoppedByWatchdog();
                // A partly refused stop (for example the UI refused, the Gateway stopped) still needs the launch.
                // Launch never stops anything: over a live, unowned process it only waits and fails, and the next
                // checks lead to another attempt or a give-up.
                await StopRuntimeAsync(byWatchdog: true);
                // The window may have closed, or the operator acted, while the stop ran.
                if (_cleanedUp || Watchdog.OperatorGeneration != generation) return;
            }
            await LaunchRuntimeAsync(byWatchdog: true);
        }
        finally
        {
            _watchdogRestartInFlight = false;
        }
    }
}
