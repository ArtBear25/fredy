@echo off
setlocal
cd /d "%~dp0"
title Fredy Bewerbungsmodul
set "PORT=%BEWERBUNGSMODUL_PORT%"
if not defined PORT set "PORT=8765"

echo Starte Bewerbungsmodul auf http://127.0.0.1:%PORT% ...
powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "$url = 'http://127.0.0.1:%PORT%'; try { $health = Invoke-RestMethod -Uri ($url + '/api/v1/health') -TimeoutSec 2; if ($health.status -eq 'ok') { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  echo.
  echo Bewerbungsmodul laeuft bereits auf Port %PORT%.
  echo Es wird keine alte Instanz still weiterverwendet und keine zweite gestartet.
  echo Beende zuerst die laufende Instanz und starte danach dieses Fenster erneut.
  echo.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
fc /b "requirements-lock.txt" ".venv\requirements-lock.txt" >nul 2>&1
if errorlevel 1 (
  ".venv\Scripts\python.exe" -m pip install --index-url https://pypi.org/simple -r requirements-lock.txt
  if errorlevel 1 (
    pause
    exit /b 1
  )
  copy /y "requirements-lock.txt" ".venv\requirements-lock.txt" >nul
)
start "" /b powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "$port = if ($env:BEWERBUNGSMODUL_PORT) { $env:BEWERBUNGSMODUL_PORT } else { '8765' }; $url = 'http://127.0.0.1:' + $port; for ($attempt = 0; $attempt -lt 60; $attempt++) { try { $response = Invoke-WebRequest -Uri ($url + '/api/v1/health') -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process $url; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"

rem The visible console owns a Windows Job Object. Closing the console kills the
rem PowerShell supervisor; Windows then closes the Job handle and terminates the
rem complete backend process tree, including the venv Python redirector.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$src='using System; using System.Runtime.InteropServices; public static class FredyJob { const uint KILL_ON_CLOSE=0x2000; [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public long Affinity; public uint PriorityClass; public uint SchedulingClass; } [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; } [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; } [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name); [DllImport(\"kernel32.dll\", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,IntPtr info,uint length); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process); [DllImport(\"kernel32.dll\")] public static extern bool CloseHandle(IntPtr handle); public static IntPtr Create(){ IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(); Extended info=new Extended(); info.BasicLimitInformation.LimitFlags=KILL_ON_CLOSE; int size=Marshal.SizeOf(info); IntPtr ptr=Marshal.AllocHGlobal(size); try { Marshal.StructureToPtr(info,ptr,false); if(!SetInformationJobObject(job,9,ptr,(uint)size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(ptr); } return job; } public static void Assign(IntPtr job,IntPtr process){ if(!AssignProcessToJobObject(job,process)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } }'; Add-Type -TypeDefinition $src; $job=[FredyJob]::Create(); $holder=$null; try { $python=Join-Path (Get-Location) '.venv\Scripts\python.exe'; $psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName=$python; $psi.WorkingDirectory=(Get-Location).Path; $psi.UseShellExecute=$false; $psi.Arguments='-m app.main'; $holder=[System.Diagnostics.Process]::Start($psi); [FredyJob]::Assign($job,$holder.Handle); for($attempt=0; $attempt -lt 100; $attempt++){ Start-Sleep -Milliseconds 20; $children=Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $holder.Id); foreach($child in $children){ try { $childProcess=Get-Process -Id $child.ProcessId -ErrorAction Stop; [FredyJob]::Assign($job,$childProcess.Handle) } catch {} }; if($children){ break } }; $holder.WaitForExit(); exit $holder.ExitCode } catch { if($holder -and -not $holder.HasExited){ $holder.Kill() }; Write-Error $_; exit 1 } finally { [FredyJob]::CloseHandle($job) | Out-Null }"
set "APP_EXIT=%ERRORLEVEL%"
if not "%APP_EXIT%"=="0" echo Bewerbungsmodul wurde mit Fehlercode %APP_EXIT% beendet.
pause
