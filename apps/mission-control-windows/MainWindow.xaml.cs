using GoatCitadel.MissionControl.Windows.Models;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Graphics;

namespace GoatCitadel.MissionControl.Windows;

public sealed partial class MainWindow : Window
{
    private const int InitialWidth = 1440;
    private const int InitialHeight = 960;
    private const int MinimumWidth = 960;
    private const int MinimumHeight = 700;
    private static readonly TimeSpan RuntimePollInterval = TimeSpan.FromSeconds(10);

    private readonly LauncherService _launcherService;
    private readonly RuntimeStatusService _runtimeStatusService;
    private readonly EventStreamService _eventStreamService;
    private readonly NotificationService _notificationService;
    private readonly TrayService _trayService = new();

    private AppWindow? _appWindow;
    private DesktopRuntimeStatus? _lastRuntime;
    private DispatcherQueueTimer? _pollTimer;
    private DispatcherQueueTimer? _toastTimer;
    private CancellationTokenSource? _eventStreamCts;
    private Task? _webViewInitializationTask;
    private string? _eventStreamKey;
    private bool _allowClose;
    private bool _cleanedUp;
    private bool _trayAvailable;
    private bool _webViewReady;

    public MainWindow()
    {
        InitializeComponent();

        _launcherService = new LauncherService();
        _runtimeStatusService = new RuntimeStatusService(_launcherService);
        _eventStreamService = new EventStreamService(_runtimeStatusService);
        _notificationService = new NotificationService(
            route => DispatcherQueue.TryEnqueue(() => OpenRoutePath(route)),
            message => DispatcherQueue.TryEnqueue(() => ShowToast(message)));

        ConfigureWindow();
        ConfigureEvents();
        ConfigureTrayFallbackSafe();
        _notificationService.Initialize();
        Closed += (_, _) => CleanupForExit();
        _webViewInitializationTask = InitializeWebViewAsync();
        _ = LaunchRuntimeAsync();
    }

    public void ShowAndFocus()
    {
        _appWindow?.Show();
        Activate();
    }

    public void OpenRoutePath(string routePath)
    {
        if (!NavigationPolicy.IsAllowedLocalRoute(routePath))
        {
            ShowToast("Rejected non-local desktop route.");
            return;
        }

        if (_lastRuntime is null || string.IsNullOrWhiteSpace(_lastRuntime.UiUrl))
        {
            ShowToast("Mission Control is not ready yet.");
            return;
        }

        var target = $"{_lastRuntime.UiUrl.TrimEnd('/')}{routePath}";
        if (!NavigationPolicy.TryValidateBrowserTarget(target, out var uri, out var error))
        {
            ShowToast(error);
            return;
        }

        ShowAndFocus();
        MissionWebView.Source = uri;
        StartupPanel.Visibility = Visibility.Collapsed;
        MissionWebView.Visibility = Visibility.Visible;
    }

