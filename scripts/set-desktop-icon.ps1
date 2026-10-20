# Replace only Starport's desktop shortcut icon, retaining all launcher properties.
# Windows notification: https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify
param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskIconPath = Join-Path $taskProjectRoot 'public\assets\starport-desktop-azure.ico'
$taskDesktopPath = [Environment]::GetFolderPath('Desktop')
$taskShortcutPath = Join-Path $taskDesktopPath 'Starport · 星港.lnk'
if (!(Test-Path -LiteralPath $taskShortcutPath -PathType Leaf)) { throw 'Starport desktop shortcut was not found' }
if (!(Test-Path -LiteralPath $taskIconPath -PathType Leaf)) { throw 'Starport icon was not found' }
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
$taskProperties = @('TargetPath','Arguments','WorkingDirectory','WindowStyle','Hotkey','Description')
$taskBefore = @{}
foreach ($taskProperty in $taskProperties) { $taskBefore[$taskProperty] = $taskShortcut.$taskProperty }
if (!$VerifyOnly) {
    $taskBackupDir = Join-Path $taskProjectRoot '.data\source-backups\desktop-icon-azure-20261012'
    New-Item -ItemType Directory -Path $taskBackupDir -Force | Out-Null
    $taskBackupPath = Join-Path $taskBackupDir ([IO.Path]::GetFileName($taskShortcutPath))
    if (!(Test-Path -LiteralPath $taskBackupPath)) { Copy-Item -LiteralPath $taskShortcutPath -Destination $taskBackupPath }
    $taskShortcut.IconLocation = "$taskIconPath,0"
    $taskShortcut.Save()
}
$taskAfter = $taskShell.CreateShortcut($taskShortcutPath)
foreach ($taskProperty in $taskProperties) { if ($taskAfter.$taskProperty -cne $taskBefore[$taskProperty]) { throw "Unexpected launcher change: $taskProperty" } }
if ($taskAfter.IconLocation -cne "$taskIconPath,0") { throw 'Shortcut does not reference the new icon' }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StarportDesktopIcon {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct FileInfo {
    public IntPtr hIcon;
    public int iIcon;
    public uint attributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string displayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string typeName;
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern void SHChangeNotify(int eventId, uint flags, string path, IntPtr unused);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  public static extern IntPtr SHGetFileInfoW(string path, uint attributes, out FileInfo info, uint size, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
}
'@
if (!$VerifyOnly) { [StarportDesktopIcon]::SHChangeNotify(0x2000, 0x5, $taskShortcutPath, [IntPtr]::Zero) }
$taskFileInfo = New-Object StarportDesktopIcon+FileInfo
$taskResult = [StarportDesktopIcon]::SHGetFileInfoW($taskShortcutPath, 0, [ref]$taskFileInfo, [Runtime.InteropServices.Marshal]::SizeOf($taskFileInfo), 0x100)
if ($taskResult -eq [IntPtr]::Zero -or $taskFileInfo.hIcon -eq [IntPtr]::Zero) { throw 'Windows Shell could not load the shortcut icon' }
$taskPreview = Join-Path $taskProjectRoot '.data\desktop-icon-azure-shell.png'
$taskManagedIcon = $null; $taskBitmap = $null
try {
    $taskManagedIcon = [Drawing.Icon]::FromHandle($taskFileInfo.hIcon)
    $taskBitmap = $taskManagedIcon.ToBitmap()
    $taskBitmap.Save($taskPreview, [Drawing.Imaging.ImageFormat]::Png)
} finally {
    if ($taskBitmap) { $taskBitmap.Dispose() }; if ($taskManagedIcon) { $taskManagedIcon.Dispose() }
    [StarportDesktopIcon]::DestroyIcon($taskFileInfo.hIcon) | Out-Null
}
[pscustomobject]@{shortcut=$taskShortcutPath;icon=$taskAfter.IconLocation;launcherPreserved=$true;shellPreview=$taskPreview} | ConvertTo-Json -Compress
