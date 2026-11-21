using System.ComponentModel;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace GoatCitadel.MissionControl.Windows;

public sealed partial class MainWindow
{
    private static readonly JsonSerializerOptions ProfileRecoveryJson = new(JsonSerializerDefaults.Web);
    private readonly string? _profileInstallRoot;
    private readonly string? _configuredWebViewDataFolder = Environment.GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER");
    private string? _webViewDataFolder;
    private bool _profileRecoveryOpen;
    private bool _profileRecoveryChanging;

    private string? ResolveProfileInstallRoot()
    {
        try
        {
            var launcher = _launcherService.ResolveLauncher();
            var app = Path.Join(launcher.InstallRoot, "app");
            var selectedApp = launcher.AppDir;
            if ((!string.IsNullOrWhiteSpace(selectedApp) && !string.Equals(
                    Path.TrimEndingDirectorySeparator(Path.GetFullPath(selectedApp)), app, StringComparison.OrdinalIgnoreCase))
                || !File.Exists(Path.Join(app, "release-manifest.json"))
                || !File.Exists(Path.Join(app, "gateway", "dist", "main.js"))
                || !File.Exists(Path.Join(app, "runtime", "ui-static-server.mjs"))) return null;
            return launcher.InstallRoot;
        }
        catch (Exception error) when (IsProfileRecoveryError(error))
        {
            return null;
        }
    }

