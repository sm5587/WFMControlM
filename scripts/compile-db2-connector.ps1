# Compile lib/DB2Connector.java → lib/DB2Connector.class (requires JDK 11+).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Lib = Join-Path $Root 'lib'
$Jar = Join-Path $Lib 'db2jcc4.jar'
$Src = Join-Path $Lib 'DB2Connector.java'

if (-not (Test-Path $Jar)) { throw "Missing $Jar" }
if (-not (Test-Path $Src)) { throw "Missing $Src" }
if (-not (Get-Command javac -ErrorAction SilentlyContinue)) { throw 'javac not found — install JDK 17+' }

& javac --release 17 -cp $Jar -d $Lib $Src
Write-Host "Compiled $(Join-Path $Lib 'DB2Connector.class')"
