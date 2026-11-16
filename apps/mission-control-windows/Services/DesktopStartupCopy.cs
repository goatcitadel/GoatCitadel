using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

/// <summary>
/// Operator-facing sentences for the start-up screen. They state only what the host knows: how long it has
/// waited and the reason the Gateway recorded, never that the runtime is healthy before it answers.
/// </summary>
public static class DesktopStartupCopy
{
    private static readonly TimeSpan ElapsedThreshold = TimeSpan.FromSeconds(5);

    public static string StartingMessage(TimeSpan elapsed)
    {
        if (elapsed < ElapsedThreshold)
        {
            return "Starting the local runtime...";
        }

        var seconds = (int)Math.Floor(elapsed.TotalSeconds);
        return $"Starting the local runtime... {seconds} s so far. The first start can take a few minutes.";
    }

    public static string RecoveryMessage(DesktopRuntimeStatus status)
    {
        var summary = status.StartupFailure?.Summary?.Trim();
        return string.IsNullOrEmpty(summary)
            ? $"Runtime is {status.Status}. Gateway and Mission Control did not both become ready."
            : $"GoatCitadel could not start. {summary}";
    }

    public static string LaunchFailureMessage(DesktopRuntimeStatus? status, string launcherError)
    {
        return string.IsNullOrWhiteSpace(status?.StartupFailure?.Summary)
            ? launcherError
            : RecoveryMessage(status!);
    }
}
