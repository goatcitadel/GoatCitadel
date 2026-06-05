using System.Runtime.InteropServices;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class TrayActions
{
    public required Action OpenMissionControl { get; init; }
    public required Action OpenInBrowser { get; init; }
    public required Action RuntimeStatus { get; init; }
    public required Action RestartRuntime { get; init; }
    public required Action StopRuntime { get; init; }
    public required Action OpenLogs { get; init; }
    public required Action OpenInstallFolder { get; init; }
    public required Action Quit { get; init; }
}

public sealed class TrayService : IDisposable
{
    private const uint WM_APP = 0x8000;
    private const uint WM_COMMAND = 0x0111;
    private const uint WM_NULL = 0x0000;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_RBUTTONUP = 0x0205;
    private const uint WM_TRAY = WM_APP + 73;
    private const uint NIF_MESSAGE = 0x00000001;
    private const uint NIF_ICON = 0x00000002;
    private const uint NIF_TIP = 0x00000004;
    private const uint NIM_ADD = 0x00000000;
    private const uint NIM_DELETE = 0x00000002;
    private const uint MF_STRING = 0x00000000;
    private const uint MF_SEPARATOR = 0x00000800;
    private const uint TPM_RIGHTBUTTON = 0x0002;
    private static readonly IntPtr IDI_APPLICATION = new(32512);

    private readonly string _className = $"GoatCitadelMissionControlTray{Guid.NewGuid():N}";
    private readonly WndProc _wndProc;
    private readonly Dictionary<int, Action> _menuActions = new();
    private IntPtr _hwnd;
    private bool _registered;

    public TrayService()
    {
        _wndProc = HandleMessage;
    }

    public void Initialize(TrayActions actions)
    {
        _menuActions[1001] = actions.OpenMissionControl;
        _menuActions[1002] = actions.OpenInBrowser;
        _menuActions[1003] = actions.RuntimeStatus;
        _menuActions[1004] = actions.RestartRuntime;
        _menuActions[1005] = actions.StopRuntime;
        _menuActions[1006] = actions.OpenLogs;
        _menuActions[1007] = actions.OpenInstallFolder;
        _menuActions[1008] = actions.Quit;

        RegisterWindowClass();
        _hwnd = CreateWindowEx(
            0,
            _className,
            "GoatCitadel Mission Control Tray",
            0,
            0,
            0,
            0,
            0,
            IntPtr.Zero,
            IntPtr.Zero,
            GetModuleHandle(null),
            IntPtr.Zero);
        if (_hwnd == IntPtr.Zero)
        {
            throw new InvalidOperationException("Unable to create GoatCitadel tray message window.");
        }

        var icon = LoadIcon(IntPtr.Zero, IDI_APPLICATION);
        var data = CreateNotifyIconData(icon);
        if (!Shell_NotifyIcon(NIM_ADD, ref data))
        {
            DestroyWindow(_hwnd);
            _hwnd = IntPtr.Zero;
            throw new InvalidOperationException("Unable to add GoatCitadel tray icon.");
        }

        _registered = true;
    }

    public void Dispose()
    {
        if (_registered)
        {
            var data = CreateNotifyIconData(IntPtr.Zero);
            Shell_NotifyIcon(NIM_DELETE, ref data);
            _registered = false;
        }

        if (_hwnd != IntPtr.Zero)
        {
            DestroyWindow(_hwnd);
            _hwnd = IntPtr.Zero;
        }
    }

    private IntPtr HandleMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == WM_TRAY)
        {
            var eventCode = (uint)lParam.ToInt64();
            if (eventCode == WM_LBUTTONUP)
            {
                InvokeMenuAction(1001);
                return IntPtr.Zero;
            }

            if (eventCode == WM_RBUTTONUP)
            {
                ShowContextMenu();
                return IntPtr.Zero;
            }
        }

        if (message == WM_COMMAND)
        {
            InvokeMenuAction(wParam.ToInt32() & 0xffff);
            return IntPtr.Zero;
        }

        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    private void InvokeMenuAction(int id)
    {
        if (_menuActions.TryGetValue(id, out var action))
        {
            action();
        }
    }

    private void ShowContextMenu()
    {
        var menu = CreatePopupMenu();
        if (menu == IntPtr.Zero)
        {
            return;
        }

        try
        {
            AppendMenu(menu, MF_STRING, 1001, "Open Mission Control");
            AppendMenu(menu, MF_STRING, 1002, "Open in Browser");
            AppendMenu(menu, MF_STRING, 1003, "Runtime Status");
            AppendMenu(menu, MF_SEPARATOR, 0, null);
            AppendMenu(menu, MF_STRING, 1004, "Restart Runtime");
            AppendMenu(menu, MF_STRING, 1005, "Stop Runtime");
            AppendMenu(menu, MF_SEPARATOR, 0, null);
            AppendMenu(menu, MF_STRING, 1006, "Open Logs");
            AppendMenu(menu, MF_STRING, 1007, "Open Install Folder");
            AppendMenu(menu, MF_SEPARATOR, 0, null);
            AppendMenu(menu, MF_STRING, 1008, "Quit");

            GetCursorPos(out var point);
            SetForegroundWindow(_hwnd);
            TrackPopupMenuEx(menu, TPM_RIGHTBUTTON, point.X, point.Y, _hwnd, IntPtr.Zero);
            PostMessage(_hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    private void RegisterWindowClass()
    {
        var windowClass = new WndClassEx
        {
            cbSize = (uint)Marshal.SizeOf<WndClassEx>(),
            lpfnWndProc = _wndProc,
            hInstance = GetModuleHandle(null),
            lpszClassName = _className,
        };

        if (RegisterClassEx(ref windowClass) == 0)
        {
            throw new InvalidOperationException("Unable to register GoatCitadel tray message window class.");
        }
    }

    private NotifyIconData CreateNotifyIconData(IntPtr icon) =>
        new()
        {
            cbSize = (uint)Marshal.SizeOf<NotifyIconData>(),
            hWnd = _hwnd,
            uID = 1,
            uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP,
            uCallbackMessage = WM_TRAY,
            hIcon = icon,
            szTip = "GoatCitadel Mission Control",
        };

    private delegate IntPtr WndProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClassEx
    {
        public uint cbSize;
        public uint style;
        public WndProc lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szTip;

        public uint dwState;
        public uint dwStateMask;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;

        public uint uVersion;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;

        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern ushort RegisterClassEx(ref WndClassEx lpwcx);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(
        uint dwExStyle,
        string lpClassName,
        string lpWindowName,
        uint dwStyle,
        int x,
        int y,
        int nWidth,
        int nHeight,
        IntPtr hWndParent,
        IntPtr hMenu,
        IntPtr hInstance,
        IntPtr lpParam);

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr LoadIcon(IntPtr hInstance, IntPtr lpIconName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool AppendMenu(IntPtr hMenu, uint uFlags, nuint uIDNewItem, string? lpNewItem);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyMenu(IntPtr hMenu);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out Point lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool TrackPopupMenuEx(IntPtr hMenu, uint uFlags, int x, int y, IntPtr hWnd, IntPtr lptpm);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Shell_NotifyIcon(uint dwMessage, ref NotifyIconData lpData);
}
