using System.Runtime.InteropServices;
using GoatCitadel.MissionControl.Windows.Models;
using Microsoft.Windows.AppNotifications;
using Microsoft.Win32;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class NotificationService : IDisposable
{
    private const string InstalledAppId = "GoatCitadel.MissionControl";
    private const string InstalledActivator = "{CB0511D2-B348-4602-A08F-AEBC71B07A42}";
    private readonly Action<string> _routeHandler;
    private readonly Action<string> _fallbackToast;
    private bool _registered;

    public NotificationService(Action<string> routeHandler, Action<string> fallbackToast)
    {
        _routeHandler = routeHandler;
        _fallbackToast = fallbackToast;
    }

    public void Initialize()
    {
        try
        {
            UseInstalledSenderIdentity();
            if (!AppNotificationManager.IsSupported())
            {
                _fallbackToast("Windows app notifications are not available for this host.");
                return;
            }

            var manager = AppNotificationManager.Default;
            manager.NotificationInvoked += OnNotificationInvoked;
            manager.Register();
            _registered = true;
        }
        catch (InvalidOperationException error)
        {
            _fallbackToast($"Windows notification registration failed: {error.Message}");
        }
        catch (COMException error)
        {
            _fallbackToast($"Windows notification registration failed: {error.Message}");
        }
        catch (UnauthorizedAccessException error)
        {
            _fallbackToast($"Windows notification registration failed: {error.Message}");
        }
    }

    private static void UseInstalledSenderIdentity()
    {
        using var server = Registry.CurrentUser.OpenSubKey(
            $@"Software\Classes\CLSID\{InstalledActivator}\LocalServer32");
        var executable = Environment.ProcessPath;
        // Let unpackaged development copies retain their path-scoped SDK identity.
        if (executable is not null && string.Equals(server?.GetValue(null) as string,
            $"\"{executable}\" ----AppNotificationActivated:", StringComparison.OrdinalIgnoreCase))
        {
            Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID(InstalledAppId));
        }
    }

    [DllImport("shell32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    public void ShowApproval(ApprovalNotificationPayload payload)
    {
        var route = payload.RoutePath;
        var body = $"{payload.Kind ?? "Approval"}{(string.IsNullOrWhiteSpace(payload.RiskLevel) ? "" : $" / {payload.RiskLevel}")}";
        Show("GoatCitadel approval waiting", body, route);
    }

    public void ShowUpdateAvailable(string version) =>
        Show("GoatCitadel update available", $"Version {version} is ready to download when you choose.", "/settings/general#updates");

    public void ShowOperatorAttention(OperatorAttentionPayload payload) =>
        Show(payload.Title, payload.Body, payload.RoutePath ?? "/ops/notifications");

    public void Dispose()
    {
        if (!_registered)
        {
            return;
        }

        try
        {
            var manager = AppNotificationManager.Default;
            manager.NotificationInvoked -= OnNotificationInvoked;
            manager.Unregister();
        }
        catch (InvalidOperationException error)
        {
            _fallbackToast($"Notification teardown skipped: {error.Message}");
        }
        catch (COMException error)
        {
            _fallbackToast($"Notification teardown skipped: {error.Message}");
        }
    }

    private void Show(string title, string body, string route)
    {
        if (!NavigationPolicy.IsAllowedLocalRoute(route))
        {
            _fallbackToast("Notification route was rejected by the local navigation policy.");
            return;
        }

        try
        {
            if (!_registered || !AppNotificationManager.IsSupported())
            {
                _fallbackToast($"{title}: {body}");
                return;
            }

            var launch = $"route={Uri.EscapeDataString(route)}";
            var xml =
                $"""
                <toast launch="{EscapeXml(launch)}">
                  <visual>
                    <binding template="ToastGeneric">
                      <text>{EscapeXml(title)}</text>
                      <text>{EscapeXml(body)}</text>
                    </binding>
                  </visual>
                </toast>
            """;
            AppNotificationManager.Default.Show(new AppNotification(xml));
        }
        catch (InvalidOperationException error)
        {
            _fallbackToast($"Notification fallback: {title}. {error.Message}");
        }
        catch (COMException error)
        {
            _fallbackToast($"Notification fallback: {title}. {error.Message}");
        }
        catch (UnauthorizedAccessException error)
        {
            _fallbackToast($"Notification fallback: {title}. {error.Message}");
        }
        catch (ArgumentException error)
        {
            _fallbackToast($"Notification fallback: {title}. {error.Message}");
        }
    }

    private void OnNotificationInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args)
    {
        if (ActivationRequestResolver.ResolveNotificationArguments(args.Argument).Route is { } route)
        {
            _routeHandler(route);
        }
    }

    private static string EscapeXml(string value) =>
        value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);
}
