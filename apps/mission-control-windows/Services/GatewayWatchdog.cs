using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

public enum WatchdogAction
{
    None,
    Restart,
    GiveUp,
}

/// <summary>What the watchdog wants the host to do after one runtime status check.</summary>
public sealed record WatchdogDecision(WatchdogAction Action, string Reason, int Attempt, int MaxAttempts)
{
    public static readonly WatchdogDecision Wait = new(WatchdogAction.None, "", 0, 0);
}

public enum WatchdogObservationKind
{
    Healthy,
    Unhealthy,
    StatusFailed,
    NotRetryable,
    Stopped,
}

/// <summary>One runtime status check, reduced to what the watchdog needs.</summary>
public readonly record struct WatchdogObservation(WatchdogObservationKind Kind, string Reason)
{
    public static WatchdogObservation Healthy => new(WatchdogObservationKind.Healthy, "");
    public static WatchdogObservation Unhealthy(string reason) => new(WatchdogObservationKind.Unhealthy, reason);
    public static WatchdogObservation StatusFailed(string reason) => new(WatchdogObservationKind.StatusFailed, reason);

    /// <summary>The launcher reported a startup failure it marked as not worth retrying.</summary>
    public static WatchdogObservation NotRetryable(string reason) => new(WatchdogObservationKind.NotRetryable, reason);

    /// <summary>
    /// Not running, and the launcher holds no process record: it was stopped on purpose (for example
    /// <c>goatcitadel stop</c>). A crash leaves the record behind, so it is reported as unhealthy instead.
    /// </summary>
    public static WatchdogObservation Stopped => new(WatchdogObservationKind.Stopped, "");

    /// <summary>Reduces one launcher status read to what the watchdog needs.</summary>
    public static WatchdogObservation FromStatus(DesktopRuntimeStatus status)
    {
        if (status.IsReady) return Healthy;
        if (status.StartupFailure is { Retryable: false } failure) return NotRetryable(failure.Summary);
        // The launcher removes the process record on a clean stop; a crash leaves it behind (state "stale").
        if (status.StartupFailure is null && !status.Readiness.Gateway && status.Pids.Gateway.State == "missing")
        {
            return Stopped;
        }
        return Unhealthy(
            $"Runtime {status.Status}: gateway {(status.Readiness.Gateway ? "ready" : "not ready")}, UI {(status.Readiness.Ui ? "ready" : "not ready")}.");
    }
}

/// <summary>
/// Decides when the desktop host should relaunch a Gateway that stopped answering (docs/RUNTIME_REPAIR_SWEEP.md,
/// "Outside Watchdog"). Deliberately small: it only counts failed checks and restarts, and never decides how to
/// repair anything. The restart itself goes through the launcher, which owns process identity and never stops a
/// process it cannot prove it owns.
/// </summary>
public sealed class GatewayWatchdog
{
    private readonly GatewayWatchdogSettings _settings;
    private readonly Func<DateTimeOffset> _now;
    private readonly Queue<DateTimeOffset> _restarts = new();
    private int _consecutiveFailures;
    private DateTimeOffset _nextRestartAllowedAt = DateTimeOffset.MinValue;
    private bool _armed;
    private bool _paused;

    public GatewayWatchdog(GatewayWatchdogSettings settings, Func<DateTimeOffset>? now = null)
    {
        _settings = settings;
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>True once the watchdog stopped restarting; only an operator launch clears it.</summary>
    public bool GaveUp { get; private set; }

    public WatchdogDecision Observe(WatchdogObservation observation)
    {
        if (observation.Kind == WatchdogObservationKind.Healthy)
        {
            // Only a Gateway that was ready at least once is watched; a failed first start has its own recovery.
            _armed = true;
            _consecutiveFailures = 0;
            return WatchdogDecision.Wait;
        }
        if (observation.Kind == WatchdogObservationKind.Stopped)
        {
            // A deliberate stop is never undone, and it is not part of a failure streak.
            _consecutiveFailures = 0;
            return WatchdogDecision.Wait;
        }

        if (!_settings.Enabled || !_armed || _paused || GaveUp) return WatchdogDecision.Wait;

        var now = _now();
        PruneRestartsOutsideWindow(now);
        if (observation.Kind == WatchdogObservationKind.NotRetryable)
        {
            return GiveUp(observation.Reason);
        }

        _consecutiveFailures++;
        if (_consecutiveFailures < _settings.FailedChecksBeforeRestart) return WatchdogDecision.Wait;
        if (_restarts.Count >= _settings.MaxRestartsPerWindow)
        {
            var minutes = (int)Math.Round(_settings.Window.TotalMinutes);
            return GiveUp($"It stopped responding {_restarts.Count} times in {minutes} minutes. Last check: {observation.Reason}");
        }
        if (now < _nextRestartAllowedAt) return WatchdogDecision.Wait;

        _restarts.Enqueue(now);
        _consecutiveFailures = 0;
        var step = Math.Min(_restarts.Count, _settings.Backoff.Count) - 1;
        _nextRestartAllowedAt = now + _settings.Backoff[step];
        return new WatchdogDecision(WatchdogAction.Restart, observation.Reason, _restarts.Count, _settings.MaxRestartsPerWindow);
    }

    /// <summary>The operator stopped the runtime (or an update is replacing it): do not bring it back.</summary>
    public void Pause()
    {
        _paused = true;
        _consecutiveFailures = 0;
    }

    /// <summary>The operator started the runtime: forget earlier failures and watch again once it is ready.</summary>
    public void ResetForOperatorLaunch()
    {
        _paused = false;
        _armed = false;
        GaveUp = false;
        _consecutiveFailures = 0;
        _restarts.Clear();
        _nextRestartAllowedAt = DateTimeOffset.MinValue;
    }

    private WatchdogDecision GiveUp(string reason)
    {
        GaveUp = true;
        return new WatchdogDecision(WatchdogAction.GiveUp, reason, _restarts.Count, _settings.MaxRestartsPerWindow);
    }

    private void PruneRestartsOutsideWindow(DateTimeOffset now)
    {
        while (_restarts.Count > 0 && now - _restarts.Peek() > _settings.Window)
        {
            _restarts.Dequeue();
        }
    }
}
