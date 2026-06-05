using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace GoatCitadel.MissionControl.Windows;

public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();

        var currentInstance = AppInstance.GetCurrent();
        var mainInstance = AppInstance.FindOrRegisterForKey("main");
        var activationArgs = currentInstance.GetActivatedEventArgs();

        if (!mainInstance.IsCurrent)
        {
            mainInstance.RedirectActivationToAsync(activationArgs).AsTask().GetAwaiter().GetResult();
            return;
        }

        ActivationService.SetInitialActivationArguments(activationArgs);
        mainInstance.Activated += (_, eventArgs) => ActivationService.HandleActivation(eventArgs);

        Application.Start(_ =>
        {
            var dispatcherQueue = DispatcherQueue.GetForCurrentThread();
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(dispatcherQueue));
            new App();
        });
    }
}
