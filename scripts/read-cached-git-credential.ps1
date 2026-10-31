param([string]$Target='git:https://github.com')
$ErrorActionPreference='Stop'
if ($Target -notmatch '^git:https://github\.com(?:/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?$') { throw 'Unsupported credential target' }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CachedGitCredential {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Credential {
  public UInt32 Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist,AttributeCount; public IntPtr Attributes;
  public string TargetAlias,UserName;
 }
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Read(string target,uint type,uint flags,out IntPtr credential);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
 public static string[] Get(string target){IntPtr p;if(!Read(target,1,0,out p))return null;
  try{var c=Marshal.PtrToStructure<Credential>(p);return new string[]{c.UserName,Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2)};}finally{CredFree(p);}
 }
}
"@
$credential=[CachedGitCredential]::Get($Target)
if ($null -eq $credential) { '{}' } else { @{username=$credential[0];password=$credential[1]} | ConvertTo-Json -Compress }
