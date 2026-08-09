# Server Setup — Deploy from GitHub-Hosted Runners to IIS (over SSH)

You'll deploy with **GitHub-hosted runners**, so the runner lives in GitHub's
cloud and reaches your Windows server over **SSH**. This runbook lists the exact
steps. Run all PowerShell **as Administrator** on the server.

There are 6 stages:
1. Install the web stack (IIS + .NET hosting bundle + URL Rewrite)
2. Create folders, app pools, and the two IIS sites
3. Enable OpenSSH Server + key login for the Administrator
4. Open the required ports (AWS security group + Windows firewall)
5. Add the GitHub repository secrets + environments
6. Put the files in the repo and run the pipeline

---

## 1) Install the web stack

```powershell
# IIS with management tools
Install-WindowsFeature -Name Web-Server -IncludeManagementTools

# URL Rewrite (needed for the Angular SPA routing) + ASP.NET Core Hosting Bundle
# Download and install these two (they need internet access):
#   URL Rewrite:      https://www.iis.net/downloads/microsoft/url-rewrite
#   Hosting Bundle 8: https://dotnet.microsoft.com/download/dotnet/8.0  (ASP.NET Core Hosting Bundle)
# Example (adjust URLs to the current installers):
Invoke-WebRequest "https://download.microsoft.com/download/1/2/3/urlrewrite2.exe" -OutFile C:\rewrite.exe
Start-Process C:\rewrite.exe -ArgumentList "/quiet" -Wait

Invoke-WebRequest "https://aka.ms/dotnet/8.0/dotnet-hosting-win.exe" -OutFile C:\hosting.exe
Start-Process C:\hosting.exe -ArgumentList "/quiet /norestart" -Wait

net stop was /y; net start w3svc   # restart IIS to load the module
```

> If a download URL 404s, grab the current installer from the linked pages.

---

## 2) Folders, app pools, and IIS sites

```powershell
Import-Module WebAdministration

# Folders the pipeline uses
New-Item -ItemType Directory -Force -Path C:\inetpub\api, C:\inetpub\web, C:\deploy-incoming, C:\deploy-backups

# Remove the stock Default Web Site so it doesn't hold port 80
Remove-Website -Name "Default Web Site" -ErrorAction SilentlyContinue

# ---- API site (ASP.NET Core) on port 8080 ----
New-WebAppPool -Name "SimpleWebApp-Api"
# ASP.NET Core runs via the module, so the pool uses "No Managed Code":
Set-ItemProperty "IIS:\AppPools\SimpleWebApp-Api" -Name managedRuntimeVersion -Value ""
New-Website -Name "SimpleWebApp-Api" -Port 8080 -PhysicalPath "C:\inetpub\api" -ApplicationPool "SimpleWebApp-Api"

# ---- Web site (Angular static files) on port 80 ----
New-WebAppPool -Name "SimpleWebApp-Web"
New-Website -Name "SimpleWebApp-Web" -Port 80 -PhysicalPath "C:\inetpub\web" -ApplicationPool "SimpleWebApp-Web"
```

> The app pool / site names above **must match** the variables at the top of
> `deploy.ps1`.

---

## 3) Enable OpenSSH Server + key login

```powershell
# Install and start the OpenSSH server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic

# Make PowerShell the default SSH shell (so the pipeline can run PowerShell)
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force

# Harden: key-only login (no passwords over SSH)
(Get-Content C:\ProgramData\ssh\sshd_config) `
  -replace '#?PasswordAuthentication.*','PasswordAuthentication no' |
  Set-Content C:\ProgramData\ssh\sshd_config
Restart-Service sshd
```

**Create the key pair on YOUR machine** (Mac/Linux), not the server:

```bash
ssh-keygen -t ed25519 -f iis_deploy -N ""
# creates: iis_deploy (private)  +  iis_deploy.pub (public)
```

**Install the PUBLIC key on the server.** Because you log in as an admin, Windows
uses a special file `administrators_authorized_keys`:

```powershell
# paste the CONTENTS of iis_deploy.pub between the quotes:
$pub = "ssh-ed25519 AAAA...your key... youremail"
Add-Content C:\ProgramData\ssh\administrators_authorized_keys $pub

# lock down the file's permissions (required, or sshd ignores it)
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F" /grant "SYSTEM:F"
Restart-Service sshd
```

Test from your machine: `ssh -i iis_deploy Administrator@YOUR_SERVER_IP` should log in without a password.

---

## 4) Open the ports

**AWS security group** (EC2 console → the instance's security group → Inbound):

| Port | Purpose | Source |
|------|---------|--------|
| 22   | SSH (pipeline deploy) | `0.0.0.0/0` * |
| 80   | Web site | `0.0.0.0/0` |
| 8080 | API site | `0.0.0.0/0` |
| 3389 | RDP (you) | your IP only |

\* GitHub-hosted runners use a very large, changing IP range, so you can't easily
whitelist them. Because SSH is **key-only** (step 3), port 22 open is acceptable
for a lab — but tighten or turn it off when you're not deploying.

**Windows firewall** (OpenSSH adds its own rule; add the web ports):

```powershell
New-NetFirewallRule -DisplayName "HTTP 80"   -Direction Inbound -Protocol TCP -LocalPort 80   -Action Allow
New-NetFirewallRule -DisplayName "API 8080"  -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

---

## 5) GitHub secrets + environments

In your GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret            | Value |
|-------------------|-------|
| `SSH_HOST`        | your server's public IP |
| `SSH_USER`        | `Administrator` |
| `SSH_PRIVATE_KEY` | the **entire contents** of the `iis_deploy` private key file |

Then **Settings → Environments** → create `development`, `staging`, `production`.
On `production`, add a **required reviewer** so a prod deploy needs approval.
(You can also move the secrets to be per-environment here.)

---

## 6) Repo layout + run it

Put the files in your repo like this:

```
your-repo/
├─ backend/                     # the .NET solution
├─ frontend/                    # the Angular app
├─ deploy/
│  └─ deploy.ps1                # from ci-cd-solution/deploy/
└─ .github/workflows/
   ├─ ci.yml                    # from ci-cd-solution/workflows/
   ├─ release.yml
   └─ deploy.yml
```

One config edit before your first real deploy: set the frontend's production API
URL and the backend CORS origin so the two sites can talk:

- `frontend/src/environments/environment.production.ts` →
  `apiUrl: 'http://YOUR_SERVER_IP:8080'`
- `backend/SimpleWebApp.Api/appsettings.Production.json` → add
  `http://YOUR_SERVER_IP` to `Cors:AllowedOrigins`

Then:

1. Push to `main` → **CI** runs on PRs, **Release** cuts a tagged release.
2. Go to **Actions → Deploy → Run workflow**, pick an environment, and run it.
3. The pipeline builds + tests, SSHes in, backs up the current release, deploys,
   health-checks `:8080/health` and `:80/`, and **rolls back automatically** if
   either check fails.

## Quick verification checklist

- [ ] `ssh -i iis_deploy Administrator@IP` logs in without a password
- [ ] `http://IP/` and `http://IP:8080/health` respond (after first deploy)
- [ ] Deploy run shows "SUCCESS: deploy healthy"
- [ ] Break the app on purpose once → the run fails **and** the old site still loads (rollback works)
