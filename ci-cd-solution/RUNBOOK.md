# Runbook — From a Blank Server to a Running Pipeline

Follow these steps in order. Each block is labelled with **WHERE** it runs:
- 💻 **Mac** = your laptop terminal
- 🖥️ **Server** = the Windows server, in **PowerShell as Administrator** (RDP in first)
- 🌐 **GitHub** = your repository in the browser

Deploys run on **GitHub-hosted runners**, which reach the server over **SSH**.

---

## Step 0 — What you need first
- The Windows server running, with its **public IP** (e.g. `54.175.194.187`) and
  RDP access as **Administrator**.
- Your project in a **GitHub repo** (backend + frontend + the files from this folder).
- Git installed on your Mac.

---

## Step 1 — 💻 Mac: create the SSH key the pipeline will use

```bash
ssh-keygen -t ed25519 -f ~/.ssh/iis_deploy -N ""
# creates ~/.ssh/iis_deploy (PRIVATE) and ~/.ssh/iis_deploy.pub (PUBLIC)

cat ~/.ssh/iis_deploy.pub     # copy this whole line — you'll paste it on the server
```

Keep the **private** key (`iis_deploy`) for a GitHub secret in Step 6.

---

## Step 2 — 🖥️ Server: install the web stack

```powershell
Install-WindowsFeature -Name Web-Server -IncludeManagementTools

# ASP.NET Core 8 Hosting Bundle (gives IIS the ASP.NET Core Module)
Invoke-WebRequest "https://aka.ms/dotnet/8.0/dotnet-hosting-win.exe" -OutFile C:\hosting.exe
Start-Process C:\hosting.exe -ArgumentList "/quiet /norestart" -Wait

# URL Rewrite (needed for Angular routing) — download from:
#   https://www.iis.net/downloads/microsoft/url-rewrite   then run the installer
# (or use your own mirror)

net stop was /y; net start w3svc
```

## Step 3 — 🖥️ Server: folders, app pools, and the two sites

```powershell
Import-Module WebAdministration

New-Item -ItemType Directory -Force -Path C:\inetpub\api, C:\inetpub\web, C:\deploy-incoming, C:\deploy-backups
Remove-Website -Name "Default Web Site" -ErrorAction SilentlyContinue

# API site (ASP.NET Core) on port 8080 — pool uses "No Managed Code"
New-WebAppPool -Name "SimpleWebApp-Api"
Set-ItemProperty "IIS:\AppPools\SimpleWebApp-Api" -Name managedRuntimeVersion -Value ""
New-Website -Name "SimpleWebApp-Api" -Port 8080 -PhysicalPath "C:\inetpub\api" -ApplicationPool "SimpleWebApp-Api"

# Web site (Angular static) on port 80
New-WebAppPool -Name "SimpleWebApp-Web"
New-Website -Name "SimpleWebApp-Web" -Port 80 -PhysicalPath "C:\inetpub\web" -ApplicationPool "SimpleWebApp-Web"
```

## Step 4 — 🖥️ Server: enable SSH and install your public key

```powershell
# Install + start OpenSSH server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic

# Make PowerShell the default SSH shell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force

# Key-only login (no SSH passwords)
(Get-Content C:\ProgramData\ssh\sshd_config) -replace '#?PasswordAuthentication.*','PasswordAuthentication no' |
  Set-Content C:\ProgramData\ssh\sshd_config

# Paste the PUBLIC key from Step 1 between the quotes:
$pub = "ssh-ed25519 AAAA...PASTE_YOUR_PUBLIC_KEY... you@mac"
Add-Content C:\ProgramData\ssh\administrators_authorized_keys $pub

# Lock down the file (required or sshd ignores it)
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F" /grant "SYSTEM:F"

Restart-Service sshd
```

## Step 5 — Open the ports

🖥️ **Server (Windows firewall):**
```powershell
New-NetFirewallRule -DisplayName "HTTP 80"  -Direction Inbound -Protocol TCP -LocalPort 80   -Action Allow
New-NetFirewallRule -DisplayName "API 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
# (OpenSSH already added a rule for port 22)
```

