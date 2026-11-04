namespace GoatCitadel.MissionControl.Windows.Services;

/// <summary>Fences desktop observations and cancels task-owned reads across runtime transitions.</summary>
public sealed class DesktopRuntimeLifecycle : IDisposable
{
    private long _generation;
    private CancellationTokenSource _changes = new();
    private bool _disposed;
    private bool _stopPending;

    public bool TryCaptureStatus(out DesktopRuntimeObservation observation)
    {
        if (_disposed || _stopPending)
        {
            observation = default;
            return false;
        }
        observation = new(_generation, _changes.Token);
        return true;
    }

    public DesktopRuntimeObservation BeginTransition() => Advance(stopPending: false);

    public DesktopRuntimeObservation BeginStop() => Advance(stopPending: true);

    public bool TryCompleteStop(DesktopRuntimeObservation observation)
    {
        if (!_stopPending || !IsCurrent(observation)) return false;
        Advance(stopPending: false);
        return true;
    }

    private DesktopRuntimeObservation Advance(bool stopPending)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _stopPending = stopPending;
        _generation++;
        _changes.Cancel();
        _changes.Dispose();
        _changes = new();
        return new(_generation, _changes.Token);
    }

    public bool IsCurrent(DesktopRuntimeObservation observation) =>
        !_disposed && observation.Generation == _generation && !observation.Token.IsCancellationRequested;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _changes.Cancel();
        _changes.Dispose();
    }
}

public readonly record struct DesktopRuntimeObservation(long Generation, CancellationToken Token);