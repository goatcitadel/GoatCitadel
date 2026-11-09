using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;
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
    private readonly DesktopStartupDiagnostics? _startupDiagnostics;
    private readonly RuntimeStatusService _runtimeStatusService;
    private readonly EventStreamService _eventStreamService;
    private readonly NotificationService _notificationService;
    private readonly TrayService _trayService = new();
    private readonly DeferredRouteDeliveryQueue _deferredRoutes = new();
    private readonly DesktopRuntimeLifecycle _runtimeLifecycle = new();
    private long _runtimeStatusSequence;
    private long _runtimeStatusGeneration = -1;
    private bool _runtimeStatusInFlight;

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
    private bool _webViewNavigationSucceeded;

    public MainWindow()
    {
        InitializeComponent();

        _launcherService = new LauncherService();
        _startupDiagnostics = DesktopStartupDiagnostics.TryCreate(_launcherService);
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
        _ = LaunchRuntimeAsync();
        InitializeUpdates();
    }

    public void ShowAndFocus()
    {
        _appWindow?.Show();
        if (_appWindow?.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter)
        {
            presenter.Restore();
        }
        Activate();
        // WinUI Activate alone can leave a window behind the current foreground app.
        _ = SetForegroundWindow(WinRT.Interop.WindowNative.GetWindowHandle(this));
    }

    [DllImport("user32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint window);

    internal void ShowActivationDiagnostic(string diagnostic) => ShowToast(diagnostic);

    public void OpenRoutePath(string routePath)
    {
        if (!NavigationPolicy.IsAllowedLocalRoute(routePath))
        {
            ShowToast("Rejected non-local desktop route.");
            return;
        }

        ShowAndFocus();
        if (!_deferredRoutes.Submit(routePath, TryDeliverLocalRoute))
        {
            ShowToast("Mission Control is starting. This link will open when ready.");
        }
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
            CheckForUpdates = () => DispatcherQueue.TryEnqueue(() => _ = ShowUpdatesAsync()),
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
        catch (InvalidOperationException error)
        {
            RenderTrayFallback(error);
        }
        catch (ExternalException error)
        {
            RenderTrayFallback(error);
        }
        catch (UnauthorizedAccessException error)
        {
            RenderTrayFallback(error);
        }
    }

    private async Task InitializeWebViewAsync(DesktopRuntimeObservation observation)
    {
        try
        {
            var configuredUserDataFolder = Environment.GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER");
            var userDataFolder = string.IsNullOrWhiteSpace(configuredUserDataFolder)
                ? Path.Join(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "GoatCitadel",
                    "WebView2")
                : Path.GetFullPath(configuredUserDataFolder);
            Directory.CreateDirectory(userDataFolder);
            // Elevated WebView2 hosts ignore environment overrides. Supply the selected
            // profile through the supported API without enabling any debug switches.
            var environment = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateWithOptionsAsync(
                null, userDataFolder, null);
            await MissionWebView.EnsureCoreWebView2Async(environment, null);
            if (_cleanedUp) return;
            _startupDiagnostics?.RecordPhase("webview-initialized", browserVersion: environment.BrowserVersionString);
            MissionWebView.CoreWebView2.WebMessageReceived += MissionWebView_WebMessageReceived;
            MissionWebView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                _webViewNavigationSucceeded = false;
                _startupDiagnostics?.RecordPhase("navigating");
                if (!NavigationPolicy.TryValidateBrowserTarget(args.Uri, out var ignoredUri, out var error))
                {
                    args.Cancel = true;
                    ShowToast(error);
                }
            };
            MissionWebView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                _webViewNavigationSucceeded = args.IsSuccess;
                RecordWebViewNavigation();
            };
            MissionWebView.CoreWebView2.DocumentTitleChanged += (_, _) =>
            {
                if (_webViewNavigationSucceeded) RecordWebViewNavigation();
            };
            MissionWebView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                // Never let window.open / target=_blank spawn an off-allowlist popup WebView.
                args.Handled = true;
                TryAction(() => OpenTargetService.OpenBrowserPopup(args.Uri));
            };
            _webViewReady = true;
        }
        catch (InvalidOperationException error)
        {
            RenderWebViewRecovery(error, observation);
        }
        catch (COMException error)
        {
            RenderWebViewRecovery(error, observation);
        }
        catch (IOException error)
        {
            RenderWebViewRecovery(error, observation);
        }
        catch (UnauthorizedAccessException error)
        {
            RenderWebViewRecovery(error, observation);
        }
    }

    private void RecordWebViewNavigation() => _startupDiagnostics?.RecordNavigation(
        MissionWebView.CoreWebView2.Source, MissionWebView.CoreWebView2.DocumentTitle, _webViewNavigationSucceeded);

    private void MissionWebView_WebMessageReceived(
        Microsoft.Web.WebView2.Core.CoreWebView2 sender,
        Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            if (TryHandleUpdateMessage(args.Source, args.WebMessageAsJson)) return;
            if (!Uri.TryCreate(args.Source, UriKind.Absolute, out var source)
                || !source.IsLoopback
                || (source.Scheme != Uri.UriSchemeHttp && source.Scheme != Uri.UriSchemeHttps))
            {
                return;
            }
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out var type)
                || type.GetString() != "goatcitadel.evolution.pick_source"
                || !root.TryGetProperty("requestId", out var requestIdElement)
                || !Guid.TryParse(requestIdElement.GetString(), out var requestId))
            {
                return;
            }

            using var picker = new System.Windows.Forms.FolderBrowserDialog
            {
                Description = "Choose a clean GoatCitadel source repository",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = false,
            };
            var result = picker.ShowDialog();
            var response = result == System.Windows.Forms.DialogResult.OK && !string.IsNullOrWhiteSpace(picker.SelectedPath)
                ? new
                {
                    type = "goatcitadel.evolution.source_selected",
                    requestId = requestId.ToString(),
                    cancelled = false,
                    path = Path.GetFullPath(picker.SelectedPath),
                }
                : new
                {
                    type = "goatcitadel.evolution.source_selected",
                    requestId = requestId.ToString(),
                    cancelled = true,
                    path = string.Empty,
                };
            sender.PostWebMessageAsJson(JsonSerializer.Serialize(response));
        }
        catch (JsonException)
        {
            // Invalid web messages are ignored; native picker input is fail-closed.
        }
        catch (ArgumentException)
        {
            // Invalid native paths are never returned to the web surface.
        }
        catch (NotSupportedException)
        {
            // Unsupported path formats remain unselected.
        }
        catch (InvalidOperationException)
        {
            // JSON fields with the wrong value kind are not bridge requests.
        }
    }

    private async Task LaunchRuntimeAsync()
    {
        if (_cleanedUp) return;
        var observation = _runtimeLifecycle.BeginTransition();
        _webViewInitializationTask ??= InitializeWebViewAsync(observation);
        _deferredRoutes.MarkUnavailable();
        StopRuntimeStatusPolling();
        StopEventStream();
        RenderStarting();
        try
        {
            var result = await _runtimeStatusService.LaunchAsync(observation.Token);
            if (!_runtimeLifecycle.IsCurrent(observation)) return;
            _lastRuntime = result;
            if (result.IsReady)
            {
                await ShowReadyRuntimeAsync(result, observation);
            }
            else
            {
                _deferredRoutes.MarkUnavailable();
                RenderRuntime(result);
                RenderRecovery($"Runtime is {result.Status}. Gateway and Mission Control did not both become ready.");
                StartRuntimeStatusPolling();
            }
        }
        catch (InvalidOperationException error)
        {
            RenderRuntimeRecovery(error, observation);
        }
        catch (Win32Exception error)
        {
            RenderRuntimeRecovery(error, observation);
        }
        catch (IOException error)
        {
            RenderRuntimeRecovery(error, observation);
        }
        catch (UnauthorizedAccessException error)
        {
            RenderRuntimeRecovery(error, observation);
        }
        catch (OperationCanceledException error)
        {
            RenderRuntimeRecovery(error, observation);
        }
    }

    private async Task ShowReadyRuntimeAsync(DesktopRuntimeStatus result, DesktopRuntimeObservation observation)
    {
        if (!_runtimeLifecycle.IsCurrent(observation)) return;
        _lastRuntime = result;
        RenderRuntime(result);
        await EnsureWebViewReadyAsync(observation);
        if (!_runtimeLifecycle.IsCurrent(observation)) return;
        if (!_webViewReady)
        {
            _deferredRoutes.MarkUnavailable();
            RenderRecovery("WebView2 is not ready yet. Use Retry after the desktop webview finishes initializing.");
            return;
        }

        _deferredRoutes.MarkReady();
        var deliveredDeferredRoute = _deferredRoutes.Flush(TryDeliverLocalRoute);
        if (!deliveredDeferredRoute && !NavigateToRuntimeTarget(result))
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
        if (_cleanedUp) return;
        if (!_runtimeLifecycle.TryCaptureStatus(out var observation))
        {
            if (notify) ShowToast("Runtime stop is in progress.");
            return;
        }
        if (_runtimeStatusInFlight && _runtimeStatusGeneration == observation.Generation) return;
        var request = ++_runtimeStatusSequence;
        _runtimeStatusGeneration = observation.Generation;
        _runtimeStatusInFlight = true;
        if (syncShell)
        {
            // Do not dispatch through the last successful status while the fresh
            // health read is in flight. The runtime may have died between polls.
            _deferredRoutes.MarkUnavailable();
        }

        try
        {
            var result = await _runtimeStatusService.ReadStatusAsync(observation.Token);
            if (!_runtimeLifecycle.IsCurrent(observation) || request != _runtimeStatusSequence) return;
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
                    _deferredRoutes.MarkReady();
                    _deferredRoutes.Flush(TryDeliverLocalRoute);
                }
                else
                {
                    await ShowReadyRuntimeAsync(result, observation);
                }
            }
            else
            {
                _deferredRoutes.MarkUnavailable();
                RenderRuntime(result);
                RenderRecovery(message);
            }
        }
        catch (InvalidOperationException error)
        {
            RenderRuntimeStatusFailure(error, notify, syncShell, observation);
        }
        catch (Win32Exception error)
        {
            RenderRuntimeStatusFailure(error, notify, syncShell, observation);
        }
        catch (IOException error)
        {
            RenderRuntimeStatusFailure(error, notify, syncShell, observation);
        }
        catch (UnauthorizedAccessException error)
        {
            RenderRuntimeStatusFailure(error, notify, syncShell, observation);
        }
        catch (OperationCanceledException error)
        {
            RenderRuntimeStatusFailure(error, notify, syncShell, observation);
        }
        finally
        {
            if (request == _runtimeStatusSequence) _runtimeStatusInFlight = false;
        }
    }

    private async Task RestartRuntimeAsync()
    {
        if (!await StopRuntimeAsync()) return;
        ShowToast("Runtime stopped. Restarting...");
        await LaunchRuntimeAsync();
    }

    private async Task<bool> StopRuntimeAsync()
    {
        if (_cleanedUp) return false;
        var observation = _runtimeLifecycle.BeginStop();
        _deferredRoutes.MarkUnavailable();
        StopRuntimeStatusPolling();
        StopEventStream();
        try
        {
            using var result = await _runtimeStatusService.StopAsync(observation.Token);
            if (!_runtimeLifecycle.IsCurrent(observation)) return false;
            var stopped = RuntimeStatusService.ParseStatus(result.RootElement.GetRawText());
            if (!_runtimeLifecycle.TryCompleteStop(observation)) return false;
            _lastRuntime = stopped;
            RenderStopped();
            return true;
        }
        catch (Exception error) when (error is InvalidOperationException or Win32Exception or IOException
            or UnauthorizedAccessException or OperationCanceledException)
        {
            if (_runtimeLifecycle.TryCompleteStop(observation))
            {
                ShowToast(error.Message);
                // A refused or partial stop is still a live runtime that needs observation.
                StartRuntimeStatusPolling();
                await RefreshRuntimeStatusAsync(notify: false, syncShell: true);
            }
            return false;
        }
        finally
        {
            _runtimeLifecycle.TryCompleteStop(observation);
        }
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

    private async Task EnsureWebViewReadyAsync(DesktopRuntimeObservation observation)
    {
        _webViewInitializationTask ??= InitializeWebViewAsync(observation);
        await _webViewInitializationTask;
        if (!_webViewReady) _webViewInitializationTask = null;
    }

    private bool NavigateToRuntimeTarget(DesktopRuntimeStatus result)
    {
        if (!NavigationPolicy.TryValidateBrowserTarget(result.TargetUrl, out var uri, out var error))
        {
            RenderRecovery(error);
            return false;
        }

        MissionWebView.CoreWebView2.Navigate(uri.AbsoluteUri);
        return true;
    }

    private bool TryDeliverLocalRoute(string routePath)
    {
        var runtime = _lastRuntime;
        if (!_webViewReady || runtime is null || !runtime.IsReady || string.IsNullOrWhiteSpace(runtime.UiUrl))
        {
            return false;
        }

        var target = $"{runtime.UiUrl.TrimEnd('/')}{routePath}";
        if (!NavigationPolicy.TryValidateBrowserTarget(target, out var uri, out var error))
        {
            // The route itself was validated before submission. Retain it if the
            // runtime reported an unusable URL so a successful restart can retry it.
            ShowToast(error);
            return false;
        }

        ShowAndFocus();
        MissionWebView.CoreWebView2.Navigate(uri.AbsoluteUri);
        StartupPanel.Visibility = Visibility.Collapsed;
        MissionWebView.Visibility = Visibility.Visible;
        return true;
    }

    private void EnsureEventStream(DesktopRuntimeStatus result)
    {
        // Status polls mint short-lived tokens. An already authenticated stream
        // should stay open until it ends or the Gateway changes.
        var nextKey = result.GatewayUrl.TrimEnd('/');
        if (_eventStreamCts is not null && string.Equals(_eventStreamKey, nextKey, StringComparison.Ordinal))
        {
            return;
        }

        StartEventStream(result);
        _eventStreamKey = nextKey;
    }

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
        ProgressBar.Visibility = Visibility.Visible;
        ProgressBar.IsIndeterminate = true;
        RuntimeMeta.Text = "Gateway and Mission Control will stay warm while the desktop app is open.";
    }

    private void RenderRuntime(DesktopRuntimeStatus result)
    {
        StatusCopy.Text = result.Status == "ready" ? "Runtime ready. Opening Mission Control..." : $"Runtime status: {result.Status}";
        ProgressBar.IsIndeterminate = result.Status != "ready";
        ProgressBar.Value = result.Status == "ready" ? 100 : 0;
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
        ProgressBar.IsIndeterminate = false;
        ProgressBar.Visibility = Visibility.Collapsed;
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
        ProgressBar.IsIndeterminate = false;
        ProgressBar.Visibility = Visibility.Collapsed;
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
        TryAction(() => OpenTargetService.OpenExistingPath(logDir ?? Path.Join(root, "runtime", "logs")));
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
        _runtimeLifecycle.Dispose();
        StopEventStream();
        StopRuntimeStatusPolling();
        _notificationService.Dispose();
        StopUpdates();
        _trayService.Dispose();
    }

    private void TryAction(Action action)
    {
        try
        {
            action();
        }
        catch (ObjectDisposedException error)
        {
            ShowToast(error.Message);
        }
        catch (InvalidOperationException error)
        {
            ShowToast(error.Message);
        }
        catch (Win32Exception error)
        {
            ShowToast(error.Message);
        }
        catch (UnauthorizedAccessException error)
        {
            ShowToast(error.Message);
        }
    }

    private void RenderTrayFallback(Exception error)
    {
        _trayAvailable = false;
        _trayService.Dispose();
        ShowToast($"Tray controls are unavailable: {error.Message}");
    }

    private void RenderWebViewRecovery(Exception error, DesktopRuntimeObservation observation)
    {
        _startupDiagnostics?.RecordPhase("webview-failed", error);
        _webViewReady = false;
        _webViewInitializationTask = null;
        // The initializer catches internally, so it must fence its own UI write
        // before the outer ShowReady continuation has a chance to recheck.
        if (!_runtimeLifecycle.IsCurrent(observation)) return;
        _deferredRoutes.MarkUnavailable();
        RenderRecovery($"WebView2 initialization failed: {error.Message}");
    }

    private void RenderRuntimeRecovery(Exception error, DesktopRuntimeObservation observation)
    {
        if (!_runtimeLifecycle.IsCurrent(observation)) return;
        _startupDiagnostics?.RecordPhase("runtime-failed", error);
        _deferredRoutes.MarkUnavailable();
        RenderRecovery(error.Message);
    }

    private void RenderRuntimeStatusFailure(Exception error, bool notify, bool syncShell, DesktopRuntimeObservation observation)
    {
        if (!_runtimeLifecycle.IsCurrent(observation)) return;
        if (notify)
        {
            ShowToast(error.Message);
        }

        if (syncShell)
        {
            _deferredRoutes.MarkUnavailable();
            RenderRecovery($"Runtime status check failed: {error.Message}");
        }
    }

    private void RetryButton_Click(object sender, RoutedEventArgs e) => _ = LaunchRuntimeAsync();
    private void OpenBrowserButton_Click(object sender, RoutedEventArgs e) => OpenBrowserFallback();
    private void OpenLogsButton_Click(object sender, RoutedEventArgs e) => OpenLogs();
    private void OpenFolderButton_Click(object sender, RoutedEventArgs e) => OpenInstallFolder();
}
