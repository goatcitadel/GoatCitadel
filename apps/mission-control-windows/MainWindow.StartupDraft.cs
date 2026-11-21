using System.Text.Json;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;

namespace GoatCitadel.MissionControl.Windows;

public sealed partial class MainWindow
{
    private readonly StartupDraftHandoff _startupDraft = new();
    private bool _startupDraftEnabled;
    private bool _startupDraftComposing;
    private bool _startupDraftInputRecorded;
    private bool _startupDraftWaiting;
    private bool _startupDraftReachedChat;
    private DispatcherQueueTimer? _startupDraftTimer;

    private void InitializeStartupDraft()
    {
        _startupDraftEnabled = Environment.GetEnvironmentVariable("GOATCITADEL_NATIVE_CHAT_DRAFT") == "1";
        if (!_startupDraftEnabled) return;
        StartupDraftBox.TextCompositionStarted += (_, _) => _startupDraftComposing = true;
        StartupDraftBox.TextCompositionEnded += (_, _) =>
        {
            _startupDraftComposing = false;
            TryOfferStartupDraft();
            RenderStartupDraft();
        };
        StartupDraftBox.TextChanged += (_, _) =>
        {
            if (StartupDraftBox.Text.Length > 0 && !_startupDraftInputRecorded)
            {
                _startupDraftInputRecorded = true;
                _startupDiagnostics?.RecordStartupDraft("first-input");
            }
            RenderStartupDraft();
        };
        StartupDraftPanel.Visibility = Visibility.Visible;
        StartupDraftBox.Loaded += (_, _) =>
        {
            if (StartupDraftPanel.Visibility == Visibility.Visible)
            {
                StartupDraftBox.Focus(FocusState.Programmatic);
                _startupDiagnostics?.RecordStartupDraft("input-ready");
            }
        };
    }

    private void ResetStartupDraftDestination(bool clearText = false)
    {
        if (!_startupDraftEnabled) return;
        _startupDraft.Invalidate();
        EndStartupDraftWait();
        if (clearText)
        {
            _startupDraft.Reset();
            _startupDraftReachedChat = false;
            StartupDraftBox.Text = "";
            _startupDraftComposing = false;
        }
        RenderStartupDraft();
    }

    private void EndStartupDraftWait()
    {
        _startupDraftTimer?.Stop();
        _startupDraftWaiting = false;
        StartupDraftBox.IsReadOnly = _startupDraft.Pending is not null;
    }

    private void RenderStartupDraft()
    {
        var ready = _startupDraft.Ready;
        var hasText = StartupDraftBox.Text.Length != 0;
        StartupDraftPanel.Visibility = hasText || _startupDraftComposing || !_startupDraftReachedChat
            ? Visibility.Visible : Visibility.Collapsed;
        StartupDraftStatus.Text = _startupDraftWaiting ? "Moving draft to Chat…"
            : _startupDraft.Pending is not null ? "Chat hasn’t confirmed the transfer. Retry when ready."
            : ready is null ? "Your draft stays here until Chat is ready."
            : $"Append to {ready.Label}. Any text already in Chat will be kept.";
        StartupDraftInsert.Content = _startupDraft.Pending is not null ? "Retry handoff" : "Append to Chat";
        StartupDraftInsert.IsEnabled = !_startupDraftWaiting && ready is not null
            && !_startupDraftComposing && !string.IsNullOrWhiteSpace(StartupDraftBox.Text);
        StartupDraftDiscard.IsEnabled = hasText && !_startupDraftWaiting;
    }

    private void StartupDraftInsert_Click(object sender, RoutedEventArgs args) => TryOfferStartupDraft(append: true);

    private void StartupDraftDiscard_Click(object sender, RoutedEventArgs args)
    {
        _startupDraft.Invalidate();
        EndStartupDraftWait();
        StartupDraftBox.Text = "";
        if (MissionWebView.Visibility == Visibility.Visible) StartupDraftPanel.Visibility = Visibility.Collapsed;
    }

