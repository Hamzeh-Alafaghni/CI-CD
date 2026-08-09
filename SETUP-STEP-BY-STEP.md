# Step-by-Step Setup — Windows Server + GitHub Secrets

Everything you need, in order, with exact names. Do the parts in this order:
**A) Server → B) SSH key → C) GitHub secrets → D) Run it.**

---

## Reference table — the exact names (don't change these)

These names must match between the server and your Deploy workflow (`deploy.yml`).
Use them exactly.

| Thing | Frontend (Angular) | Backend (.NET API) |
|-------|--------------------|--------------------|
| **IIS site name** | `SimpleWebApp-Web` | `SimpleWebApp-Api` |
| **App pool name** | `SimpleWebApp-Web` | `SimpleWebApp-Api` |
| **Folder on server** | `C:\inetpub\web` | `C:\inetpub\api` |
| **Port** | `80` | `8080` |
| **Managed code** | (default) | **No Managed Code** |

Other fixed paths:
- Upload folder (pipeline drops files here): `C:\deploy-incoming`
- Backups folder (rollback copies): `C:\deploy-backups`

**Q: Are the backend and frontend on the same site?**
**No — they are on two SEPARATE sites.** The frontend is static files served on
port 80; the backend is a .NET app served on port 8080. Different app pools too,
so one crashing can't take the other down.

**Q: Is the app pool name the same as the site name?**
**Yes.** For each app we create a pool and a site with the *same* name
(`SimpleWebApp-Web` and `SimpleWebApp-Api`). The pool name is **not** a secret —
it's just an IIS label. It never leaves the server.

---

# PART A — Set up the Windows Server

RDP into the server as **Administrator**, open **PowerShell as Administrator**
(right-click → Run as administrator), and run each block.

### A1. Install IIS + the .NET hosting bundle + URL Rewrite

```powershell
# IIS web server + management tools
Install-WindowsFeature -Name Web-Server -IncludeManagementTools

# ASP.NET Core 8 Hosting Bundle (lets IIS run the .NET API)
Invoke-WebRequest "https://aka.ms/dotnet/8.0/dotnet-hosting-win.exe" -OutFile C:\hosting.exe
Start-Process C:\hosting.exe -ArgumentList "/quiet /norestart" -Wait

# URL Rewrite (needed for Angular page routing) — download & install from:
#   https://www.iis.net/downloads/microsoft/url-rewrite

# restart IIS so the new module loads
net stop was /y
net start w3svc
```

### A2. Create the folders

```powershell
Import-Module WebAdministration
New-Item -ItemType Directory -Force -Path C:\inetpub\api, C:\inetpub\web, C:\deploy-incoming, C:\deploy-backups
```

### A3. Create the TWO app pools and TWO sites — MANUALLY in IIS Manager

Do this by hand in the **IIS Manager** GUI (not PowerShell).

**Open IIS Manager:** click Start, type `inetmgr`, press Enter (or Start → search
"Internet Information Services (IIS) Manager").

#### A3.1 — Remove the Default Web Site (to free port 80)
1. In the left **Connections** pane, expand your server → expand **Sites**.
2. Click **Default Web Site**.
3. In the right **Actions** pane, click **Remove** → **Yes**.

#### A3.2 — Create the two Application Pools
1. In the left pane, right-click **Application Pools** → **Add Application Pool…**
2. Create the **backend** pool:
   - **Name:** `SimpleWebApp-Api`
   - **.NET CLR version:** select **"No Managed Code"**  ← important for the .NET API
   - **Managed pipeline mode:** Integrated
   - Click **OK**.
3. Right-click **Application Pools** → **Add Application Pool…** again for the **frontend** pool:
   - **Name:** `SimpleWebApp-Web`
   - **.NET CLR version:** leave the default (it's only static files, so it doesn't matter)
   - Click **OK**.

You should now see both pools listed under **Application Pools**.

#### A3.3 — Create the BACKEND site (SimpleWebApp-Api, port 8080)
1. In the left pane, right-click **Sites** → **Add Website…**
2. Fill in:
   - **Site name:** `SimpleWebApp-Api`
   - **Application pool:** click **Select…** → choose `SimpleWebApp-Api` → **OK**
   - **Physical path:** `C:\inetpub\api`
   - **Binding → Type:** `http`
   - **IP address:** All Unassigned
   - **Port:** `8080`
   - **Host name:** leave blank
3. Click **OK**.

