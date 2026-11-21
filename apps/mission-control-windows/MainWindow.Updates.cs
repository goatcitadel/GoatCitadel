using System.Diagnostics;
using System.Text.Json;
using GoatCitadel.MissionControl.Windows.Models;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace GoatCitadel.MissionControl.Windows;

public sealed partial class MainWindow
{
    private DesktopUpdateService? _updates;
    private DispatcherQueueTimer? _updateTimer;
    private CancellationTokenSource? _updateCts;
    private TextBlock? _updateDialogText;
    private ContentDialog? _updateDialog;
    private DesktopUpdateStatus? _renderedUpdateStatus;
    private bool _installUpdatePending;

    private void InitializeUpdates()
    {
        try
        {
            var install = _launcherService.ResolveLauncher();
            if (!File.Exists(Path.Join(install.InstallRoot, "app", "release-manifest.json"))) return;
            _updates = new DesktopUpdateService(install.InstallRoot);
            _updateCts = new();
            _updates.Changed += status => DispatcherQueue.TryEnqueue(() =>
            {
                PublishUpdateStatus();
                RenderUpdateDialog(status);
            });
            _updates.Notification += release => DispatcherQueue.TryEnqueue(() =>
                _notificationService.ShowUpdateAvailable(release.Version));
            _updateTimer = DispatcherQueue.CreateTimer();
            // The service owns the 30-minute network deadline and rate-limit backoff.
            // Wake more often so a manual check cannot make a fixed timer skip the
            // next deadline and postpone discovery for nearly another 30 minutes.
            _updateTimer.Interval = TimeSpan.FromMinutes(1);
            _updateTimer.Tick += (_, _) => _ = _updates.CheckAsync(cancellationToken: _updateCts.Token);
            _updateTimer.Start();
            _ = _updates.CheckAsync(cancellationToken: _updateCts.Token);
            if (DesktopUpdateHandoff.TakeResult(install.InstallRoot) is { } result)
                ShowToast(result);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            ShowToast("Updates are unavailable: " + error.Message);
        }
    }

    private bool TryHandleUpdateMessage(string source, string json)
    {
        if (_updates is null) return false;
        var request = DesktopUpdatePolicy.ReadRequest(source, _lastRuntime?.UiUrl, json);
        if (request is null) return false;
        _ = HandleUpdateActionAsync(request.Action, request.Channel, request.ReleaseTag, request.RequestId);
        return true;
    }

    private async Task HandleUpdateActionAsync(string action, string? channel = null, string? tag = null, string? requestId = null)
    {
        if (_updates is null) return;
        string? actionError = null;
        try
        {
            var token = _updateCts?.Token ?? CancellationToken.None;
            switch (action)
            {
                case "status": break;
                case "check": await _updates.CheckAsync(true, token); break;
                case "channel": await _updates.SetChannelAsync(channel ?? "", token); break;
                case "snooze": await _updates.SnoozeAsync(token); break;
                case "download": await _updates.DownloadAsync(tag ?? "", token); break;
                case "install": await UpdateAndRestartAsync(tag, requestId is not null, token); break;
                case "reveal":
                    var file = await _updates.GetVerifiedDownloadAsync(token);
                    var explorer = new ProcessStartInfo(Path.Join(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"))
                    { UseShellExecute = false };
                    explorer.ArgumentList.Add("/select,");
                    explorer.ArgumentList.Add(file);
                    Process.Start(explorer);
                    break;
                case "notes":
                    var release = _updates.Status.AvailableRelease;
                    if (release is not null)
                        Process.Start(new ProcessStartInfo("https://github.com/" + DesktopUpdatePolicy.Repository
                            + "/releases/tag/" + Uri.EscapeDataString(release.Tag)) { UseShellExecute = true });
                    break;
                default: return;
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException
            or InvalidOperationException or OperationCanceledException or System.ComponentModel.Win32Exception)
        {
            actionError = error.Message;
            ShowToast("Update action failed: " + error.Message);
        }
        finally { PublishUpdateStatus(requestId, actionError); }
    }

    private async Task UpdateAndRestartAsync(string? tag, bool confirmInNativeHost, CancellationToken token)
    {
        if (_installUpdatePending || _profileRecoveryOpen || (confirmInNativeHost && _updateDialog is not null))
            throw new InvalidOperationException("Close the other desktop dialog and try again.");
        var release = _updates!.Status.AvailableRelease;
        if (release is null || release.Tag != tag || _updates.Status.Phase != "downloaded")
            throw new InvalidOperationException("The offered update changed. Check for updates and try again.");

        _installUpdatePending = true;
        RenderUpdateDialog(_updates.Status);
        try
        {
            if (confirmInNativeHost)
            {
                var confirmation = new ContentDialog
                {
                    XamlRoot = Content.XamlRoot,
                    Title = $"Update to GoatCitadel {release.Version}?",
                    Content = (release.PublisherSigned ? "" : "This preview is unsigned. ")
                        + "Save your work first. GoatCitadel and its local runtime will stop, then the app will reopen.",
                    PrimaryButtonText = "Update and restart",
                    CloseButtonText = "Cancel",
                    DefaultButton = ContentDialogButton.Close,
                };
                if (await confirmation.ShowAsync() != ContentDialogResult.Primary) return;
            }

            var root = DesktopUpdateHandoff.ValidateInstalledHost(
                _launcherService.ResolveLauncher().InstallRoot, Environment.ProcessPath);
            await _updates.GetVerifiedDownloadAsync(token);
            var restartRuntimeOnHandoffFailure = _lastRuntime?.IsReady == true;
            if (!await StopRuntimeAsync())
                throw new InvalidOperationException("The local runtime could not stop. The update was not started.");
            try
            {
                await _updates.LaunchVerifiedDownloadAsync(release,
                    file => DesktopUpdateHandoff.Begin(root, file, release), token);
                if (!DispatcherQueue.TryEnqueue(Quit))
                    throw new InvalidOperationException("GoatCitadel could not schedule its update shutdown.");
            }
            catch
            {
                if (restartRuntimeOnHandoffFailure) await LaunchRuntimeAsync();
                throw;
            }
        }
        finally
        {
            _installUpdatePending = false;
            RenderUpdateDialog(_updates.Status);
        }
    }

    private void PublishUpdateStatus(string? requestId = null, string? error = null)
    {
        if (_updates is null || !_webViewReady
            || !DesktopUpdatePolicy.IsExpectedOrigin(MissionWebView.Source?.ToString(), _lastRuntime?.UiUrl)) return;
        MissionWebView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            type = "goatcitadel.updates.status", requestId, error, status = _updates.Status,
        }, DesktopUpdatePolicy.Json));
    }

