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