    private void TryOfferStartupDraft(bool append = false)
    {
        if (!_startupDraftEnabled || _startupDraftComposing || _startupDraftWaiting || _profileRecoveryChanging
            || MissionWebView.CoreWebView2 is not { } core
            || !StartupDraftHandoff.IsExpectedOrigin(core.Source, core.Source, _lastRuntime?.UiUrl)) return;
        var transfer = _startupDraft.Offer(StartupDraftBox.Text, append,
            append || StartupDraftBox.FocusState != FocusState.Unfocused);
        if (transfer is null) return;

        _startupDraftWaiting = true;
        StartupDraftBox.IsReadOnly = true;
        _startupDraftTimer ??= CreateStartupDraftTimer();
        _startupDraftTimer.Start();
        RenderStartupDraft();
        try
        {
            core.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = StartupDraftHandoff.MessageType,
                version = 1,
                action = "offer",
                origin = new Uri(core.Source).GetLeftPart(UriPartial.Authority),
                context = transfer.Destination.Context,
                offer = transfer.Id,
                text = transfer.Text,
                append = transfer.Append,
                focus = transfer.Focus,
            }));
            _startupDiagnostics?.RecordStartupDraft("offer-posted");
        }
        catch (InvalidOperationException)
        {
            EndStartupDraftWait();
            RenderStartupDraft();
        }
    }

    private DispatcherQueueTimer CreateStartupDraftTimer()
    {
        var timer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(3);
        timer.IsRepeating = false;
        timer.Tick += (_, _) =>
        {
            EndStartupDraftWait();
            RenderStartupDraft();
        };
        return timer;
    }

    private bool TryHandleStartupDraft(CoreWebView2 sender, string source, JsonElement message)
    {
        if (message.ValueKind != JsonValueKind.Object || !message.TryGetProperty("type", out var type)
            || type.ValueKind != JsonValueKind.String || type.GetString() != StartupDraftHandoff.MessageType)
            return false;
        if (!_startupDraftEnabled || _profileRecoveryChanging || _lastRuntime?.IsReady != true
            || !StartupDraftHandoff.IsExpectedOrigin(source, sender.Source, _lastRuntime?.UiUrl)
            || !message.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out var number) || number != 1
            || !StartupDraftHandoff.TryId(message, "context", out var context)
            || !message.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String)
            return true;

        if (action.GetString() == "ready" && message.TryGetProperty("label", out var label)
            && label.ValueKind == JsonValueKind.String && label.GetString() is { Length: > 0 and <= 120 } destination
            && message.TryGetProperty("automatic", out var automatic)
            && automatic.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            if (_startupDraft.Ready?.Context != context)
            {
                _startupDraft.Invalidate();
                EndStartupDraftWait();
            }
            _startupDraft.SetReady(new(context, destination, automatic.GetBoolean()));
            _startupDraftReachedChat = true;
            _startupDiagnostics?.RecordStartupDraft("web-ready");
            if (automatic.GetBoolean()) _startupDiagnostics?.RecordStartupDraft("automatic-ready");
            TryOfferStartupDraft();
        }
        else if (action.GetString() == "unavailable" && _startupDraft.Ready?.Context == context)
        {
            ResetStartupDraftDestination();
        }
        else if (action.GetString() == "ack" && StartupDraftHandoff.TryId(message, "offer", out var offer)
            && message.TryGetProperty("outcome", out var outcome) && outcome.ValueKind == JsonValueKind.String)
        {
            if (_startupDraft.Acknowledge(context, offer, outcome.GetString()))
            {
                _startupDiagnostics?.RecordStartupDraft("handoff-applied");
                if (StartupDraftBox.FocusState != FocusState.Unfocused)
                    MissionWebView.Focus(FocusState.Programmatic);
                StartupDraftBox.Text = "";
            }
            if (_startupDraft.Pending is null) EndStartupDraftWait();
        }
        RenderStartupDraft();
        return true;
    }
}
