param(
 [ValidateSet('Audit','Apply')][string]$Mode='Audit',
 [string]$PolicyPath=(Join-Path $PSScriptRoot '..\.data\claude-network-policy.json'),
 [string]$Program,[string]$ResultPath,[switch]$Quiet
)
$ErrorActionPreference='Stop'
$group='Starport-Claude-Clients'
$ranges=@('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
$result=[ordered]@{Mode=$Mode;Success=$false;Coverage=@();Missing=@();NormalNetwork=@();Error=$null}
function Rule-Name([string]$Path){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{$id=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())))).Replace('-','').Substring(0,24)}finally{$sha.Dispose()}
 return 'Starport-Claude-'+$id
}
function Test-Executable([string]$Path){
 $stream=[IO.File]::OpenRead($Path)
 try{return ($stream.ReadByte() -eq 77 -and $stream.ReadByte() -eq 90)}finally{$stream.Dispose()}
}
function Test-Coverage($Rule){
 $address=$Rule | Get-NetFirewallAddressFilter
 $port=$Rule | Get-NetFirewallPortFilter
 $interface=$Rule | Get-NetFirewallInterfaceFilter
 $type=$Rule | Get-NetFirewallInterfaceTypeFilter
 if([string]$Rule.Profile -ne 'Any' -or [string]$port.Protocol -ne 'Any' -or [string]$port.LocalPort -ne 'Any' -or [string]$port.RemotePort -ne 'Any' -or [string]$address.LocalAddress -ne 'Any' -or [string]$interface.InterfaceAlias -ne 'Any' -or [string]$type.InterfaceType -ne 'Any'){return $false}
 $actual=@($address.RemoteAddress | ForEach-Object {$_.ToLowerInvariant()})
 return (@($ranges | Where-Object {$actual -notcontains $_.ToLowerInvariant()}).Count -eq 0)
}
try {
 $policy=Get-Content -LiteralPath $PolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json
 if($policy.version -ne 1 -or -not $policy.enabled){throw 'Claude network policy is not enabled'}
 $paths=@($policy.protectedPrograms)
 if($Program){$paths+=$Program}
 foreach($root in @($policy.discoveryRoots)){
  if(-not (Test-Path -LiteralPath $root)){continue}
  $paths+=@(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object {($_.Name -like '*claude*.exe' -or $_.DirectoryName -like '*\claude\versions') -and (Test-Executable $_.FullName)} | Select-Object -ExpandProperty FullName)
 }
 $paths=@($paths | Where-Object {$_} | ForEach-Object {[IO.Path]::GetFullPath($_)} | Sort-Object -Unique)
 $normalPaths=@($policy.normalPrograms | Where-Object {$_} | ForEach-Object {if(-not [IO.Path]::IsPathRooted($_)){throw 'Normal-network executable must be an absolute path'};[IO.Path]::GetFullPath($_)} | Sort-Object -Unique)
 if(@($normalPaths | Where-Object {$paths -contains $_}).Count){throw 'An executable cannot be both protected and normal-network'}
 if(-not $paths.Count -or $paths.Count -gt 250){throw 'Invalid protected executable inventory'}
 if(@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object {-not $_.Enabled}).Count){throw 'A Windows Firewall profile is disabled; protection cannot be confirmed'}
 if($Mode -eq 'Apply'){
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if(-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator PowerShell is required to apply executable firewall rules'}
 }
 foreach($path in $normalPaths){
  $name=Rule-Name $path
  $owned=Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue
  if($owned){
   if($owned.Group -ne $group -or ($owned | Get-NetFirewallApplicationFilter).Program -ine $path){throw ('Refusing to change an unmanaged rule: '+$name)}
   if($Mode -eq 'Apply'){$owned | Remove-NetFirewallRule}
  }
  $remaining=@(Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction SilentlyContinue).Count
  $result.NormalNetwork+=[pscustomobject]@{Program=$path;ManagedRuleRemoved=($remaining -eq 0)}
 }
 # Index executable filters once; do not repeat a CIM query for every client.
 $rulesByProgram=@{}
 foreach($rule in @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Outbound -Action Block -Enabled True)){
  $app=$rule | Get-NetFirewallApplicationFilter
  if(-not $rulesByProgram.ContainsKey($app.Program)){$rulesByProgram[$app.Program]=@()}
  $rulesByProgram[$app.Program]+=$rule
 }
 foreach($path in $paths){
  if(-not (Test-Path -LiteralPath $path -PathType Leaf) -or -not (Test-Executable $path)){throw ('Protected executable is missing or invalid: '+$path)}
  $effective=$false
  foreach($rule in @($rulesByProgram[$path])){if($rule -and (Test-Coverage $rule)){$effective=$true;break}}
  if(-not $effective -and $Mode -eq 'Apply'){
   $name=Rule-Name $path
   $existing=Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
   if($existing){
    if($existing.Group -ne $group){throw ('Refusing to replace an unmanaged firewall rule: '+$name)}
    $existing | Remove-NetFirewallRule
   }
   New-NetFirewallRule -Name $name -DisplayName ('Starport Claude proxy only: '+[IO.Path]::GetFileName($path)) -Group $group -Direction Outbound -Action Block -Enabled True -Profile Any -Program $path -Protocol Any -RemoteAddress $ranges | Out-Null
   $check=Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction Stop
   $effective=([string]$check.Enabled -eq 'True' -and [string]$check.Action -eq 'Block' -and (Test-Coverage $check))
  }
  $result.Coverage+=[pscustomobject]@{Program=$path;Effective=$effective}
  if(-not $effective){$result.Missing+=$path}
 }
 $result.Success=($result.Missing.Count -eq 0 -and ($Mode -ne 'Apply' -or @($result.NormalNetwork | Where-Object {-not $_.ManagedRuleRemoved}).Count -eq 0))
}catch{$result.Error=$_.Exception.Message}
if($ResultPath){[IO.File]::WriteAllText($ResultPath,($result | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))}
if(-not $Quiet){$result | ConvertTo-Json -Depth 6}
if(-not $result.Success){exit 1}
exit 0
