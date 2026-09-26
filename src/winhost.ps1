# JARVIS macro host: one PowerShell process kept warm, so a voice macro runs in milliseconds instead of paying
# for PowerShell start-up and C# compilation on every command (see src/winhost.js).
# Protocol: one JSON request per stdin line  {"id":1,"op":"keys","args":{"codes":[91,68]}}
#           one JSON reply per stdout line   {"id":1,"ok":true,"value":...,"error":null}
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JarvisHost {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool LockWorkStation();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("powrprof.dll")] static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHEmptyRecycleBin(IntPtr hwnd, string root, uint flags);

  const uint KEYUP = 2;
  const uint EXTENDED = 1;

  static uint Ext(byte vk) {
    bool ext = (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || (vk >= 0xA6 && vk <= 0xB7) || vk == 0x6F || vk == 0x90;
    return ext ? EXTENDED : 0;
  }

  /** Presses the keys in order and releases them in reverse: one chord such as Win+D. */
  public static void Chord(byte[] vks) {
    foreach (byte k in vks) keybd_event(k, 0, Ext(k), UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event(vks[i], 0, KEYUP | Ext(vks[i]), UIntPtr.Zero);
  }

  public static void Lock() { LockWorkStation(); }
  public static void Sleep() { SetSuspendState(false, false, false); }
  // no confirmation, no progress, no sound; an already empty bin is not an error
  public static void EmptyTrash() { SHEmptyRecycleBin(IntPtr.Zero, null, 7); }
}

// Core Audio: the default output device's master volume (IAudioEndpointVolume).
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify);
  int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float levelDB, ref Guid context);
  int SetMasterVolumeLevelScalar(float level, ref Guid context);
  int GetMasterVolumeLevel(out float levelDB);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint channel, float levelDB, ref Guid context);
  int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  int GetChannelVolumeLevel(uint channel, out float levelDB);
  int GetChannelVolumeLevelScalar(uint channel, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public static class JarvisAudio {
  static IAudioEndpointVolume Endpoint() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device)); // eRender, eMultimedia
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o)); // CLSCTX_ALL
    return (IAudioEndpointVolume)o;
  }

  public static int GetLevel() {
    float v;
    Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
    return (int)Math.Round(v * 100);
  }

  public static void SetLevel(int percent) {
    Guid none = Guid.Empty;
    float v = Math.Max(0, Math.Min(100, percent)) / 100f;
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, ref none));
  }

  public static bool GetMute() {
    bool m;
    Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
    return m;
  }

  public static void SetMute(bool mute) {
    Guid none = Guid.Empty;
    Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, ref none));
  }
}
'@
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[void][JarvisHost]::SetProcessDPIAware() # screenshots of the whole screen, not of a scaled part of it

function Send-Reply($id, $ok, $value, $err) {
  $reply = @{ id = $id; ok = $ok; value = $value; error = $err }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 4))
}

function Invoke-Op($op, $a) {
  switch ($op) {
    'keys' {
      foreach ($chord in @($a.chords)) {
        [JarvisHost]::Chord([byte[]]@($chord))
        Start-Sleep -Milliseconds ([int]$a.delay)
      }
      return $true
    }
    'volume' {
      if ($null -ne $a.mute) {
        if ($a.mute -eq 'toggle') { [JarvisAudio]::SetMute(-not [JarvisAudio]::GetMute()) }
        else { [JarvisAudio]::SetMute($a.mute -eq 'on') }
      }
      if ($null -ne $a.set) { [JarvisAudio]::SetMute($false); [JarvisAudio]::SetLevel([int]$a.set) }
      if ($null -ne $a.delta) { [JarvisAudio]::SetMute($false); [JarvisAudio]::SetLevel([JarvisAudio]::GetLevel() + [int]$a.delta) }
      return [JarvisAudio]::GetLevel()
    }
    'lock' { [JarvisHost]::Lock(); return $true }
    'sleep' { [JarvisHost]::Sleep(); return $true }
    'minimize-all' { (New-Object -ComObject Shell.Application).MinimizeAll(); return $true }
    'empty-trash' { [JarvisHost]::EmptyTrash(); return $true }
    'screenshot' {
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
        [void](New-Item -ItemType Directory -Force -Path $a.dir)
        $file = Join-Path $a.dir ('JARVIS ' + (Get-Date -Format 'yyyy-MM-dd HH-mm-ss') + '.png')
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        return $file
      } finally { $g.Dispose(); $bmp.Dispose() }
    }
    'script' {
      $out = Invoke-Expression $a.script | Out-String
      return $out.Trim()
    }
    default { throw "неизвестная операция: $op" }
  }
}

Send-Reply 0 $true 'ready' $null
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = -1
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $value = Invoke-Op $req.op $req.args
    Send-Reply $id $true $value $null
  } catch {
    Send-Reply $id $false $null $_.Exception.Message
  }
}
