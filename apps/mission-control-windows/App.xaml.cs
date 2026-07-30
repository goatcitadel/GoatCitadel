using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.UI.Xaml;

namespace GoatCitadel.MissionControl.Windows;

public partial class App : Application
{
    private MainWindow? _window;

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        ActivationService.RegisterWindow(
            route => _window.DispatcherQueue.TryEnqueue(() => _window.OpenRoutePath(route)),
            () => _window.DispatcherQueue.TryEnqueue(_window.ShowAndFocus),
            diagnostic => _window.DispatcherQueue.TryEnqueue(() => _window.ShowActivationDiagnostic(diagnostic)));
        _window.Activate();
        ActivationService.FlushPendingActivation();
    }
}
