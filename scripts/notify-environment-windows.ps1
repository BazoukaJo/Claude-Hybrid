# Notify top-level windows that User environment variables changed (may refresh some apps without reboot).
# Safe no-op if Add-Type fails.
$ErrorActionPreference = "SilentlyContinue"
try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HybridEnvNotify {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, IntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out IntPtr lResult);
  public static void Broadcast() {
    IntPtr r;
    SendMessageTimeout((IntPtr)0xffff, 0x001A, IntPtr.Zero, "Environment", 0, 5000, out r);
  }
}
"@
    [HybridEnvNotify]::Broadcast()
} catch {}
