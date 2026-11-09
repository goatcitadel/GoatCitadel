using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

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
        // The window registers its COM notification server before the SDK reads the
        // payload that Windows sends to that server on a notification cold start.
        ActivationService.SetInitialActivationArguments(AppInstance.GetCurrent().GetActivatedEventArgs());
        ActivationService.RegisterWindow(
            route => _window.DispatcherQueue.TryEnqueue(() => _window.OpenRoutePath(route)),
            () => _window.DispatcherQueue.TryEnqueue(_window.ShowAndFocus),
            diagnostic => _window.DispatcherQueue.TryEnqueue(() => _window.ShowActivationDiagnostic(diagnostic)));
        _window.Activate();
        ActivationService.FlushPendingActivation();
    }
}