    private async Task ShowUpdatesAsync()
    {
        ShowAndFocus();
        if (_updates is null) { ShowToast("Update checks are available in an installed Windows app."); return; }
        if (_updateDialog is not null || _profileRecoveryOpen || _installUpdatePending) return;
        var channel = new ComboBox { Header = "Update channel", ItemsSource = new[] { "stable", "preview" },
            SelectedItem = _updates.Status.Channel, HorizontalAlignment = HorizontalAlignment.Stretch };
        channel.SelectionChanged += (_, _) => _ = HandleUpdateActionAsync("channel", channel.SelectedItem as string);
        _updateDialogText = new TextBlock { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        var check = new Button { Content = "Check for updates" };
        check.Click += (_, _) => _ = HandleUpdateActionAsync("check");
        var notes = new Button { Content = "View release notes" };
        notes.Click += (_, _) => _ = HandleUpdateActionAsync("notes");
        var later = new Button { Content = "Remind me tomorrow" };
        later.Click += (_, _) => _ = HandleUpdateActionAsync("snooze");
        var stack = new StackPanel { Spacing = 12 };
        stack.Children.Add(channel);
        stack.Children.Add(_updateDialogText);
        stack.Children.Add(check);
        stack.Children.Add(notes);
        stack.Children.Add(later);
        _updateDialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = "GoatCitadel updates",
            Content = stack, PrimaryButtonText = "Download", SecondaryButtonText = "Show installer",
            CloseButtonText = "Close",
        };
        _updateDialog.PrimaryButtonClick += (sender, args) =>
        {
            args.Cancel = true;
            var status = _renderedUpdateStatus;
            if (status is null) return;
            _ = HandleUpdateActionAsync(status.Phase == "downloaded" ? "install" : "download",
                tag: status.AvailableRelease?.Tag);
        };
        _updateDialog.SecondaryButtonClick += (sender, args) => { args.Cancel = true; _ = HandleUpdateActionAsync("reveal"); };
        RenderUpdateDialog(_updates.Status);
        _ = HandleUpdateActionAsync("check");
        try { await _updateDialog.ShowAsync(); }
        finally { _updateDialog = null; _updateDialogText = null; _renderedUpdateStatus = null; }
    }

    private void RenderUpdateDialog(DesktopUpdateStatus status)
    {
        if (_updateDialog is null || _updateDialogText is null) return;
        _renderedUpdateStatus = status;
        var offered = status.AvailableRelease;
        _updateDialogText.Text = $"Installed: {status.InstalledVersion}\n"
            + (offered is null ? "" : $"Available: {offered.Version}\n")
            + status.Message
            + (offered is { PublisherSigned: false } ? "\nThis preview is unsigned." : "")
            + (status.Phase == "downloading" ? $"\n{status.DownloadedBytes / 1048576} MB downloaded" : "");
        _updateDialog.PrimaryButtonText = status.Phase == "downloaded" ? "Update and restart" : "Download";
        _updateDialog.IsPrimaryButtonEnabled = !_installUpdatePending && offered is not null
            && status.Phase is not ("checking" or "downloading");
        _updateDialog.IsSecondaryButtonEnabled = status.DownloadedPath is not null && status.Phase != "downloading";
    }

    private void StopUpdates()
    {
        _updateTimer?.Stop();
        _updateCts?.Cancel();
        _updates?.Dispose();
    }

    private void CheckUpdatesButton_Click(object sender, RoutedEventArgs e) => _ = ShowUpdatesAsync();
}