    private void ConfigureWindow()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var windowId = Win32Interop.GetWindowIdFromWindow(hwnd);
        _appWindow = AppWindow.GetFromWindowId(windowId);
        _appWindow.Resize(new SizeInt32(InitialWidth, InitialHeight));
        _appWindow.Title = "GoatCitadel Mission Control";
        _appWindow.Closing += (_, args) =>
        {
            if (_allowClose || !_trayAvailable)
            {
                return;
            }

            args.Cancel = true;
            _appWindow.Hide();
        };
        _appWindow.Changed += (_, args) =>
        {
            if (!args.DidSizeChange || _appWindow is null)
            {
                return;
            }

            var size = _appWindow.Size;
            if (size.Width < MinimumWidth || size.Height < MinimumHeight)
            {
                _appWindow.Resize(new SizeInt32(Math.Max(size.Width, MinimumWidth), Math.Max(size.Height, MinimumHeight)));
            }
        };
    }

    private void ConfigureEvents()
    {
        _eventStreamService.ApprovalCreated += payload =>
            DispatcherQueue.TryEnqueue(() => _notificationService.ShowApproval(payload));
        _eventStreamService.OperatorAttention += payload =>
            DispatcherQueue.TryEnqueue(() => _notificationService.ShowOperatorAttention(payload));
        _eventStreamService.WatcherError += (code, message) =>
            DispatcherQueue.TryEnqueue(() => ShowToast($"{code}: {message}"));
    }

    private void ConfigureTray()
    {
        _trayService.Initialize(new TrayActions
        {
            OpenMissionControl = () => DispatcherQueue.TryEnqueue(ShowAndFocus),
            OpenInBrowser = () => DispatcherQueue.TryEnqueue(OpenBrowserFallback),
            RuntimeStatus = () => DispatcherQueue.TryEnqueue(() => _ = RefreshRuntimeStatusAsync(notify: true, syncShell: true)),
            RestartRuntime = () => DispatcherQueue.TryEnqueue(() => _ = RestartRuntimeAsync()),
            StopRuntime = () => DispatcherQueue.TryEnqueue(() => _ = StopRuntimeAsync()),
            OpenLogs = () => DispatcherQueue.TryEnqueue(OpenLogs),
            OpenInstallFolder = () => DispatcherQueue.TryEnqueue(OpenInstallFolder),
            Quit = () => DispatcherQueue.TryEnqueue(Quit),
        });
        _trayAvailable = true;
    }

    private void ConfigureTrayFallbackSafe()
    {
        try
        {
            ConfigureTray();
        }
        catch (Exception error)
        {
            _trayAvailable = false;
            _trayService.Dispose();
            ShowToast($"Tray controls are unavailable: {error.Message}");
        }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "GoatCitadel",
                "WebView2");
            Directory.CreateDirectory(userDataFolder);
            Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", userDataFolder, EnvironmentVariableTarget.Process);
            await MissionWebView.EnsureCoreWebView2Async();
            MissionWebView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!NavigationPolicy.TryValidateBrowserTarget(args.Uri, out var ignoredUri, out var error))
                {
                    args.Cancel = true;
                    ShowToast(error);
                }
            };
            _webViewReady = true;
        }
        catch (Exception error)
        {
            _webViewReady = false;
            _webViewInitializationTask = null;
            RenderRecovery($"WebView2 initialization failed: {error.Message}");
        }
    }

    private async Task LaunchRuntimeAsync()
    {
        StopRuntimeStatusPolling();
        StopEventStream();
        RenderStarting();
        try
        {
            var result = await _runtimeStatusService.LaunchAsync();
            _lastRuntime = result;
            if (result.IsReady)
            {
                await ShowReadyRuntimeAsync(result);
            }
            else
            {
                RenderRuntime(result);
                RenderRecovery($"Runtime is {result.Status}. Gateway and Mission Control did not both become ready.");
                StartRuntimeStatusPolling();
            }
        }
        catch (Exception error)
        {
            RenderRecovery(error.Message);
        }
    }

    private async Task ShowReadyRuntimeAsync(DesktopRuntimeStatus result)
    {
        _lastRuntime = result;
        RenderRuntime(result);
        await EnsureWebViewReadyAsync();
        if (!_webViewReady)
        {
            RenderRecovery("WebView2 is not ready yet. Use Retry after the desktop webview finishes initializing.");
            return;
        }

        if (!NavigateToRuntimeTarget(result))
        {
            return;
        }

        StartupPanel.Visibility = Visibility.Collapsed;
        MissionWebView.Visibility = Visibility.Visible;
        StartRuntimeStatusPolling();
        EnsureEventStream(result);
    }

    private async Task RefreshRuntimeStatusAsync(bool notify, bool syncShell)
    {
        try
        {
            var result = await _runtimeStatusService.ReadStatusAsync();
            _lastRuntime = result;
            var message = $"Runtime {result.Status}: gateway {(result.Readiness.Gateway ? "ready" : "not ready")}, UI {(result.Readiness.Ui ? "ready" : "not ready")}.";
            if (notify)
            {
                ShowToast(message);
            }

            if (!syncShell)
            {
                return;
            }

            if (result.IsReady)
            {
                if (MissionWebView.Visibility == Visibility.Visible)
                {
                    RenderRuntime(result);
                    EnsureEventStream(result);
                }
                else
                {
                    await ShowReadyRuntimeAsync(result);
                }
            }
            else
            {
                RenderRuntime(result);
                RenderRecovery(message);
            }
        }
        catch (Exception error)
        {
            if (notify)
            {
                ShowToast(error.Message);
            }

            if (syncShell)
            {
                RenderRecovery($"Runtime status check failed: {error.Message}");
            }
        }
    }

    private async Task RestartRuntimeAsync()
    {
        await StopRuntimeAsync();
        ShowToast("Runtime stopped. Restarting...");
        await LaunchRuntimeAsync();
    }

    private async Task StopRuntimeAsync()
    {
        StopEventStream();
        try
        {
            await _runtimeStatusService.StopAsync();
        }
        catch (Exception error)
        {
            ShowToast(error.Message);
        }

        RenderStopped();
    }

    private void StartEventStream(DesktopRuntimeStatus result)
    {
        StopEventStream();
        _eventStreamCts = new CancellationTokenSource();
        _ = _eventStreamService.RunAsync(result, _eventStreamCts.Token);
    }

    private void StopEventStream()
    {
        _eventStreamCts?.Cancel();
        _eventStreamCts?.Dispose();
        _eventStreamCts = null;
        _eventStreamKey = null;
    }

    private async Task EnsureWebViewReadyAsync()
    {
        _webViewInitializationTask ??= InitializeWebViewAsync();
        await _webViewInitializationTask;
    }

    private bool NavigateToRuntimeTarget(DesktopRuntimeStatus result)
    {
        if (!NavigationPolicy.TryValidateBrowserTarget(result.TargetUrl, out var uri, out var error))
        {
            RenderRecovery(error);
            return false;
        }

        MissionWebView.Source = uri;
        return true;
    }

    private void EnsureEventStream(DesktopRuntimeStatus result)
    {
        var nextKey = EventStreamKey(result);
        if (_eventStreamCts is not null && string.Equals(_eventStreamKey, nextKey, StringComparison.Ordinal))
        {
            return;
        }

        StartEventStream(result);
        _eventStreamKey = nextKey;
    }

    private static string EventStreamKey(DesktopRuntimeStatus result) =>
        $"{result.GatewayUrl.TrimEnd('/')}|{result.DesktopEventStream?.Token}|{result.DesktopEventStream?.Error}";

    private void StartRuntimeStatusPolling()
    {
        StopRuntimeStatusPolling();
        _pollTimer = DispatcherQueue.CreateTimer();
        _pollTimer.Interval = RuntimePollInterval;
        _pollTimer.Tick += (_, _) => _ = RefreshRuntimeStatusAsync(notify: false, syncShell: true);
        _pollTimer.Start();
    }

    private void StopRuntimeStatusPolling()
    {
        _pollTimer?.Stop();
        _pollTimer = null;
    }

    private void RenderStarting()
    {
        StartupPanel.Visibility = Visibility.Visible;
        MissionWebView.Visibility = Visibility.Collapsed;
        RecoveryActions.Visibility = Visibility.Collapsed;
        StatusCopy.Text = "Starting the local runtime...";
        ProgressBar.Value = 42;
        RuntimeMeta.Text = "Gateway and Mission Control will stay warm while the desktop app is open.";
    }

    private void RenderRuntime(DesktopRuntimeStatus result)
    {
        StatusCopy.Text = result.Status == "ready" ? "Runtime ready. Opening Mission Control..." : $"Runtime status: {result.Status}";
        ProgressBar.Value = result.Status == "ready" ? 100 : 64;
        RuntimeMeta.Text = string.Join(
            " / ",
            $"Gateway {(result.Readiness.Gateway ? "ready" : "not ready")}",
            $"UI {(result.Readiness.Ui ? "ready" : "not ready")}",
            result.Packaged ? "packaged install" : "source checkout");
    }

    private void RenderRecovery(string message)
    {
        StartupPanel.Visibility = Visibility.Visible;
        MissionWebView.Visibility = Visibility.Collapsed;
        RecoveryActions.Visibility = Visibility.Visible;
        StatusCopy.Text = message;
        ProgressBar.Value = 18;
        RuntimeMeta.Text = _lastRuntime is not null
            ? $"Logs: {_lastRuntime.LogFiles.GatewayStderr}"
            : "Runtime did not return a status payload. Open logs for captured launcher output.";
    }

    private void RenderStopped()
    {
        StopRuntimeStatusPolling();
        StartupPanel.Visibility = Visibility.Visible;
        MissionWebView.Visibility = Visibility.Collapsed;
        RecoveryActions.Visibility = Visibility.Visible;
        StatusCopy.Text = "Runtime stopped.";
        ProgressBar.Value = 0;
        RuntimeMeta.Text = _lastRuntime is not null
            ? $"Gateway {(_lastRuntime.Readiness.Gateway ? "ready" : "not ready")} / UI {(_lastRuntime.Readiness.Ui ? "ready" : "not ready")}"
            : "Use Retry to start GoatCitadel again.";
    }

    private void ShowToast(string message)
    {
        DesktopToast.Message = message;
        DesktopToast.IsOpen = true;
        _toastTimer?.Stop();
        _toastTimer = DispatcherQueue.CreateTimer();
        _toastTimer.Interval = TimeSpan.FromMilliseconds(5200);
        _toastTimer.Tick += (_, _) =>
        {
            DesktopToast.IsOpen = false;
            _toastTimer?.Stop();
        };
        _toastTimer.Start();
    }

    private void OpenBrowserFallback()
    {
        var url = _lastRuntime?.TargetUrl ?? _lastRuntime?.UiUrl;
        if (string.IsNullOrWhiteSpace(url))
        {
            ShowToast("Mission Control URL is not available yet.");
            return;
        }

        TryAction(() => OpenTargetService.OpenBrowser(url));
    }

    private void OpenLogs()
    {
        var root = _launcherService.ResolveLauncher().InstallRoot;
        var logFile = _lastRuntime?.LogFiles.GatewayStderr ?? _lastRuntime?.LogFiles.GatewayStdout;
        var logDir = !string.IsNullOrWhiteSpace(logFile) ? Path.GetDirectoryName(logFile) : null;
        TryAction(() => OpenTargetService.OpenExistingPath(logDir ?? Path.Combine(root, "runtime", "logs")));
    }

    private void OpenInstallFolder()
    {
        var root = _launcherService.ResolveLauncher().InstallRoot;
        TryAction(() => OpenTargetService.OpenExistingPath(root));
    }

    private void Quit()
    {
        _allowClose = true;
        CleanupForExit();
        Close();
    }

    private void CleanupForExit()
    {
        if (_cleanedUp)
        {
            return;
        }

        _cleanedUp = true;
        StopEventStream();
        StopRuntimeStatusPolling();
        _notificationService.Dispose();
        _trayService.Dispose();
    }

    private void TryAction(Action action)
    {
        try
        {
            action();
        }
        catch (Exception error)
        {
            ShowToast(error.Message);
        }
    }

    private void RetryButton_Click(object sender, RoutedEventArgs e) => _ = LaunchRuntimeAsync();
    private void OpenBrowserButton_Click(object sender, RoutedEventArgs e) => OpenBrowserFallback();
    private void OpenLogsButton_Click(object sender, RoutedEventArgs e) => OpenLogs();
    private void OpenFolderButton_Click(object sender, RoutedEventArgs e) => OpenInstallFolder();
}