    private string ResolveWebViewDataFolder(out bool isScoped)
    {
        isScoped = false;
        if (_profileInstallRoot is not null)
        {
            var marker = new FileInfo(Path.Join(_profileInstallRoot, "runtime-root", ".desktop-profile-id"));
            if (marker.Exists)
            {
                if ((marker.Attributes & FileAttributes.ReparsePoint) != 0 || marker.Length != 36)
                    throw new IOException("The installed desktop profile identifier is invalid.");
                var id = File.ReadAllText(marker.FullName);
                if (!Guid.TryParseExact(id, "D", out var profileId) || id != profileId.ToString("D"))
                    throw new IOException("The installed desktop profile identifier is invalid.");
                var folder = Path.Join(_profileInstallRoot, "profile-recovery", "browser", id);
                for (var current = folder; !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
                {
                    if (Directory.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                        throw new IOException("Desktop profile storage needs a regular folder.");
                }
                isScoped = true;
                return folder;
            }
        }
        return string.IsNullOrWhiteSpace(_configuredWebViewDataFolder)
            ? Path.Join(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GoatCitadel", "WebView2")
            : Path.GetFullPath(_configuredWebViewDataFolder);
    }

    private void ReplaceWebView()
    {
        ResetStartupDraftDestination();
        var layout = (Grid)Content;
        var oldView = MissionWebView;
        var index = layout.Children.IndexOf(oldView);
        if (oldView.CoreWebView2 is { } core && _webMessageReceived is { } handler)
            core.WebMessageReceived -= handler;
        _webMessageReceived = null;
        MissionWebView = new WebView2
        {
            Visibility = Visibility.Collapsed,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
        };
        oldView.Close();
        layout.Children.Remove(oldView);
        layout.Children.Insert(index, MissionWebView);
        _webViewDataFolder = null;
        _webViewReady = false;
        _webViewNavigationSucceeded = false;
        _webViewInitializationTask = null;
    }

    private void ProfileRecoveryButton_Click(object sender, RoutedEventArgs e) => _ = ShowProfileRecoveryAsync();

    private async Task ShowProfileRecoveryAsync()
    {
        if (_profileInstallRoot is null || _profileRecoveryOpen || _updateDialog is not null || _cleanedUp) return;
        ShowAndFocus();
        _profileRecoveryOpen = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var reply = await _launcherService.RunAsync(new[] { "desktop-profile", "list" }, timeout.Token);
            var history = JsonSerializer.Deserialize<ProfileBackupHistory>(reply, ProfileRecoveryJson)
                ?? throw new InvalidOperationException("Try again after the local runtime finishes starting or stopping.");
            if (_cleanedUp) return;
            var content = new StackPanel { Spacing = 12 };
            content.Children.Add(ProfileDialogText("Start over with first-run setup for this Windows install. Your current settings, local data, and desktop session are saved before every reset or restore."));
            content.Children.Add(ProfileDialogText($"GoatCitadel keeps the latest {history.Limit} backups. A new reset can replace the oldest backup."));
            var backups = new ComboBox
            {
                Header = "Backup to restore", HorizontalAlignment = HorizontalAlignment.Stretch,
                ItemsSource = history.Backups.Select(backup => backup.Label).ToArray(), SelectedIndex = 0,
            };
            if (history.Backups.Length > 0) content.Children.Add(backups);
            else content.Children.Add(ProfileDialogText("Your first backup will appear here after a reset."));
            if (history.UnavailableReason is not null) content.Children.Add(ProfileDialogText(history.UnavailableReason));

            var dialog = new ContentDialog
            {
                XamlRoot = Content.XamlRoot, Title = "Reset and restore", Content = content,
                PrimaryButtonText = "Reset to fresh install…", SecondaryButtonText = "Restore…", CloseButtonText = "Close",
                DefaultButton = ContentDialogButton.Close,
                IsPrimaryButtonEnabled = history.UnavailableReason is null,
                IsSecondaryButtonEnabled = history.UnavailableReason is null && history.Backups.Length > 0,
            };
            backups.SelectionChanged += (_, _) => dialog.IsSecondaryButtonEnabled =
                history.UnavailableReason is null && backups.SelectedIndex >= 0;
            var result = await dialog.ShowAsync();
            if (result == ContentDialogResult.Primary) await ConfirmProfileChangeAsync(null);
            var index = backups.SelectedIndex;
            if (result == ContentDialogResult.Secondary && index >= 0)
                await ConfirmProfileChangeAsync(history.Backups[index]);
        }
        catch (Exception error) when (IsProfileRecoveryError(error))
        {
            if (!_cleanedUp) ShowToast("Couldn't open Reset and restore. " + ProfileErrorMessage(error));
        }
        finally
        {
            _profileRecoveryOpen = false;
        }
    }

    private async Task ConfirmProfileChangeAsync(ProfileBackup? backup)
    {
        var phrase = backup is null ? "RESET" : "RESTORE";
        var input = new TextBox { Header = $"Type {phrase} to confirm", IsSpellCheckEnabled = false };
        var content = new StackPanel { Spacing = 12 };
        content.Children.Add(ProfileDialogText(backup is null
            ? "GoatCitadel will save this profile, interrupt any work in progress, and reopen first-run setup."
            : $"GoatCitadel will save this profile and restart with the backup from {backup.CreatedAt.LocalDateTime:g}, including its connected accounts and schedules."));
        content.Children.Add(input);
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = backup is null ? "Reset to fresh install?" : "Restore this backup?",
            Content = content, PrimaryButtonText = backup is null ? "Reset and restart" : "Restore and restart",
            CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close, IsPrimaryButtonEnabled = false,
        };
        input.TextChanged += (_, _) => dialog.IsPrimaryButtonEnabled = MatchesConfirmation();
        if (await dialog.ShowAsync() == ContentDialogResult.Primary && MatchesConfirmation() && !_cleanedUp)
            await SwitchProfileAsync(backup);

        bool MatchesConfirmation() => string.Equals(input.Text.Trim(), phrase, StringComparison.OrdinalIgnoreCase);
    }

    private async Task SwitchProfileAsync(ProfileBackup? backup)
    {
        _profileRecoveryChanging = true;
        ResetStartupDraftDestination(clearText: true);
        StartupDraftBox.IsEnabled = false;
        var observation = _runtimeLifecycle.BeginStop();
        _deferredRoutes.MarkUnavailable();
        StopRuntimeStatusPolling();
        StopStartingTimer();
        StopEventStream();
        RenderStarting();
        StatusCopy.Text = "Saving the current profile and switching…";
        ProfileRecoveryButton.IsEnabled = false;
        string message;
        try
        {
            // Disconnect the outgoing browser before the same local endpoint starts
            // serving a different profile. A hidden WebView still runs JavaScript.
            if (_webViewInitializationTask is not null) await _webViewInitializationTask;
            ReplaceWebView();
            var args = backup is null ? new[] { "desktop-profile", "reset", "--confirmed" }
                : new[] { "desktop-profile", "restore", backup.Id, "--confirmed" };
            var reply = await _launcherService.RunAsync(args);
            var result = JsonSerializer.Deserialize<ProfileChangeResult>(reply, ProfileRecoveryJson)
                ?? throw new InvalidOperationException("Reopen Reset and restore to check your backups.");
            _lastRuntime = null;
            message = result.CleanupPending
                ? "Profile switched. Cleanup of an expired backup will retry after the next profile change."
                : "Profile switched. Your previous profile is available in Reset and restore.";
        }
        catch (Exception error) when (IsProfileRecoveryError(error))
        {
            message = "Couldn't finish switching profiles. " + ProfileErrorMessage(error);
        }
        finally
        {
            _runtimeLifecycle.TryCompleteStop(observation);
            _profileRecoveryChanging = false;
            StartupDraftBox.IsEnabled = true;
            ProfileRecoveryButton.IsEnabled = true;
        }
        if (_cleanedUp) return;
        await LaunchRuntimeAsync();
        if (!_cleanedUp) ShowToast(message);
    }

    private static TextBlock ProfileDialogText(string text) => new() { Text = text, TextWrapping = TextWrapping.Wrap };

    private static bool IsProfileRecoveryError(Exception error) => error is InvalidOperationException or IOException
        or UnauthorizedAccessException or Win32Exception or OperationCanceledException or JsonException or ArgumentException;

    private static string ProfileErrorMessage(Exception error)
    {
        if (error is OperationCanceledException) return "Try again after the local runtime finishes starting or stopping.";
        const string launcherPrefix = "GoatCitadel launcher exited with 1: ";
        return error.Message.StartsWith(launcherPrefix, StringComparison.Ordinal)
            ? error.Message[launcherPrefix.Length..] : error.Message;
    }

    private sealed record ProfileBackupHistory(int Limit, ProfileBackup[] Backups, string? UnavailableReason);
    private sealed record ProfileBackup(string Id, DateTimeOffset CreatedAt, string Reason)
    {
        public string Label => $"{CreatedAt.LocalDateTime:g} · Before {Reason}";
    }
    private sealed record ProfileChangeResult(bool CleanupPending);
}