#### A3.4 — Create the FRONTEND site (SimpleWebApp-Web, port 80)
1. Right-click **Sites** → **Add Website…** again.
2. Fill in:
   - **Site name:** `SimpleWebApp-Web`
   - **Application pool:** click **Select…** → choose `SimpleWebApp-Web` → **OK**
   - **Physical path:** `C:\inetpub\web`
   - **Binding → Type:** `http`
   - **Port:** `80`
   - **Host name:** leave blank
3. Click **OK**.

#### A3.5 — Check
Click **Sites** in the left pane. You should see **SimpleWebApp-Api** (port 8080)
and **SimpleWebApp-Web** (port 80), both **Started**. If a site shows "Stopped",
select it and click **Start** in the Actions pane.

> The site name, the pool name, the folder, and the port must be **exactly** as
> above — that's what your Deploy workflow (`deploy.yml`) targets.

### A4. Enable SSH so GitHub can deploy

```powershell
# install + start the OpenSSH server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic

# make PowerShell the shell SSH uses
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force

# turn OFF password login — key only
(Get-Content C:\ProgramData\ssh\sshd_config) -replace '#?PasswordAuthentication.*','PasswordAuthentication no' |
  Set-Content C:\ProgramData\ssh\sshd_config
Restart-Service sshd
```

> You'll paste your **public key** here in Part B, step B3. Come back after making
> the key.

### A5. Open the ports

Windows firewall (on the server):
```powershell
New-NetFirewallRule -DisplayName "HTTP 80"  -Direction Inbound -Protocol TCP -LocalPort 80   -Action Allow
New-NetFirewallRule -DisplayName "API 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
# (OpenSSH already opened port 22)
```

AWS security group (EC2 console → your instance → Security → the security group →
**Edit inbound rules → Add rule**), add these four:

| Type | Port | Source |
|------|------|--------|
| SSH | 22 | **GitHub Actions IP ranges** (see below) — not `0.0.0.0/0` |
| HTTP | 80 | `0.0.0.0/0` |
| Custom TCP | 8080 | `0.0.0.0/0` |
| RDP | 3389 | **My IP** only |

Click **Save rules**.

**Locking down port 22 (best practice).** The deploy runs on GitHub's Windows
runners, so only GitHub's IPs need SSH. Instead of opening 22 to the whole
internet, restrict it to GitHub Actions' published ranges:

1. Get the current ranges (they rotate, so refresh occasionally):
   ```bash
   curl -s https://api.github.com/meta | jq -r '.actions[]'
   ```
2. Add SSH (port 22) inbound rules for those CIDR blocks instead of `0.0.0.0/0`.

Login is also **key-only** (passwords are disabled), so even the GitHub ranges
can't log in without your private key. If managing many ranges is too much for a
short lab, `0.0.0.0/0` with key-only is a fallback — but the ranges are the
correct practice.

> Zero-exposure alternative: use a **self-hosted GitHub runner installed on the
> server** instead of the hosted Windows runner. Then no inbound SSH port is
> needed at all — the runner pulls jobs outbound. (This project uses the hosted
> runner + SSH so you learn the SSH connection flow.)

---

# PART B — Create the SSH key (on your Mac)

The pipeline logs in with an SSH **key**, not a password. You make the key once.

### B1. Generate the key
```bash
ssh-keygen -t ed25519 -f ~/.ssh/iis_deploy -N ""
```
This makes two files:
- `~/.ssh/iis_deploy` = **private** key → goes into a GitHub secret (Part C)
- `~/.ssh/iis_deploy.pub` = **public** key → goes on the server (next step)

> `-N ""` means the key has **no passphrase**. That's on purpose — automation
> can't type a passphrase. The key file itself is the secret.

### B2. Copy the public key
```bash
cat ~/.ssh/iis_deploy.pub
```
Copy the whole line (starts with `ssh-ed25519 ...`).

### B3. Install the public key on the SERVER
Back in the server's PowerShell (as Administrator), paste your public key into the
quotes and run:
```powershell
$pub = "ssh-ed25519 AAAA...PASTE_YOUR_PUBLIC_KEY_HERE... you@mac"
Add-Content C:\ProgramData\ssh\administrators_authorized_keys $pub

# lock the file down (required, or SSH ignores it)
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F" /grant "SYSTEM:F"
Restart-Service sshd
```

### B4. Test it from your Mac
```bash
ssh -i ~/.ssh/iis_deploy Administrator@YOUR_SERVER_IP "whoami"
```
It should print the user **without asking for a password**. If it works, the hard
part is done. If it asks for a password, recheck B3 (usually the file permissions).

---

# PART C — Add the GitHub secrets (click by click)