🌐 **AWS security group** (EC2 → the instance's security group → Inbound rules):

| Port | Purpose | Source |
|------|---------|--------|
| 22   | SSH (deploy) | `0.0.0.0/0` (key-only, so acceptable for a lab) |
| 80   | Web site | `0.0.0.0/0` |
| 8080 | API site | `0.0.0.0/0` |
| 3389 | RDP (you) | your IP only |

## Step 6 — 💻 Mac: test SSH works BEFORE touching the pipeline

```bash
ssh -i ~/.ssh/iis_deploy Administrator@YOUR_SERVER_IP "whoami"
# should print the server user and NOT ask for a password
```
If this fails, fix it now — the pipeline can't deploy until this works. (See Troubleshooting.)

---

## Step 7 — 🌐 GitHub: add secrets and environments

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret            | Value |
|-------------------|-------|
| `SSH_HOST`        | your server's public IP |
| `SSH_USER`        | `Administrator` |
| `SSH_PRIVATE_KEY` | the **entire contents** of `~/.ssh/iis_deploy` (the private file) |

To copy the private key on Mac: `pbcopy < ~/.ssh/iis_deploy` then paste.

**Settings → Environments →** create `development`, `staging`, `production`.
On `production`, add a **required reviewer** (approval before prod deploys).

## Step 8 — 💻 Mac: put the files in the repo and set prod URLs

Repo layout:
```
your-repo/
├─ backend/
├─ frontend/
├─ deploy/deploy.ps1                 # from ci-cd-solution/deploy/
└─ .github/workflows/{ci,release,deploy}.yml   # from ci-cd-solution/workflows/
```

Edit two files so the two sites can talk:
- `frontend/src/environments/environment.production.ts` → `apiUrl: 'http://YOUR_SERVER_IP:8080'`
- `backend/SimpleWebApp.Api/appsettings.Production.json` → add `http://YOUR_SERVER_IP` to `Cors:AllowedOrigins`

Commit and push:
```bash
git add .
git commit -m "Add CI/CD pipelines and deploy script"
git push origin main
```

## Step 9 — 🌐 GitHub: run the pipeline

1. Pushing to `main` triggers **Release** (and **CI** runs on PRs).
2. Go to **Actions → Deploy → Run workflow**, choose an environment (start with
   `development`), click **Run workflow**.
3. Watch the run: it builds + tests, SSHes in, backs up the current release,
   deploys, health-checks `:8080/health` and `:80/`, and finishes with
   **"SUCCESS: deploy healthy"** — or rolls back automatically on failure.

## Step 10 — Verify

- Open `http://YOUR_SERVER_IP/` → the Angular app.
- Open `http://YOUR_SERVER_IP:8080/health` → JSON `{"status":"healthy",...}`.
- **Test rollback once:** temporarily break the app (e.g. push a bad build),
  run Deploy → the run should go **red** but the old site should still load.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| SSH asks for a password / "Permission denied" | Public key not installed correctly. Recheck `administrators_authorized_keys` and the `icacls` permissions (Step 4). |
| `ssh` works but pipeline "Prepare SSH key" fails | `SSH_PRIVATE_KEY` secret must be the **full** private key including the `-----BEGIN/END-----` lines. |
| Deploy step: "Stop-WebAppPool not recognized" | The remote default shell isn't PowerShell — redo the `DefaultShell` registry step and `Restart-Service sshd`. |
| Health check fails on `:8080/health` | The **Hosting Bundle** isn't installed, or the API app pool isn't "No Managed Code". |
| API returns but the web page can't load data | Frontend `apiUrl` or backend CORS origin not set (Step 8). |
| Files locked during copy | The app pool didn't stop; `deploy.ps1` already stops pools first — make sure the pool **names** match. |

## One honest note on security
GitHub-hosted runners use a huge, changing IP range, so you can't whitelist them
on port 22. That's why SSH is **key-only**. If you'd rather not expose SSH at all,
the alternative is a **self-hosted runner on the server** (no inbound port
needed) — but that's a different setup from the GitHub-hosted one you're using.
