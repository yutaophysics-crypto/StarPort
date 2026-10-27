# A trusted, fixed launcher. JSON on stdin is data; it is never evaluated as code.
# The job owns the entire application tree, including children of a fast-exiting
# parent. Closing/killing this launcher closes the job and its remaining processes.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class StarportApplicationJob {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
        public short show, reservedSize; public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime,jobTime; public uint flags;
        public UIntPtr minWorkingSet,maxWorkingSet; public uint activeProcessLimit;
        public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long userTime,kernelTime,periodUserTime,periodKernelTime;
        public uint pageFaults,totalProcesses,activeProcesses,terminatedProcesses;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting accounting,uint size,IntPtr returned);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupInfo startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static string Quote(string value) {
        var output=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='"') output.Append('\\',slashes*2+1).Append(c);
            else output.Append('\\',slashes).Append(c);
            slashes=0;
        }
        return output.Append('\\',slashes*2).Append('"').ToString();
    }
    static void Check(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static bool Stop(string name) {
        var job=OpenJobObject(8,false,name); if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) return false; throw new Win32Exception(Marshal.GetLastWin32Error()); }
        try { Check(TerminateJobObject(job,1)); return true; } finally { CloseHandle(job); }
    }
    public static int Run(string executable,string[] args,string cwd,string jobName,bool persistent,Action<uint> heartbeat) {
        var job=CreateJobObject(IntPtr.Zero,jobName); if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var process=new ProcessInfo(); bool started=false;
        try {
            var limits=new ExtendedLimits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            var command=new StringBuilder(Quote(executable)); foreach(string arg in args) command.Append(' ').Append(Quote(arg));
            var startup=new StartupInfo(); startup.cb=Marshal.SizeOf(typeof(StartupInfo));
            startup.flags=0x101; startup.show=(short)(persistent?1:0); // persistent GUI opens on the user's desktop
            startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
            Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out process));
            Check(AssignProcessToJobObject(job,process.process));
            if(ResumeThread(process.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
            started=true;
            if(persistent) {
                while(true) {
                    Accounting accounting; Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
                    if(accounting.activeProcesses==0) break;
                    heartbeat(process.pid); System.Threading.Thread.Sleep(1000);
                }
            } else Check(WaitForSingleObject(process.process,0xffffffff)==0);
            uint code; Check(GetExitCodeProcess(process.process,out code)); return unchecked((int)code);
        } finally {
            if(!started && process.process!=IntPtr.Zero) TerminateProcess(process.process,1);
            CloseHandle(job);
            if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
            if(process.process!=IntPtr.Zero) CloseHandle(process.process);
        }
    }
}
'@
try {
    if ($spec.action -eq 'stop') {
        if ($spec.jobName -notmatch '^Local\\StarportExternal-[a-f0-9-]{36}$') { throw 'Invalid job name' }
        [StarportApplicationJob]::Stop([string]$spec.jobName) | Out-Null
        exit 0
    }
    $heartbeat = $null
    if ($spec.persistent) {
        if (Test-Path -LiteralPath ([string]$spec.stopFile)) {
            [IO.File]::WriteAllText([string]$spec.statusFile, '{"state":"stopped"}', (New-Object Text.UTF8Encoding($false)))
            exit 0
        }
        $heartbeat = [Action[uint32]] { param($applicationPid)
            if (Test-Path -LiteralPath ([string]$spec.stopFile)) { [StarportApplicationJob]::Stop([string]$spec.jobName) | Out-Null; return }
            $status = @{state='running';pid=$applicationPid;updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
            $temp = [string]$spec.statusFile + '.tmp'
            [IO.File]::WriteAllText($temp, ($status | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
            Move-Item -LiteralPath $temp -Destination ([string]$spec.statusFile) -Force
        }
    }
    $code = [StarportApplicationJob]::Run([string]$spec.executable, [string[]]@($spec.args), [string]$spec.cwd, [string]$spec.jobName, [bool]$spec.persistent, $heartbeat)
    if ($spec.persistent) { [IO.File]::WriteAllText([string]$spec.statusFile, (@{state='exited';exitCode=$code;updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) }
    exit $code
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    if ($spec.persistent) { [IO.File]::WriteAllText([string]$spec.statusFile, (@{state='error';error=$_.Exception.Message;updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) }
    exit 1
}
