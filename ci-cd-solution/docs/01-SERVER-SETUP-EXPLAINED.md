# Doc 1 — Server Setup, Explained Command by Command

This document sets up a **fresh Windows Server** to host our two IIS sites and to
accept deployments from GitHub over SSH. Run every PowerShell block **as
Administrator** (right-click PowerShell → *Run as administrator*).

Everything here answers two questions for each command: **what it does** and
**why we need it**.

---

## Part 1 — Install the web stack

We need three things on the server: **IIS** (the web server), the **ASP.NET Core
Hosting Bundle** (so IIS can run our .NET API), and **URL Rewrite** (so the
Angular app's routing works).

### 1.1 Install IIS

```powershell
Install-WindowsFeature -Name Web-Server -IncludeManagementTools
```

- `Install-WindowsFeature` — the Windows Server cmdlet that turns on optional
  server roles/features.
- `-Name Web-Server` — `Web-Server` is the internal name of the **IIS** role.
  This installs the web server itself.
- `-IncludeManagementTools` — also installs **IIS Manager** (the GUI) and the
  PowerShell module we use later (`WebAdministration`). Without this you'd have
  IIS but no easy way to manage it.

### 1.2 Install the ASP.NET Core 8 Hosting Bundle

```powershell
Invoke-WebRequest "https://aka.ms/dotnet/8.0/dotnet-hosting-win.exe" -OutFile C:\hosting.exe
Start-Process C:\hosting.exe -ArgumentList "/quiet /norestart" -Wait
```

- `Invoke-WebRequest <url> -OutFile <path>` — downloads a file from the internet
  and saves it. Here it downloads the Hosting Bundle installer to `C:\hosting.exe`.
- `Start-Process <exe>` — runs a program.
  - `-ArgumentList "/quiet /norestart"` — passes flags to the installer:
    `/quiet` = install silently (no clicking), `/norestart` = don't reboot the
    server automatically.
  - `-Wait` — PowerShell pauses until the installer finishes before moving on.
- **Why:** the Hosting Bundle installs the **ASP.NET Core Module (ANCM)** into
  IIS. That module is what lets IIS start and forward requests to a .NET 8 app.
  Without it, the API site returns HTTP 500.19 / 502 errors.

### 1.3 Install URL Rewrite

Download and run the installer from
<https://www.iis.net/downloads/microsoft/url-rewrite>.

- **Why:** the Angular app is a Single Page Application. If a user refreshes on
  `/about`, IIS looks for a file called `about` and returns 404. The URL Rewrite
  module (using the `web.config` we ship) rewrites those requests back to
  `index.html` so Angular's router can handle them.

### 1.4 Restart IIS so the new module loads

```powershell
net stop was /y
net start w3svc
```

- `net stop was /y` — stops the **Windows Process Activation Service (WAS)**.
  `/y` auto-confirms stopping dependent services.
- `net start w3svc` — starts the **World Wide Web Publishing Service (W3SVC)**,
  which also starts WAS again (it depends on it).
- **Why:** IIS only picks up a newly installed native module (the ASP.NET Core
  Module) after a restart.

---

## Part 2 — Folders, application pools, and the two sites

### 2.1 Create the folders

```powershell
Import-Module WebAdministration
New-Item -ItemType Directory -Force -Path C:\inetpub\api, C:\inetpub\web, C:\deploy-incoming, C:\deploy-backups
```

- `Import-Module WebAdministration` — loads the IIS PowerShell module. This gives
  us the `IIS:\` drive and cmdlets like `New-Website` and `Stop-WebAppPool`.
- `New-Item -ItemType Directory` — creates folders.
  - `-Force` — don't error if a folder already exists (makes the script safe to
    re-run).
  - `-Path a, b, c` — creates several folders in one call.
- **What each folder is for:**
  - `C:\inetpub\api` — where the **API** files live (the live site root).
  - `C:\inetpub\web` — where the **Angular** files live.
  - `C:\deploy-incoming` — where the pipeline drops the new zip + `deploy.ps1`.
  - `C:\deploy-backups` — where `deploy.ps1` saves the previous release so it can
    roll back.

### 2.2 Free up port 80

```powershell
Remove-Website -Name "Default Web Site" -ErrorAction SilentlyContinue
```

- `Remove-Website` — deletes an IIS site definition (not the files).
- `-ErrorAction SilentlyContinue` — if the site doesn't exist, don't throw an
  error, just continue.
- **Why:** IIS ships with a "Default Web Site" already bound to port 80. Our web
  site also wants port 80, so we remove the default to avoid a binding conflict.

### 2.3 Create the API site (port 8080)

```powershell
New-WebAppPool -Name "SimpleWebApp-Api"
Set-ItemProperty "IIS:\AppPools\SimpleWebApp-Api" -Name managedRuntimeVersion -Value ""
New-Website -Name "SimpleWebApp-Api" -Port 8080 -PhysicalPath "C:\inetpub\api" -ApplicationPool "SimpleWebApp-Api"
```

- `New-WebAppPool -Name "SimpleWebApp-Api"` — creates an **application pool**. An
  app pool is the isolated Windows process that runs a site. Giving each site its
  own pool means one crashing can't take down the other.
- `Set-ItemProperty ... managedRuntimeVersion -Value ""` — sets the pool's .NET
  CLR version to **"No Managed Code"** (the empty string).
  - **Why:** ASP.NET Core does **not** run inside IIS's .NET CLR like old
    ASP.NET did. It runs through the native ASP.NET Core Module. So the pool
    should not load a managed runtime — "No Managed Code" is the correct and
    recommended setting.
- `New-Website` — creates the site and its binding.
  - `-Name` — the site's name (must match `$apiPool`/site name in `deploy.ps1`).
  - `-Port 8080` — the site listens on port 8080.
  - `-PhysicalPath` — the folder the site serves.
  - `-ApplicationPool` — which pool runs it.

### 2.4 Create the Web site (port 80)

```powershell
New-WebAppPool -Name "SimpleWebApp-Web"
New-Website -Name "SimpleWebApp-Web" -Port 80 -PhysicalPath "C:\inetpub\web" -ApplicationPool "SimpleWebApp-Web"
```

Same idea, but for the Angular static files on port 80. We **don't** set
"No Managed Code" here because it doesn't matter for static files (there's no
app to run), though setting it would also be fine.

> ⚠️ The **names** `SimpleWebApp-Api` and `SimpleWebApp-Web` must exactly match
> the `$apiPool` / `$webPool` variables at the top of `deploy.ps1`, or the deploy
> script won't find the pools to stop/start.

---

## Part 3 — Enable SSH so GitHub can deploy

The pipeline runs on GitHub's servers, so it connects to *this* machine over SSH
to run the deploy. We install an SSH server and allow **key-based** login only.

### 3.1 Install and start the OpenSSH server

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
```

- `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0` — installs the
  built-in OpenSSH **server** feature. `-Online` means "apply to the running
  system" (as opposed to an offline image). The odd `~~~~0.0.1.0` is just the
  capability's full version identifier.
- `Start-Service sshd` — starts the SSH server service (named `sshd`).
- `Set-Service sshd -StartupType Automatic` — makes `sshd` start automatically on
  every boot, so deploys keep working after a restart.

### 3.2 Make PowerShell the default SSH shell

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```

- `New-ItemProperty` — creates (or overwrites) a value in the Windows **registry**.
- `-Path "HKLM:\SOFTWARE\OpenSSH"` — the registry location OpenSSH reads.
- `-Name DefaultShell` — the setting that decides which shell an SSH session gets.
- `-Value "...powershell.exe"` — point it at PowerShell.
- `-PropertyType String` / `-Force` — it's a text value; `-Force` overwrites if it
  already exists.
- **Why:** by default an SSH session on Windows opens `cmd.exe`. Our deploy runs
  PowerShell cmdlets (`Stop-WebAppPool`, `Expand-Archive`, …), so we make
  PowerShell the default shell.

### 3.3 Turn off password login (key-only)

```powershell
(Get-Content C:\ProgramData\ssh\sshd_config) -replace '#?PasswordAuthentication.*','PasswordAuthentication no' |
  Set-Content C:\ProgramData\ssh\sshd_config
```

- `Get-Content <file>` — reads the SSH server's config file into memory.
- `-replace 'pattern','replacement'` — a regex find-and-replace. It finds the
  `PasswordAuthentication` line (commented or not — `#?` means "optional #") and
  sets it to `PasswordAuthentication no`.
- `| Set-Content <file>` — writes the changed text back to the file.
- **Why:** we only want logins with the SSH **key**, never a password. This is
  the single most important hardening step, because port 22 is reachable from the
  internet (GitHub's runners need to reach it).

### 3.4 Install your PUBLIC key for the admin user

```powershell
$pub = "ssh-ed25519 AAAA...PASTE_YOUR_PUBLIC_KEY... you@mac"
Add-Content C:\ProgramData\ssh\administrators_authorized_keys $pub

icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F" /grant "SYSTEM:F"
Restart-Service sshd
```

- `$pub = "ssh-ed25519 AAAA..."` — a PowerShell **variable** holding your public
  key text (the one line you copied from `iis_deploy.pub` — see Doc 2).
- `Add-Content <file> $pub` — appends your public key to the authorized-keys file.
- **Why this specific file?** On Windows, for accounts in the **Administrators**
  group, OpenSSH does **not** read the user's `~/.ssh/authorized_keys`. It reads a
  single shared file: `C:\ProgramData\ssh\administrators_authorized_keys`. Put the
  key anywhere else and login silently fails.
- `icacls <file> /inheritance:r` — removes inherited permissions from the file
  (`/inheritance:r` = remove all inherited entries).
- `icacls <file> /grant "Administrators:F" /grant "SYSTEM:F"` — grants Full
  control to only **Administrators** and **SYSTEM**.
- **Why the permissions matter:** OpenSSH refuses to use the authorized-keys file
  if *other* users can write to it (a security check). If the ACLs are too open,
  your key is ignored and login fails — this is the #1 cause of "it still asks for
  a password."
- `Restart-Service sshd` — reload sshd so all the changes above take effect.

---

## Part 4 — Open the network ports

Two firewalls sit between GitHub and our sites: the **AWS security group** (cloud
firewall) and the **Windows firewall** (on the server). Both must allow the
traffic.

### 4.1 Windows firewall (on the server)

```powershell
New-NetFirewallRule -DisplayName "HTTP 80"  -Direction Inbound -Protocol TCP -LocalPort 80   -Action Allow
New-NetFirewallRule -DisplayName "API 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

- `New-NetFirewallRule` — creates a Windows firewall rule.
  - `-DisplayName` — a human-readable name for the rule.
  - `-Direction Inbound` — the rule is about traffic coming **into** the server.
  - `-Protocol TCP` — web/SSH traffic is TCP.
  - `-LocalPort 80` / `8080` — the port to allow.
  - `-Action Allow` — permit that traffic.
- OpenSSH already added its own inbound rule for port 22 when we installed it, so
  we only add rules for the two web ports.

### 4.2 AWS security group (cloud firewall)

In the EC2 console, open the instance's security group → **Inbound rules** and add:

| Port | Purpose | Source |
|------|---------|--------|
| 22   | SSH — the pipeline connects here | `0.0.0.0/0` (safe because login is **key-only**) |
| 80   | The Angular web site | `0.0.0.0/0` |
| 8080 | The .NET API | `0.0.0.0/0` |
| 3389 | RDP — you connecting to the desktop | **your IP only** |

- **Why 22 is open to everyone:** GitHub-hosted runners use a huge, constantly
  changing set of IPs, so you can't list them. Because we disabled password login
  in step 3.3, only someone holding the private key can log in — so an open port
  22 is an acceptable trade-off for a lab. Turn it off when you're not deploying
  if you want to be extra safe.

---

## What you have now
- IIS running two sites: Web on port 80, API on port 8080.
- The ASP.NET Core Module and URL Rewrite installed.
- An SSH server that accepts **only** your key.
- The folders and app pools the deploy script expects.

Next: **Doc 2** explains the SSH key and the GitHub secrets that let the pipeline
use it.
