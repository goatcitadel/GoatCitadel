using System.Diagnostics;

namespace GoatCitadel.MissionControl.Windows.Services;

public static class OpenTargetService
{
    public static void OpenBrowser(string target)
    {
        if (!NavigationPolicy.TryValidateBrowserTarget(target, out var uri, out var error))
        {
            throw new InvalidOperationException(error);
        }

        OpenShellTarget(uri.ToString());
    }

    public static void OpenExistingPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Any(char.IsControl) || !Path.Exists(path))
        {
            throw new InvalidOperationException("Open target must be an existing local path.");
        }

        OpenShellTarget(path);
    }

    private static void OpenShellTarget(string target)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = target,
            UseShellExecute = true,
        });
    }
}
