# Starport notification helper (Windows). Started by src/notifier-windows.mjs.
# Shows a small popup at the bottom right when a task finishes, plays the chime
# and flashes the Starport taskbar button until the window is brought forward.
# Reads one base64 JSON message per line on stdin; writes {"type":"open",...}
# when the popup body is clicked. -Snapshot renders a sample popup to a PNG.
param([string]$Snapshot = '', [string]$Theme = 'sea', [string]$Tone = 'complete', [string]$Language = 'en', [string]$Icon = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class StarportWin {
  [StructLayout(LayoutKind.Sequential)]
  struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO info);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

  // Starport app windows: Edge --app windows whose title is the Starport title.
  public static IntPtr[] Find(string[] titles) {
    var found = new List<IntPtr>();
    var wanted = new HashSet<string>(titles);
    EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(256);
      GetWindowText(hwnd, text, 256);
      if (!wanted.Contains(text.ToString())) return true;
      var name = new StringBuilder(64);
      GetClassName(hwnd, name, 64);
      if (name.ToString().StartsWith("Chrome_WidgetWin")) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  static void FlashOne(IntPtr hwnd, uint flags) {
    var info = new FLASHWINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
    info.hwnd = hwnd; info.dwFlags = flags; info.uCount = uint.MaxValue; info.dwTimeout = 0;
    FlashWindowEx(ref info);
  }
  // FLASHW_TRAY | FLASHW_TIMERNOFG: the taskbar button flashes until the window comes forward.
  public static int Flash(string[] titles) {
    var windows = Find(titles);
    var front = GetForegroundWindow();
    foreach (var hwnd in windows) if (hwnd != front) FlashOne(hwnd, 2 | 12);
    return windows.Length;
  }
  public static bool Raise(string[] titles) {
    var windows = Find(titles);
    if (windows.Length == 0) return false;
    var hwnd = windows[0];
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    if (!SetForegroundWindow(hwnd) || GetForegroundWindow() != hwnd) {
      // The click gives this process the right to switch windows; a synthetic
      // Alt tap covers the cases where Windows still holds the foreground lock.
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(hwnd);
    }
    foreach (var other in windows) FlashOne(other, 0);
    return true;
  }
  public static void AllowAny() { AllowSetForegroundWindow(-1); }
  // WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE: no Alt+Tab entry, and clicks never steal focus.
  public static void Quiet(IntPtr hwnd) {
    long style = GetWindowLongPtr(hwnd, -20).ToInt64();
    SetWindowLongPtr(hwnd, -20, new IntPtr(style | 0x80 | 0x08000000));
  }
}
'@

$Palettes = @{
  'sea'        = @{ Card = '#0F1B2B'; Border = '#2A4058'; Hot = '#47637F'; Ink = '#E6EEF8'; Body = '#B9C8DA'; Muted = '#93A6BD'; Ok = '#A0D4F3'; Error = '#EE9AA2'; Hover = '#1B2D42'; Radius = 8; Small = 5; Brackets = 'Collapsed'; Bracket = '#00000000' }
  'port'       = @{ Card = '#0A0F16'; Border = '#22313F'; Hot = '#2F5566'; Ink = '#E3ECF2'; Body = '#AEBDCA'; Muted = '#8295A6'; Ok = '#6FF0B0'; Error = '#FF8A80'; Hover = '#122030'; Radius = 3; Small = 2; Brackets = 'Visible'; Bracket = '#AA5FD8FF' }
  'deep-space' = @{ Card = '#171C22'; Border = '#323942'; Hot = '#4F4A40'; Ink = '#EEEEE9'; Body = '#C4C8CD'; Muted = '#9BA2AB'; Ok = '#DFB87D'; Error = '#E8968C'; Hover = '#242A32'; Radius = 7; Small = 4; Brackets = 'Collapsed'; Bracket = '#00000000' }
}
$CloseLabel = @{ zh = '关闭'; en = 'Close' }

$Template = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Starport notification" WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" Topmost="True" ShowInTaskbar="False" ShowActivated="False" Focusable="False"
        SizeToContent="Height" Width="392" UseLayoutRounding="True" SnapsToDevicePixels="True"
        FontFamily="Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI" TextOptions.TextFormattingMode="Display">
  <Grid x:Name="Root" Margin="16">
    <Border CornerRadius="@RADIUS@" Background="@CARD@">
      <Border.Effect><DropShadowEffect BlurRadius="22" ShadowDepth="6" Direction="270" Opacity="0.45" Color="#000000"/></Border.Effect>
    </Border>
    <Border x:Name="Card" CornerRadius="@RADIUS@" Background="@CARD@" BorderThickness="1" Padding="14,10,8,13" Cursor="Hand">
      <Border.Style>
        <Style TargetType="Border">
          <Setter Property="BorderBrush" Value="@BORDER@"/>
          <Style.Triggers>
            <Trigger Property="IsMouseOver" Value="True"><Setter Property="BorderBrush" Value="@HOT@"/></Trigger>
          </Style.Triggers>
        </Style>
      </Border.Style>
      <Grid>
        <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
        <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
          <Image x:Name="Icon" Width="16" Height="16" Margin="0,0,7,0" VerticalAlignment="Center" RenderOptions.BitmapScalingMode="HighQuality"/>
          <TextBlock x:Name="Source" FontSize="12" Foreground="@MUTED@" VerticalAlignment="Center" TextTrimming="CharacterEllipsis" MaxWidth="210"/>
          <Ellipse Width="6" Height="6" Margin="9,1,6,0" Fill="@TONE@" VerticalAlignment="Center"/>
          <TextBlock x:Name="State" FontSize="12" Foreground="@TONE@" VerticalAlignment="Center"/>
        </StackPanel>
        <Button x:Name="CloseButton" Grid.Column="1" Width="26" Height="26" Margin="0,-4,0,-4" VerticalAlignment="Center" Cursor="Arrow" Focusable="False">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Border x:Name="Back" Background="Transparent" CornerRadius="@SMALL@">
                <Path x:Name="Glyph" Data="M0,0 L8,8 M8,0 L0,8" Stroke="@MUTED@" StrokeThickness="1.3" StrokeStartLineCap="Round" StrokeEndLineCap="Round" HorizontalAlignment="Center" VerticalAlignment="Center"/>
              </Border>
              <ControlTemplate.Triggers>
                <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Back" Property="Background" Value="@HOVER@"/><Setter TargetName="Glyph" Property="Stroke" Value="@INK@"/></Trigger>
                <Trigger Property="IsPressed" Value="True"><Setter TargetName="Back" Property="Opacity" Value="0.75"/></Trigger>
              </ControlTemplate.Triggers>
            </ControlTemplate>
          </Button.Template>
        </Button>
        <TextBlock x:Name="Heading" Grid.Row="1" Grid.ColumnSpan="2" Margin="0,6,10,0" FontSize="14" FontWeight="SemiBold" Foreground="@INK@" TextTrimming="CharacterEllipsis"/>
        <TextBlock x:Name="Body" Grid.Row="2" Grid.ColumnSpan="2" Margin="0,3,10,0" FontSize="12.5" Foreground="@BODY@" TextWrapping="Wrap" TextTrimming="CharacterEllipsis" LineHeight="18" LineStackingStrategy="BlockLineHeight" MaxHeight="36"/>
      </Grid>
    </Border>
    <Grid IsHitTestVisible="False" Visibility="@BRACKETS@">
      <Path Data="M0.5,9 L0.5,0.5 L9,0.5" Stroke="@BRACKET@" StrokeThickness="1" HorizontalAlignment="Left" VerticalAlignment="Top"/>
      <Path Data="M0,0.5 L8.5,0.5 L8.5,9" Stroke="@BRACKET@" StrokeThickness="1" HorizontalAlignment="Right" VerticalAlignment="Top"/>
      <Path Data="M0.5,0 L0.5,8.5 L9,8.5" Stroke="@BRACKET@" StrokeThickness="1" HorizontalAlignment="Left" VerticalAlignment="Bottom"/>
      <Path Data="M0,8.5 L8.5,8.5 L8.5,0" Stroke="@BRACKET@" StrokeThickness="1" HorizontalAlignment="Right" VerticalAlignment="Bottom"/>
    </Grid>
  </Grid>
</Window>
'@

function New-Popup($item) {
  $palette = $Palettes[[string]$item.theme]
  if (-not $palette) { $palette = $Palettes['sea'] }
  $tone = if ($item.tone -eq 'error') { $palette.Error } else { $palette.Ok }
  $xaml = $Template
  foreach ($pair in @(@('@CARD@', $palette.Card), @('@BORDER@', $palette.Border), @('@HOT@', $palette.Hot), @('@INK@', $palette.Ink),
      @('@BODY@', $palette.Body), @('@MUTED@', $palette.Muted), @('@TONE@', $tone), @('@HOVER@', $palette.Hover), @('@RADIUS@', $palette.Radius),
      @('@SMALL@', $palette.Small), @('@BRACKETS@', $palette.Brackets), @('@BRACKET@', $palette.Bracket))) {
    $xaml = $xaml.Replace($pair[0], [string]$pair[1])
  }
  $window = [Windows.Markup.XamlReader]::Parse($xaml)
  $window.FindName('Source').Text = [string]$item.source
  $window.FindName('State').Text = [string]$item.state
  $window.FindName('Heading').Text = [string]$item.title
  $body = $window.FindName('Body')
  $body.Text = [string]$item.body
  if (-not $item.body) { $body.Visibility = 'Collapsed' }
  $language = if ($item.language -eq 'en') { 'en' } else { 'zh' }
  $window.FindName('CloseButton').ToolTip = $CloseLabel[$language]
  if ($item.icon -and (Test-Path -LiteralPath $item.icon)) {
    try {
      $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create([Uri]$item.icon, 'None', 'OnLoad')
      $window.FindName('Icon').Source = $decoder.Frames | Sort-Object { [Math]::Abs($_.PixelWidth - 32) } | Select-Object -First 1
    } catch { }
  }
  return $window
}

if ($Snapshot) {
  $sample = @{
    zh = @{ source = '星港 · 科研'; complete = '已完成'; error = '出错了'; title = '计算衍生论'
      body = '闭合误差已经算完：在 L=64 时误差降到 3.2×10^-3，宏观层基本自洽。下一步可以把粗粒化尺度再放大一倍，看误差是否继续下降。'
      failure = '模拟的工具错误：python fit.py 返回了非零退出码，请检查输入数据。' }
    en = @{ source = 'Starport · Research'; complete = 'Done'; error = 'Failed'; title = 'Computational derivation'
      body = 'The closure error is computed: at L=64 it drops to 3.2×10^-3, so the macro layer is nearly self-consistent. Next, double the coarse-graining scale.'
      failure = 'Simulated tool error: python fit.py exited with a non-zero status. Check the input data.' }
  }[$Language]
  $item = @{ theme = $Theme; tone = $Tone; language = $Language; icon = $Icon; source = $sample.source; title = $sample.title
    state = $(if ($Tone -eq 'error') { $sample.error } else { $sample.complete }); body = $(if ($Tone -eq 'error') { $sample.failure } else { $sample.body }) }
  $window = New-Popup $item
  $root = $window.Content
  $window.Content = $null
  $stage = New-Object Windows.Controls.Border
  $stage.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#3B434D')
  $stage.Width = 392
  [Windows.Documents.TextElement]::SetFontFamily($stage, $window.FontFamily)
  [Windows.Media.TextOptions]::SetTextFormattingMode($stage, 'Display')
  $stage.Child = $root
  $stage.Measure([Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity))
  $stage.Arrange([Windows.Rect]::new(0, 0, 392, $stage.DesiredSize.Height))
  $stage.UpdateLayout()
  $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap([int](392 * 2), [int]($stage.DesiredSize.Height * 2), 192, 192, [Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($stage)
  $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream = [IO.File]::Create($Snapshot)
  $encoder.Save($stream)
  $stream.Close()
  Write-Output ('{0}x{1}' -f $root.ActualWidth, $root.ActualHeight)
  exit 0
}

$script:Popups = New-Object System.Collections.ArrayList
$script:Eof = $false
$script:LastSound = [DateTime]::MinValue
$script:Players = @{}

function Send-Message($data) {
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $data))
  [Console]::Out.Flush()
}

# Newest at the bottom, 12px from the work area edges, 8px between cards.
# The window carries a 16px margin for the shadow on every side.
function Set-Positions {
  $area = [Windows.SystemParameters]::WorkArea
  $bottom = $area.Bottom + 4
  for ($i = $script:Popups.Count - 1; $i -ge 0; $i--) {
    $window = $script:Popups[$i]
    $window.Left = $area.Right + 4 - $window.ActualWidth
    $window.Top = $bottom - $window.ActualHeight
    $bottom = $window.Top + 24
  }
}

function Close-Popup($window, [switch]$Immediate) {
  if (-not $window -or $window.Tag.closing) { return }
  $window.Tag.closing = $true
  $window.Tag.timer.Stop()
  [void]$script:Popups.Remove($window)
  Set-Positions
  if ($Immediate) { $window.Close(); return }
  $fade = New-Object Windows.Media.Animation.DoubleAnimation(0, [TimeSpan]::FromMilliseconds(140))
  $fade.add_Completed({ $window.Close() }.GetNewClosure())
  $window.BeginAnimation([Windows.Window]::OpacityProperty, $fade)
}

function Open-Popup($window) {
  $item = $window.Tag.item
  Close-Popup $window -Immediate
  $titles = [string[]]$item.titles
  if ([StarportWin]::Raise($titles)) { Send-Message @{ type = 'open'; id = [string]$item.id; chatId = $item.chatId; raised = $true }; return }
  Send-Message @{ type = 'open'; id = [string]$item.id; chatId = $item.chatId; raised = $false }
  if ($item.launch -and $item.launch.command) {
    [StarportWin]::AllowAny()
    [Diagnostics.Process]::Start([string]$item.launch.command, (([string[]]$item.launch.args) -join ' ')) | Out-Null
  }
}

function Start-Countdown($window, [double]$seconds) {
  $window.Tag.deadline = [DateTime]::Now.AddSeconds($seconds)
  $window.Tag.timer.Interval = [TimeSpan]::FromSeconds($seconds)
  $window.Tag.timer.Start()
}

function Show-Popup($item) {
  $window = New-Popup $item
  $timer = New-Object Windows.Threading.DispatcherTimer
  $timer.Tag = $window
  $timer.add_Tick({ param($from, $e) try { $from.Stop(); Close-Popup $from.Tag } catch { } })
  $window.Tag = @{ item = $item; timer = $timer; closing = $false; deadline = [DateTime]::Now }
  $window.Opacity = 0
  $window.Left = -32000
  $window.Top = -32000
  $window.add_SourceInitialized({ param($from, $e) [StarportWin]::Quiet((New-Object Windows.Interop.WindowInteropHelper $from).Handle) })
  # While the pointer rests on the popup it stays; leaving resumes the countdown.
  $window.add_MouseEnter({ param($from, $e) try { if (-not $from.Tag.closing) { $from.Tag.left = ($from.Tag.deadline - [DateTime]::Now).TotalSeconds; $from.Tag.timer.Stop() } } catch { } })
  $window.add_MouseLeave({ param($from, $e) try { if (-not $from.Tag.closing) { Start-Countdown $from ([Math]::Max(2.5, [double]$from.Tag.left)) } } catch { } })
  $window.FindName('Card').add_MouseLeftButtonUp({ param($from, $e) try { Open-Popup ([Windows.Window]::GetWindow($from)) } catch { } })
  $window.FindName('CloseButton').add_Click({ param($from, $e) try { $e.Handled = $true; Close-Popup ([Windows.Window]::GetWindow($from)) } catch { } })
  $window.Show()
  $window.UpdateLayout()
  [void]$script:Popups.Add($window)
  while ($script:Popups.Count -gt 3) { Close-Popup $script:Popups[0] -Immediate }
  Set-Positions
  $root = $window.FindName('Root')
  $slide = New-Object Windows.Media.TranslateTransform(18, 0)
  $root.RenderTransform = $slide
  $ease = New-Object Windows.Media.Animation.CubicEase
  $ease.EasingMode = 'EaseOut'
  $move = New-Object Windows.Media.Animation.DoubleAnimation(18, 0, [TimeSpan]::FromMilliseconds(220))
  $move.EasingFunction = $ease
  $slide.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $move)
  $window.BeginAnimation([Windows.Window]::OpacityProperty, (New-Object Windows.Media.Animation.DoubleAnimation(0, 1, [TimeSpan]::FromMilliseconds(180))))
  Start-Countdown $window 10
  if ($item.flash) { try { [void][StarportWin]::Flash([string[]]$item.titles) } catch { } }
  if ($item.chime -and ([DateTime]::Now - $script:LastSound).TotalSeconds -gt 1.5 -and (Test-Path -LiteralPath $item.chime)) {
    $script:LastSound = [DateTime]::Now
    $player = $script:Players[$item.chime]
    if (-not $player) { $player = New-Object System.Media.SoundPlayer($item.chime); $player.Load(); $script:Players[$item.chime] = $player }
    $player.Play()
  }
}

