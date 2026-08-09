using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class LauncherServiceTests
{
    private string? _root;

    [TestCleanup]
    public void Cleanup()
    {
        if (_root is not null && Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    [TestMethod]
    public void ResolvesPackagedNodeLauncherFromGoatcitadelHome()
    {
        var root = CreateTempRoot();
        var node = Touch(Path.Join(root, "app", "runtime", "node", "node.exe"));
        var script = Touch(Path.Join(root, "app", "bin", "goatcitadel.mjs"));
        Touch(Path.Join(root, "app", "release-manifest.json"));

        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?> { ["GOATCITADEL_HOME"] = root },
            currentExePath: Path.Join(root, "app", "desktop", "GoatCitadel-Mission-Control-Windows.exe")));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(node, invocation.Program);
        Assert.AreEqual(script, invocation.ArgsPrefix.Single());
        Assert.AreEqual(root, invocation.InstallRoot);
        Assert.IsFalse(invocation.WindowsShell);
    }

    [TestMethod]
    public void ResolvesExplicitCmdLauncherWithShellExecution()
    {
        var root = CreateTempRoot();
        var launcher = Touch(Path.Join(root, "bin", "goatcitadel.cmd"));
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>
            {
                ["GOATCITADEL_DESKTOP_LAUNCHER"] = launcher,
                ["GOATCITADEL_HOME"] = root,
            },
            currentExePath: Path.Join(root, "app.exe")));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(launcher, invocation.Program);
        Assert.AreEqual(root, invocation.InstallRoot);
        Assert.IsTrue(invocation.WindowsShell);
    }

    [TestMethod]
    public void ResolvesPackagedLauncherFromDesktopExeAncestors()
    {
        var root = CreateTempRoot();
        var node = Touch(Path.Join(root, "app", "runtime", "node", "node.exe"));
        var script = Touch(Path.Join(root, "app", "bin", "goatcitadel.mjs"));
        Touch(Path.Join(root, "app", "release-manifest.json"));
        var currentExe = Touch(Path.Join(root, "app", "desktop", "GoatCitadel-Mission-Control-Windows.exe"));
        var service = new LauncherService(new LauncherEnvironment(new Dictionary<string, string?>(), currentExe));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(node, invocation.Program);
        Assert.AreEqual(script, invocation.ArgsPrefix.Single());
        Assert.AreEqual(root, invocation.InstallRoot);
        Assert.IsFalse(invocation.WindowsShell);
    }

    [TestMethod]
    public void PreservesExplicitAppDirForPackagedNodeLauncher()
    {
        var root = CreateTempRoot();
        var appDir = Path.Join(root, "custom-app");
        var node = Touch(Path.Join(root, "app", "runtime", "node", "node.exe"));
        var script = Touch(Path.Join(root, "app", "bin", "goatcitadel.mjs"));
        Touch(Path.Join(root, "app", "release-manifest.json"));
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>
            {
                ["GOATCITADEL_HOME"] = root,
                ["GOATCITADEL_APP_DIR"] = appDir,
            },
            currentExePath: Path.Join(root, "app", "desktop", "GoatCitadel-Mission-Control-Windows.exe")));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(appDir, invocation.AppDir);
        Assert.AreEqual(node, invocation.Program);
        Assert.AreEqual(script, invocation.ArgsPrefix.Single());
        Assert.IsFalse(invocation.WindowsShell);
    }

    [TestMethod]
    public void ResolvesPackagedLauncherWithSeparateRuntimeHomeAndAppDir()
    {
        var root = CreateTempRoot();
        var runtimeHome = Path.Join(root, "isolated-runtime");
        var appDir = Path.Join(root, "installed-candidate", "app");
        Directory.CreateDirectory(runtimeHome);
        var node = Touch(Path.Join(appDir, "runtime", "node", "node.exe"));
        var script = Touch(Path.Join(appDir, "bin", "goatcitadel.mjs"));
        Touch(Path.Join(appDir, "release-manifest.json"));
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>
            {
                ["GOATCITADEL_HOME"] = runtimeHome,
                ["GOATCITADEL_APP_DIR"] = appDir,
            },
            currentExePath: Path.Join(appDir, "desktop", "GoatCitadel-Mission-Control-Windows.exe")));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual(node, invocation.Program);
        Assert.AreEqual(script, invocation.ArgsPrefix.Single());
        Assert.AreEqual(Path.GetFullPath(runtimeHome), invocation.InstallRoot);
        Assert.AreEqual(Path.GetFullPath(runtimeHome), invocation.WorkingDir);
        Assert.AreEqual(Path.GetFullPath(appDir), invocation.AppDir);
        Assert.IsFalse(invocation.WindowsShell);
    }

    [TestMethod]
    public void DoesNotResolvePackagedLauncherFromDesktopExeAncestorsWhenManifestMissing()
    {
        var root = CreateTempRoot();
        Touch(Path.Join(root, "app", "runtime", "node", "node.exe"));
        Touch(Path.Join(root, "app", "bin", "goatcitadel.mjs"));
        var currentExe = Touch(Path.Join(root, "app", "desktop", "GoatCitadel-Mission-Control-Windows.exe"));
        var service = new LauncherService(new LauncherEnvironment(new Dictionary<string, string?>(), currentExe));

        var error = Assert.ThrowsException<InvalidOperationException>(() => service.ResolveLauncher());
        StringAssert.Contains(error.Message, "Unable to locate GoatCitadel launcher");
    }

    [TestMethod]
    public void ResolvesSourceCheckoutLauncherFromCurrentExeAncestors()
    {
        var root = CreateTempRoot();
        var sourceLauncher = Touch(Path.Join(root, "bin", "goatcitadel.mjs"));
        Touch(Path.Join(root, "package.json"));
        var currentExe = Touch(Path.Join(root, "tools", "desktop", "host.exe"));
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>(),
            currentExePath: currentExe));

        var invocation = service.ResolveLauncher();

        Assert.AreEqual("node", invocation.Program);
        Assert.AreEqual(sourceLauncher, invocation.ArgsPrefix.Single());
        Assert.AreEqual(root, invocation.InstallRoot);
    }

    [TestMethod]
    public void MissingLauncherFailsWithOperatorReadableMessage()
    {
        var root = CreateTempRoot();
        var service = new LauncherService(new LauncherEnvironment(
            new Dictionary<string, string?>(),
            currentExePath: Path.Join(root, "host.exe")));

        var error = Assert.ThrowsException<InvalidOperationException>(() => service.ResolveLauncher());
        StringAssert.Contains(error.Message, "Unable to locate GoatCitadel launcher");
    }

    [TestMethod]
    public void QuotesWindowsCommandArgumentsWithShellMetacharacters()
    {
        Assert.AreEqual("plain", LauncherService.QuoteWindowsCommandArg("plain"));
        Assert.AreEqual("\"with space\"", LauncherService.QuoteWindowsCommandArg("with space"));
        Assert.AreEqual("\"a&b\"", LauncherService.QuoteWindowsCommandArg("a&b"));
        Assert.AreEqual("\"\"", LauncherService.QuoteWindowsCommandArg(""));
        Assert.ThrowsException<ArgumentException>(() => LauncherService.QuoteWindowsCommandArg("value\"quoted"));
        Assert.ThrowsException<ArgumentException>(() => LauncherService.QuoteWindowsCommandArg("%PATH%"));
        Assert.ThrowsException<ArgumentException>(() => LauncherService.QuoteWindowsCommandArg("line\nbreak"));
    }

    private string CreateTempRoot()
    {
        _root = Path.Join(Path.GetTempPath(), $"goatcitadel-windows-host-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_root);
        return _root;
    }

    private static string Touch(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "");
        return Path.GetFullPath(path);
    }
}