### What secrets do I need? (exactly 3)

| # | Secret name | What to put in it | Needs a password? |
|---|-------------|-------------------|-------------------|
| 1 | `SSH_HOST` | Your server's public IP, e.g. `54.175.194.187` | No |
| 2 | `SSH_USER` | `Administrator` | No |
| 3 | `SSH_PRIVATE_KEY` | The **entire contents** of `~/.ssh/iis_deploy` (private key file) | No |

**About passwords:** you do **not** store any Windows password as a secret. The
pipeline logs in with the SSH **key**, so there's no password to add. The key was
created with no passphrase (Part B1), so none of the three secrets needs a
password. (The site/pool names are also **not** secrets — they stay on the server.)

### Steps to add them
1. Open your repo in a browser: **https://github.com/DevOpsBootCamp2026/simple-webapp**
2. Click the **Settings** tab (top of the repo).
3. In the left sidebar, expand **Secrets and variables** → click **Actions**.
4. Click the green **New repository secret** button.
5. Add secret #1:
   - **Name:** `SSH_HOST`
   - **Secret:** your server IP (e.g. `54.175.194.187`)
   - Click **Add secret**.
6. Click **New repository secret** again. Add #2:
   - **Name:** `SSH_USER`
   - **Secret:** `Administrator`
   - Click **Add secret**.
7. Click **New repository secret** again. Add #3:
   - **Name:** `SSH_PRIVATE_KEY`
   - **Secret:** the full private key. On your Mac, copy it exactly with:
     ```bash
     pbcopy < ~/.ssh/iis_deploy
     ```
     then paste into the box. It must include the `-----BEGIN OPENSSH PRIVATE KEY-----`
     and `-----END OPENSSH PRIVATE KEY-----` lines.
   - Click **Add secret**.

You should now see three secrets listed (values hidden).

### (Recommended) Create Environments for approvals
1. Still in **Settings**, click **Environments** in the left sidebar.
2. Click **New environment**, type `development`, click **Configure environment**.
   Repeat for `staging` and `production`.
3. Open `production` → tick **Required reviewers** → add yourself → **Save protection rules**.
   Now a production deploy **waits for your approval** before it runs.

---

# PART D — Run the pipeline

### D1. Push the code (from your Mac)
```bash
cd "/Users/KaramAlbataineh/Desktop/simple web/simple-webapp"
rm -f .git/index.lock
git add -A
git commit -m "Activate full CI/CD pipelines + deploy script and docs"
git push origin main
```

### D2. One config edit so the two sites can talk
Because the frontend (port 80) and backend (port 8080) are separate sites, tell
the frontend where the API is, and let the API accept the frontend's origin:
- `frontend/src/environments/environment.production.ts` →
  `apiUrl: 'http://YOUR_SERVER_IP:8080'`
- `backend/SimpleWebApp.Api/appsettings.Production.json` → add
  `http://YOUR_SERVER_IP` to `Cors:AllowedOrigins`

Commit and push again.

### D3. Deploy
1. On GitHub, open the **Actions** tab.
2. Click the **Deploy** workflow in the left list.
3. Click **Run workflow** (top right), choose an **environment**
   (start with `development`), then click the green **Run workflow**.
4. Watch it: it builds + tests, connects over SSH, backs up the current site,
   deploys, health-checks `http://SERVER:8080/health` and `http://SERVER/`, and
   ends with **"SUCCESS: deploy healthy"** — or rolls back automatically.

### D4. Verify
- Browse `http://YOUR_SERVER_IP/` → the Angular app loads.
- Browse `http://YOUR_SERVER_IP:8080/health` → JSON `{"status":"healthy",...}`.
- **Test rollback once:** deploy a deliberately broken build → the run goes red
  **but the old site still loads**. That proves the safety net works.

---

## One-page cheat sheet

| Item | Value |
|------|-------|
| Frontend site / pool | `SimpleWebApp-Web` |
| Frontend folder / port | `C:\inetpub\web` / `80` |
| Backend site / pool | `SimpleWebApp-Api` |
| Backend folder / port | `C:\inetpub\api` / `8080` (No Managed Code) |
| Upload folder | `C:\deploy-incoming` |
| Backups folder | `C:\deploy-backups` |
| Secret 1 | `SSH_HOST` = server IP |
| Secret 2 | `SSH_USER` = `Administrator` |
| Secret 3 | `SSH_PRIVATE_KEY` = contents of `~/.ssh/iis_deploy` |
| Passwords stored | **none** (SSH key auth) |