function Receive-Line([string]$line) {
  if (-not $line.Trim()) { return }
  $message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim())) | ConvertFrom-Json
  if ($message.type -eq 'show') { Show-Popup $message }
  elseif ($message.type -eq 'dismiss') { foreach ($window in @($script:Popups)) { Close-Popup $window } }
}

# The first ShowWindow of a process may take its show state from the parent's
# startup info (hidden); spend it on an invisible window, not a notification.
$warm = New-Object Windows.Window
$warm.WindowStyle = 'None'; $warm.ShowInTaskbar = $false; $warm.ShowActivated = $false
$warm.Width = 1; $warm.Height = 1; $warm.Left = -32000; $warm.Top = -32000; $warm.Opacity = 0; $warm.AllowsTransparency = $true
$warm.Show(); $warm.Close()

$script:Reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::ASCII)
$script:Pending = $script:Reader.ReadLineAsync()
$poll = New-Object Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromMilliseconds(100)
$poll.add_Tick({
  param($from, $e)
  while ($script:Pending -and $script:Pending.IsCompleted) {
    $line = $null
    try { $line = $script:Pending.Result } catch { }
    if ($null -eq $line) { $script:Pending = $null; $script:Eof = $true; break }
    $script:Pending = $script:Reader.ReadLineAsync()
    try { Receive-Line $line } catch { [Console]::Error.WriteLine($_.Exception.Message) }
  }
  if ($script:Eof -and $script:Popups.Count -eq 0) { $from.Stop(); [Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() }
})
[Windows.Threading.Dispatcher]::CurrentDispatcher.add_UnhandledException({ param($from, $e) $e.Handled = $true })
$poll.Start()
[Windows.Threading.Dispatcher]::Run()
