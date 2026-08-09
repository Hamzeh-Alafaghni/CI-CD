# Complete Guide — Set Up the Server, SSH, Secrets & CI/CD Pipeline

A single, ordered walkthrough for hosting the .NET + Angular app on IIS and
deploying it from GitHub-hosted runners over SSH, with automatic rollback.

**Read in this order:**
1. [Part 1 — Server setup (IIS, sites, OpenSSH, ports)](#doc-1--server-setup-explained-command-by-command)
2. [Part 2 — SSH keys & GitHub secrets](#doc-2--ssh-keys--github-secrets-in-detail)
3. [Part 3 — The pipelines, line by line](#doc-3--the-pipelines-explained-line-by-line)

---

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


---

# Doc 2 — SSH Keys & GitHub Secrets, in Detail

This document explains how the pipeline logs into the server **without a
password**, using an SSH key, and how we store that key safely in **GitHub
Secrets**. Read Doc 1 first (it installs the SSH server).

---

## Part 1 — What an SSH key actually is

An SSH **key pair** is two matching files:

- A **private key** (`iis_deploy`) — like the physical key to your house. You
  keep it secret. Anyone who has it can log in.
- A **public key** (`iis_deploy.pub`) — like a lock you can hand out freely. You
  install it on the server. It can only be *opened* by the matching private key.

**How login works, simply:** you put the public key (the lock) on the server.
When the pipeline connects, the server sends a challenge that only the holder of
the matching **private** key can answer correctly. No password is ever sent over
the network. That's why key login is both more secure and automatable.

The golden rule: **the private key never leaves your control** — it lives on your
Mac and inside a GitHub Secret, and nowhere else.

---

## Part 2 — Create the key (on your Mac)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/iis_deploy -N ""
```

- `ssh-keygen` — the standard tool that generates SSH key pairs.
- `-t ed25519` — the **type** (algorithm) of key. `ed25519` is modern, small, and
  secure — the recommended default today.
- `-f ~/.ssh/iis_deploy` — the **filename**. This creates two files:
  - `~/.ssh/iis_deploy` → the **private** key
  - `~/.ssh/iis_deploy.pub` → the **public** key
- `-N ""` — the key's **passphrase**, set to empty. We use no passphrase because
  the pipeline runs unattended and can't type one. (For a human's personal key
  you *would* set a passphrase.)

Look at the two files:

```bash
cat ~/.ssh/iis_deploy.pub     # PUBLIC — goes on the server (one line, starts "ssh-ed25519")
cat ~/.ssh/iis_deploy         # PRIVATE — goes into a GitHub Secret (many lines, BEGIN/END)
```

- The **public** key is what you paste into
  `administrators_authorized_keys` on the server (Doc 1, step 3.4).
- The **private** key is what you paste into the `SSH_PRIVATE_KEY` GitHub Secret
  (below). It looks like:
  ```
  -----BEGIN OPENSSH PRIVATE KEY-----
  b3BlbnNzaC1rZXk...
  ...several lines...
  -----END OPENSSH PRIVATE KEY-----
  ```
  You must copy **all of it**, including the BEGIN and END lines.

---

## Part 3 — What are GitHub Secrets?

**Secrets** are encrypted values you store in GitHub and reference in a workflow.
Key facts to teach:

- They are **encrypted at rest** and only decrypted inside a running job.
- Once saved, you **cannot read a secret back** in the UI — you can only replace
  it. (So keep your own copy of the private key.)
- GitHub automatically **masks** secret values in logs. If a secret value would
  appear in the output, it shows as `***`.
- You reference a secret in a workflow with the expression
  `${{ secrets.NAME }}`. You never write the actual value in the YAML.

There are two scopes:

- **Repository secrets** — available to all workflows in the repo. Simple; use
  these to start.
- **Environment secrets** — attached to a specific environment
  (`development` / `staging` / `production`) and only available to jobs that
  declare `environment: production`. Use these to give production different
  credentials and to require approvals.

---

## Part 4 — Exactly which secrets to create

For this project you create **three** secrets:

| Secret name       | What it is | Example value | Where it's used |
|-------------------|-----------|---------------|-----------------|
| `SSH_HOST`        | The server's public IP or hostname | `54.175.194.187` | `deploy.yml` — the address to SSH into |
| `SSH_USER`        | The Windows account to log in as | `Administrator` | `deploy.yml` — the SSH username |
| `SSH_PRIVATE_KEY` | The **full contents** of the private key file `~/.ssh/iis_deploy` | `-----BEGIN OPENSSH PRIVATE KEY-----` … | `deploy.yml` — used to authenticate the SSH connection |

That's all three. The **public** key is *not* a secret — it lives on the server.

---

## Part 5 — How to add the secrets (step by step in the GitHub UI)

1. Open your repository on github.com.
2. Click **Settings** (top menu of the repo).
3. In the left sidebar: **Secrets and variables → Actions**.
4. Click the green **New repository secret** button.
5. **Name:** type `SSH_HOST`. **Secret:** type your server IP. Click **Add secret**.
6. Repeat for `SSH_USER` = `Administrator`.
7. Repeat for `SSH_PRIVATE_KEY`. For the value, paste the **entire** private key.
   Easiest way to copy it exactly on a Mac:
   ```bash
   pbcopy < ~/.ssh/iis_deploy      # now the private key is on your clipboard
   ```
   Then paste into the Secret box and click **Add secret**.

You should end up with three secrets listed (their values hidden).

---

## Part 6 — Create Environments (recommended)

Environments let you scope secrets and require approval for production.

1. **Settings → Environments → New environment.**
2. Create three: `development`, `staging`, `production`.
3. Open `production` → enable **Required reviewers** → add yourself. Now a
   production deploy **pauses and waits for your approval** before it runs.
4. (Optional) Move the three secrets to be **environment secrets** under each
   environment instead of repository-wide, so prod can use a different key.

Our `deploy.yml` already binds each run to the chosen environment with:
```yaml
environment: ${{ github.event.inputs.environment }}
```
That single line is what activates the approval rule and the environment's secrets.

---

## Part 7 — How the pipeline USES the secrets

Inside `deploy.yml`, the deploy job turns the secret into a usable key file:

```yaml
- name: Prepare SSH key
  run: |
    mkdir -p ~/.ssh
    printf '%s\n' "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_ed25519
    chmod 600 ~/.ssh/id_ed25519
    ssh-keyscan -H "${{ secrets.SSH_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null
```

Line by line:

- `mkdir -p ~/.ssh` — create the SSH folder on the runner (`-p` = don't error if
  it already exists).
- `printf '%s\n' "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_ed25519` — write the
  secret's value into a private key file on the runner. `${{ secrets.SSH_PRIVATE_KEY }}`
  is replaced by the decrypted key at runtime (and masked in logs).
- `chmod 600 ~/.ssh/id_ed25519` — set file permissions so only the owner can read
  it. SSH **refuses** to use a private key that others can read, so this is
  required.
- `ssh-keyscan -H "${{ secrets.SSH_HOST }}" >> ~/.ssh/known_hosts` — fetch the
  server's host fingerprint and record it, so SSH doesn't stop to ask "are you
  sure you want to connect to this unknown host?" `-H` hashes the hostname in the
  file; `2>/dev/null` hides the noisy status output.

Then the deploy uses the key and the other two secrets:

```yaml
- name: Copy package + script to server
  run: |
    scp -i ~/.ssh/id_ed25519 api.zip web.zip deploy/deploy.ps1 \
      ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}:C:/deploy-incoming/

- name: Deploy with automatic rollback
  run: |
    ssh -i ~/.ssh/id_ed25519 ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }} \
      "powershell -ExecutionPolicy Bypass -File C:/deploy-incoming/deploy.ps1 -Environment ${{ github.event.inputs.environment }}"
```

- `scp -i <key> <files> user@host:dest` — **secure copy**: uploads the two zips
  and the deploy script to `C:\deploy-incoming` on the server. `-i` picks the key
  we just wrote.
- `ssh -i <key> user@host "<command>"` — opens an SSH session and runs a command
  remotely. Here it launches PowerShell on the server to run `deploy.ps1`.
- `${{ secrets.SSH_USER }}` and `${{ secrets.SSH_HOST }}` are substituted from the
  secrets — the real username/IP never appear in the YAML.

---

## Part 8 — Security do's and don'ts (teach these)

**Do**
- Reference secrets only by name: `${{ secrets.NAME }}`.
- Keep the private key's passphrase empty **only** because it's automation; store
  the key itself as a secret, never in the repo.
- Use a **separate** deploy key per project, so you can revoke one without
  affecting others.
- Use environment protection + required reviewers for production.

**Don't**
- Never commit a private key to the repo (add `*.pem`, `id_*`, `iis_deploy` to
  `.gitignore`).
- Never `echo` a secret to prove it works — even though it's masked, it's a bad
  habit.
- Never paste a real password/key into the YAML file itself.

---

## Quick recap
1. `ssh-keygen` makes a **private** + **public** key.
2. **Public** key → server (`administrators_authorized_keys`, Doc 1).
3. **Private** key → GitHub Secret `SSH_PRIVATE_KEY`.
4. Also add `SSH_HOST` and `SSH_USER`.
5. The pipeline writes the private key to a file, `chmod 600`s it, and uses
   `scp`/`ssh` to deploy — with everything pulled from secrets, never hard-coded.

Next: **Doc 3** explains every line of the three pipeline files and the deploy
script.


---

# Doc 3 — The Pipelines, Explained Line by Line

This document walks through all four files:
1. Common YAML concepts (read this first)
2. `ci.yml`
3. `release.yml`
4. `deploy.yml`
5. `deploy.ps1`

---

## 1. YAML concepts you'll see everywhere

A GitHub Actions **workflow** is a YAML file in `.github/workflows/`. The building
blocks:

- `name:` — the workflow's display name in the Actions tab.
- `on:` — the **triggers**: what events start the workflow (a push, a PR, a manual
  click…).
- `permissions:` — what the automatic `GITHUB_TOKEN` is allowed to do. Keep it as
  small as possible ("least privilege").
- `concurrency:` — prevents two runs of the same thing overlapping.
- `jobs:` — one or more units of work. **Jobs run in parallel** unless one
  `needs:` another. Each job runs on a fresh virtual machine (`runs-on:`).
- `steps:` — the ordered actions inside a job. A step is either:
  - `uses:` — run a prebuilt **action** (e.g. `actions/checkout@v4`), or
  - `run:` — run shell commands.
- `${{ ... }}` — an **expression**: GitHub substitutes a value here (a secret, an
  input, a job output, etc.).

---

## 2. `ci.yml` — the quality gate

```yaml
name: CI
```
The workflow is called "CI" in the Actions tab.

```yaml
on:
  pull_request:
    branches: [main]
  push:
    branches-ignore: [main]
  workflow_dispatch: {}
```
Triggers:
- `pull_request: branches: [main]` — run whenever someone opens/updates a PR that
  targets `main`. This is the gate that protects `main`.
- `push: branches-ignore: [main]` — also run on pushes to any branch **except**
  `main` (so work-in-progress branches get checked too).
- `workflow_dispatch: {}` — allow starting it manually from the UI.

```yaml
permissions:
  contents: read
```
The token can only **read** the repo. CI doesn't create releases or write
anything, so it needs nothing more.

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```
If you push twice quickly to the same branch (`github.ref`), cancel the older run
and keep the newest. Saves time and runner minutes.

```yaml
jobs:
  backend:
    name: Backend (.NET) build & test
    runs-on: ubuntu-latest
```
The first job, running on a fresh Ubuntu VM.

```yaml
    steps:
      - uses: actions/checkout@v4
```
Downloads your repository onto the runner. Almost every job starts with this —
without it the runner has no code.

```yaml
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "8.0.x"
```
Installs the .NET 8 SDK. `with:` passes inputs to the action — here, which SDK
version.

```yaml
      - name: Restore
        run: dotnet restore backend/SimpleWebApp.sln
```
Downloads the NuGet packages the solution depends on.

```yaml
      - name: Build (Release)
        run: dotnet build backend/SimpleWebApp.sln --configuration Release --no-restore
```
Compiles in **Release** configuration. `--no-restore` skips restoring again (we
just did it) for speed.

```yaml
      - name: Test (Release)
        run: dotnet test backend/SimpleWebApp.sln --configuration Release --no-build
```
Runs the tests. **Key detail:** `--configuration Release` must match the build,
and `--no-build` reuses the compiled output. If you build Release but test the
default (Debug), the test can't find the binaries and fails — this is a very
common mistake.

```yaml
  frontend:
    name: Frontend (Angular) build & test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
```
A second job (runs in parallel with `backend`). Checks out the code and installs
Node.js 20.

```yaml
      - name: Install
        working-directory: frontend
        run: npm install
```
`working-directory: frontend` runs the command inside the `frontend/` folder.
`npm install` downloads the Angular dependencies.

```yaml
      - name: Build (production)
        working-directory: frontend
        run: npm run build -- --configuration=production
```
Builds the Angular app. The `--` passes the flag through npm to the Angular CLI,
selecting the production configuration.

```yaml
      - name: Test (headless)
        working-directory: frontend
        run: npm test -- --watch=false --browsers=ChromeHeadless
        continue-on-error: true
```
Runs frontend unit tests once (`--watch=false`) in a headless browser.
`continue-on-error: true` means a test failure won't fail the whole job — useful
while the class hasn't written many specs yet. (Remove it to make tests mandatory.)

---

## 3. `release.yml` — version, package, tag, release

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch: {}
```
Runs on every push to `main` (i.e. after a PR merges), or manually.

```yaml
permissions:
  contents: write
```
This workflow **creates tags and releases**, which are writes to the repo — so
the token needs `contents: write`. (Compare to CI's `read`.)

```yaml
concurrency:
  group: release-main
  cancel-in-progress: false
```
Only one release runs at a time. `cancel-in-progress: false` means a running
release is **allowed to finish** rather than being cancelled by a new push — you
don't want to interrupt a release halfway.

```yaml
jobs:
  version:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.v.outputs.version }}
      tag: ${{ steps.v.outputs.tag }}
    steps:
      - id: v
        run: |
          echo "version=1.0.${{ github.run_number }}" >> $GITHUB_OUTPUT
          echo "tag=v1.0.${{ github.run_number }}"     >> $GITHUB_OUTPUT
```
- `outputs:` — this job **publishes** two values other jobs can read.
- `github.run_number` — an integer that increases by one every time the workflow
  runs; we use it to build a unique version like `1.0.42`.
- `echo "name=value" >> $GITHUB_OUTPUT` — the mechanism to set a step output.
- `id: v` — names the step so we can reference `steps.v.outputs.version`.

```yaml
  backend:
    needs: version
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "8.0.x"
      - name: Test before release
        run: dotnet test backend/SimpleWebApp.sln --configuration Release
```
- `needs: version` — wait for the `version` job and gain access to its outputs.
- We **test before releasing** — never cut a release from an untested build.

```yaml
      - name: Publish (stamp version)
        run: >
          dotnet publish backend/SimpleWebApp.Api/SimpleWebApp.Api.csproj
          --configuration Release --runtime win-x64 --self-contained false
          -p:Version=${{ needs.version.outputs.version }}
          --output publish/api
```
- `dotnet publish` — compiles and prepares the app for deployment.
- `--runtime win-x64` — target Windows (the IIS server).
- `--self-contained false` — rely on the .NET runtime installed on the server
  (the Hosting Bundle), rather than bundling it — smaller output.
- `-p:Version=...` — **stamps the version** into the compiled DLLs, so you can
  tell which build you're looking at. Uses the value from the `version` job.
- `> ` (the folded block) just lets one command span several lines.

```yaml
      - name: Zip (versioned)
        run: cd publish/api && zip -r "$GITHUB_WORKSPACE/backend-${{ needs.version.outputs.version }}.zip" .
```
Zips the published output. `cd publish/api && ... .` zips the **contents** of the
folder (the trailing `.`), not the folder itself, so files sit at the zip root.
The filename includes the version.

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: backend
          path: backend-*.zip
```
Uploads the zip as an **artifact** so later jobs (and you) can download it.

```yaml
  frontend:
    needs: version
    ...
      - name: Zip (versioned, contents at root)
        run: cd frontend/dist/frontend/browser && zip -r "$GITHUB_WORKSPACE/frontend-${{ needs.version.outputs.version }}.zip" .
```
Same pattern for the Angular build. Note the path `dist/frontend/browser` — that's
where Angular's modern builder puts the final files.

```yaml
  release:
    needs: [version, backend, frontend]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts
```
- `needs: [version, backend, frontend]` — wait for all three, then run.
- `download-artifact` with `path: artifacts` — pulls every uploaded artifact into
  an `artifacts/` folder.

```yaml
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ needs.version.outputs.tag }}
          name: Release ${{ needs.version.outputs.tag }}
          generate_release_notes: true
          files: |
            artifacts/backend/*.zip
            artifacts/frontend/*.zip
```
Creates the **git tag** and a **GitHub Release**:
- `tag_name` / `name` — the tag (e.g. `v1.0.42`) and release title.
- `generate_release_notes: true` — GitHub auto-writes notes from merged PRs.
- `files:` — attach both zips to the release for download.

---

## 4. `deploy.yml` — build, ship over SSH, roll back

The header is like the others; the new parts are the inputs and the SSH job.

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        description: "Target environment"
        required: true
        type: choice
        default: development
        options: [development, staging, production]
      version:
        description: "Version label (e.g. 1.0.42)"
        required: false
        default: "manual"
```
- `workflow_dispatch` with `inputs` — a **manual** workflow that shows a form.
- `environment` is a **dropdown** (`type: choice`) with three options; the person
  running it picks one.
- `version` is an optional text label.

```yaml
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Map environment names
        id: map
        run: |
          case "${{ github.event.inputs.environment }}" in
            development) echo "aspnet=Development" >> $GITHUB_OUTPUT; echo "ng=development" >> $GITHUB_OUTPUT ;;
            staging)     echo "aspnet=Staging"     >> $GITHUB_OUTPUT; echo "ng=staging"     >> $GITHUB_OUTPUT ;;
            production)  echo "aspnet=Production"   >> $GITHUB_OUTPUT; echo "ng=production"   >> $GITHUB_OUTPUT ;;
          esac
```
Translates the lowercase dropdown choice into the exact names each tool expects:
`Development` (for ASP.NET's `ASPNETCORE_ENVIRONMENT`) and `development` (for the
Angular build configuration). A `case` statement is just "if the input is X, set
these outputs."

```yaml
      - name: Test before packaging
        run: dotnet test backend/SimpleWebApp.sln --configuration Release
```
Test first — don't package a failing build.

```yaml
      - name: Publish backend (win-x64)
        run: >
          dotnet publish backend/SimpleWebApp.Api/SimpleWebApp.Api.csproj
          --configuration Release --runtime win-x64 --self-contained false
          --output publish/api
      - name: Stamp environment into web.config
        run: sed -i 's/value="Production"/value="${{ steps.map.outputs.aspnet }}"/' publish/api/web.config
```
- Publish the API.
- `sed -i 's/old/new/' file` — an in-place find-and-replace in `web.config`. It
  swaps the default `ASPNETCORE_ENVIRONMENT` value (`Production`) for the one the
  user picked. **This is what actually makes the backend package
  environment-specific** — setting an env var during publish does nothing to the
  output, but editing `web.config` does.

```yaml
      - name: Zip API (contents at root)
        run: cd publish/api && zip -r "$GITHUB_WORKSPACE/api.zip" .
      ...
      - name: Zip Web (contents at root)
        run: cd frontend/dist/frontend/browser && zip -r "$GITHUB_WORKSPACE/web.zip" .
      - uses: actions/upload-artifact@v4
        with:
          name: deploy-${{ github.event.inputs.environment }}
          path: |
            api.zip
            web.zip
```
Zip both apps (contents at the zip root) and upload them together as one artifact
named after the environment.

```yaml
  deploy:
    needs: build-and-test
    runs-on: ubuntu-latest
    environment: ${{ github.event.inputs.environment }}
```
- `needs: build-and-test` — only deploy after the build/test/package job passed.
- `environment: ...` — binds this job to the chosen GitHub Environment, which
  activates its **required reviewers** (approval) and **environment secrets**.

```yaml
    steps:
      - uses: actions/checkout@v4
      - name: Download the package
        uses: actions/download-artifact@v4
        with:
          name: deploy-${{ github.event.inputs.environment }}
          path: .
```
Checkout again (to get `deploy/deploy.ps1`) and download the zips into the current
folder.

```yaml
      - name: Prepare SSH key
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "${{ secrets.SSH_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null
```
Explained fully in **Doc 2, Part 7**: write the private key from the secret to a
file, lock its permissions, and record the server's fingerprint.

```yaml
      - name: Copy package + script to server
        run: |
          ssh -i ~/.ssh/id_ed25519 ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }} \
            "powershell -Command \"New-Item -ItemType Directory -Force -Path C:\deploy-incoming | Out-Null\""
          scp -i ~/.ssh/id_ed25519 api.zip web.zip deploy/deploy.ps1 \
            ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}:C:/deploy-incoming/
```
- First `ssh` command: make sure `C:\deploy-incoming` exists on the server.
- `scp` (secure copy): upload the two zips and the deploy script into that folder.

```yaml
      - name: Deploy with automatic rollback
        run: |
          ssh -i ~/.ssh/id_ed25519 ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }} \
            "powershell -ExecutionPolicy Bypass -File C:/deploy-incoming/deploy.ps1 -Environment ${{ github.event.inputs.environment }}"
```
Runs the deploy script **on the server** over SSH:
- `-ExecutionPolicy Bypass` — allow this one script to run without changing the
  server's global policy.
- `-File ...deploy.ps1` — the script to run.
- `-Environment <choice>` — passes the selected environment into the script.

If `deploy.ps1` exits non-zero (because it rolled back), this step fails and the
whole run is marked red — but the site is already restored.

---

## 5. `deploy.ps1` — backup, deploy, health-check, rollback (runs on the server)

```powershell
param(
    [string]$Environment = "development",
    [string]$Incoming    = "C:\deploy-incoming"
)
```
`param(...)` declares the script's **inputs**. The pipeline passes `-Environment`;
`$Incoming` defaults to the upload folder.

```powershell
$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
```
- `$ErrorActionPreference = 'Stop'` — make **any** error stop the script (and jump
  to `catch`). Without this, PowerShell would keep going after a failed command —
  dangerous mid-deploy.
- `Import-Module WebAdministration` — load the IIS cmdlets.

```powershell
$apiPool   = "SimpleWebApp-Api"
$apiPath   = "C:\inetpub\api"
$apiHealth = "http://localhost:8080/health"
$webPool   = "SimpleWebApp-Web"
$webPath   = "C:\inetpub\web"
$webHealth = "http://localhost/"
$backupRoot = "C:\deploy-backups"
$stamp      = Get-Date -Format 'yyyyMMdd_HHmmss'
```
Configuration variables. `$stamp` is a timestamp like `20260808_143210`, used to
name each backup uniquely. **These names must match Doc 1's site/pool names.**

```powershell
function Backup-Site($path, $name) {
    if ((Test-Path $path) -and (Get-ChildItem $path -Force | Select-Object -First 1)) {
        $b = Join-Path $backupRoot "${name}_$stamp"
        Copy-Item $path $b -Recurse -Force
        return $b
    }
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    return $null
}
```
Backs up a site **only if it already has files** (`Test-Path` = folder exists,
`Get-ChildItem … Select -First 1` = has at least one file). If so, it copies the
folder to a timestamped backup and returns that path. If it's the first deploy, it
just ensures the folder exists and returns `$null` (nothing to roll back to). This
function is **Principle 3** — back up before overwriting.

```powershell
function Deploy-Zip($zip, $path) {
    $tmp = Join-Path $env:TEMP ("ex_" + [guid]::NewGuid())
    Expand-Archive $zip $tmp -Force
    if (Test-Path $path) { Get-ChildItem $path -Force | Remove-Item -Recurse -Force }
    Copy-Item (Join-Path $tmp '*') $path -Recurse -Force
    Remove-Item $tmp -Recurse -Force
}
```
Deploys one zip: extract it to a unique temp folder, wipe the live folder, copy
the new files in, then delete the temp folder. Extracting to temp first avoids a
half-extracted site if the zip is corrupt.

```powershell
function Restore-Site($backup, $path) {
    if ($backup) {
        Get-ChildItem $path -Force | Remove-Item -Recurse -Force
        Copy-Item (Join-Path $backup '*') $path -Recurse -Force
    }
}
```
The rollback helper: wipe the live folder and copy the backup back. Does nothing
if there was no backup (first deploy).

```powershell
function Test-Health($url) {
    Start-Sleep -Seconds 5
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
    if ($r.StatusCode -ne 200) { throw "Health check $url returned $($r.StatusCode)" }
}
```
**Principle 2** — the smoke test. Wait 5 seconds for the app to start, request the
URL, and `throw` (which triggers rollback) unless it returns HTTP **200**.

```powershell
$apiBackup = Backup-Site $apiPath "api"
$webBackup = Backup-Site $webPath "web"
```
Back up both sites before touching anything.

```powershell
try {
    Stop-WebAppPool $apiPool -ErrorAction SilentlyContinue
    Stop-WebAppPool $webPool -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
```
Enter the protected block. Stop the app pools so their files aren't **locked**
while we overwrite them. The 2-second pause lets Windows release the file handles.

```powershell
    Deploy-Zip (Join-Path $Incoming 'api.zip') $apiPath
    Deploy-Zip (Join-Path $Incoming 'web.zip') $webPath
    Start-WebAppPool $apiPool
    Start-WebAppPool $webPool
```
Deploy both zips, then start the pools again so the sites come back up.

```powershell
    Test-Health $apiHealth
    Test-Health $webHealth
    Write-Host "=== SUCCESS: deploy healthy ($Environment) ==="
}
```
Smoke-test both sites. If both return 200, the deploy is a success and the script
ends normally (exit code 0 → the pipeline step is green).

```powershell
catch {
    Write-Warning "DEPLOY FAILED: $($_.Exception.Message)"
    Stop-WebAppPool $apiPool -ErrorAction SilentlyContinue
    Stop-WebAppPool $webPool -ErrorAction SilentlyContinue
    Restore-Site $apiBackup $apiPath
    Restore-Site $webBackup $webPath
    Start-WebAppPool $apiPool -ErrorAction SilentlyContinue
    Start-WebAppPool $webPool -ErrorAction SilentlyContinue
    exit 1
}
```
**Principle 4** — rollback. If **anything** in the `try` failed (a bad copy, or a
health check that didn't return 200), we land here: stop the pools, restore both
sites from their backups, start the pools, and `exit 1`. Exit code 1 makes the
pipeline step **fail** — but the live site is already back to the previous,
working version.

---

## The mental model to give students
A deploy pipeline assumes failure will happen and plans for it:
1. **Test** the build (don't ship broken code).
2. **Back up** what's live (so you can undo).
3. **Deploy** the new version.
4. **Health-check** it (prove it runs, not just that files copied).
5. **Roll back** automatically if the check fails (never leave the site down).
