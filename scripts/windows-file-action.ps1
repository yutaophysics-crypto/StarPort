# The request is base64 UTF-8 JSON on stdin, not executable PowerShell text.
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
if ($request.action -notin @('open', 'reveal', 'open-with', 'probe', 'open-folder')) { throw 'Unsupported file action' }
if ($request.action -eq 'open-folder') {
    if (-not [IO.Directory]::Exists($request.path)) { throw 'The folder no longer exists' }
} elseif (-not [IO.File]::Exists($request.path)) { throw 'The file no longer exists' }

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class StarportFileShell {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OPENASINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string File;
        [MarshalAs(UnmanagedType.LPWStr)] public string Class;
        public uint Flags;
    }
    [DllImport("ole32.dll")] static extern int CoInitialize(IntPtr reserved);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern IntPtr ILCreateFromPathW(string path);
    [DllImport("shell32.dll", ExactSpelling = true)]
    static extern int SHOpenWithDialog(IntPtr parent, ref OPENASINFO info);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern IntPtr ShellExecuteW(IntPtr parent, string verb, string file, string args, string directory, int show);
    static bool Check(int result) {
        if (result == unchecked((int)0x800704C7)) return false; // User canceled.
        Marshal.ThrowExceptionForHR(result);
        return true;
    }
    static bool OpenWith(string path) {
        var info = new OPENASINFO { File = path, Class = null, Flags = 4 }; // OAIF_EXEC
        return Check(SHOpenWithDialog(IntPtr.Zero, ref info));
    }
    public static bool Run(string action, string path) {
        int init = CoInitialize(IntPtr.Zero);
        Marshal.ThrowExceptionForHR(init);
        try {
            if (action == "probe") {
                IntPtr item = ILCreateFromPathW(path);
                if (item == IntPtr.Zero) throw new IOException("Windows could not locate the file");
                Marshal.FreeCoTaskMem(item);
                return true;
            }
            if (action == "reveal") {
                // Explorer reads the path itself. An item list built here and handed over by
                // SHOpenFolderAndSelectItems from this short-lived process could open the wrong
                // folder or none. A path cannot contain quotes, so quoting it is safe.
                string explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
                long shown = ShellExecuteW(IntPtr.Zero, "open", explorer, "/select,\"" + path + "\"", null, 1).ToInt64();
                if (shown > 32) return true;
                // Without the selection, the containing folder is still the useful place to land.
                long opened = ShellExecuteW(IntPtr.Zero, "open", Path.GetDirectoryName(path), null, null, 1).ToInt64();
                if (opened <= 32) throw new IOException("Windows could not show the file (" + shown + ")");
                return true;
            }
            if (action == "open-with") return OpenWith(path);
            if (action == "open-folder") {
                long opened = ShellExecuteW(IntPtr.Zero, "open", path, null, null, 1).ToInt64();
                if (opened <= 32) throw new IOException("Windows could not open the folder (" + opened + ")");
                return true;
            }
            long result = ShellExecuteW(IntPtr.Zero, "open", path, null, Path.GetDirectoryName(path), 1).ToInt64();
            if (result == 31) return OpenWith(path); // No registered default app.
            if (result <= 32) throw new IOException("Windows could not open the file (" + result + ")");
            return true;
        } finally { CoUninitialize(); }
    }
}
'@
$completed = [StarportFileShell]::Run($request.action, $request.path)
@{ ok = $true; canceled = -not $completed } | ConvertTo-Json -Compress
