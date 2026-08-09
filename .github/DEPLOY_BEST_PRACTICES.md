# CI/CD Best Practices — CI, Release & Deploy

A pipeline is only "good" when it protects `main`, ships a versioned artifact you
can trace, and can deploy without leaving the site broken. This guide covers all
**three** workflows — with the points to follow and the correct code for each.

- [Part A — CI pipeline](#part-a--ci-pipeline-ciyml)
- [Part B — Release pipeline](#part-b--release-pipeline-releaseyml)
- [Part C — Deploy pipeline](#part-c--deploy-pipeline-deployyml)
- [Cross-cutting rules for all pipelines](#cross-cutting-rules-all-pipelines)

---

# ⚠️ Review checklist — what YOU must change

These are the exact issues found in **your** current pipelines. Fix the 🔴 items
first (they break the run or defeat the purpose), then the 🟡 items (best
practice / security). The corrected code for each is in Parts A–C below.

## CI (`ci.yml`)
- 🔴 **Filename typo:** the build step uses `SimpleWepApp.sln` — it must be
  `SimpleWebApp.sln`. As written, the build fails ("project not found").
- 🔴 **Test config mismatch:** you build `--configuration Release` but
  `dotnet test ... --no-build` defaults to **Debug**, so it can't find the
  binaries. Add `--configuration Release` to the test step.
- 🟡 **Be explicit about the frontend build config** (`-- --configuration=production`).
- 🟡 **Add caching + `concurrency`** (speed and cancelling superseded runs).

## Release (`release.yml`)
- 🔴 **No tests before releasing** — add `dotnet test` before you publish, so you
  never cut a release from an untested build.
- 🟡 **Artifacts aren't versioned:** your zips are `backend-app.zip` /
  `frontend-app.zip`. Stamp the version into the build (`-p:Version=`) and the
  filenames, so you can tell which build a zip is.
- 🟡 **Update the release action:** `softprops/action-gh-release@v1` is outdated —
  use `@v2` (ideally pinned to a commit SHA).
- 🟡 **Add a `concurrency` guard** so two merges don't cut overlapping releases.

## Deploy (`deploy.yml`)
- 🔴 **The backend package is NOT environment-specific.** You set
  `ASPNETCORE_ENVIRONMENT` during `dotnet publish`, but that's a *runtime*
  variable — it has no effect on the output. Stamp the environment into
  `web.config` instead (see Part C).
- 🔴 **It never actually deploys.** The last step only
  `echo "Simulating deployment..."`. There is no backup, no deploy, no health
  check, and no rollback. Implement the four missing pieces:
  - **Back up** the current release before overwriting it.
  - **Deploy** the new build (stop → swap → start).
  - **Health-check** the running app (require HTTP `200`).
  - **Roll back** to the backup if the health check fails.
- 🟡 **Frontend zip nesting:** you zip the whole `dist/` folder. Zip the *contents*
  of the build output instead, so IIS gets the files at the site root.
- 🟡 **Runner can't reach IIS:** `ubuntu-latest` can't touch a private server —
  use a **self-hosted runner on the box** (or SSH/WinRM).
- ✅ **Good already:** scoped `permissions`, secrets referenced by name, password
  not echoed. Keep this.

> Legend: 🔴 must fix (breaks the run or the goal) · 🟡 should fix (best
> practice/security) · ✅ already correct.

---

# Part A — CI pipeline (`ci.yml`)

**Goal:** a quality gate on every Pull Request to `main`, so broken code can't
be merged.

### Points to follow
1. **Trigger on PRs to `main`** (and pushes to non-main branches).
2. **Build *and* test both apps** — backend and frontend.
3. **Match configurations:** build and test in the **same** configuration. If you
   build `Release`, test `Release` too — otherwise `dotnet test --no-build` looks
   for Debug binaries that don't exist and fails.
4. **Reference the right files** — a single typo in a filename (e.g.
   `SimpleWepApp.sln`) breaks the whole job.
5. **Cache dependencies** (`cache: npm`, NuGet) for speed, and prefer `npm ci`
   with a committed `package-lock.json` for reproducible installs.
6. **Run lint / unit tests** (frontend tests headless).
7. **Least-privilege** `permissions: contents: read`, and `concurrency` to cancel
   superseded runs.

### Correct code

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches-ignore: [main]
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  backend:
    name: Backend (.NET) build & test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "8.0.x"
      - name: Restore
        run: dotnet restore backend/SimpleWebApp.sln
      - name: Build (Release)
        run: dotnet build backend/SimpleWebApp.sln --configuration Release --no-restore
      - name: Test (Release)          # SAME config as the build
        run: dotnet test backend/SimpleWebApp.sln --configuration Release --no-build

  frontend:
    name: Frontend (Angular) build & test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Install
        working-directory: frontend
        run: npm install
      - name: Build (production)
        working-directory: frontend
        run: npm run build -- --configuration=production
      - name: Test (headless)
        working-directory: frontend
        run: npm test -- --watch=false --browsers=ChromeHeadless
        continue-on-error: true
```

---

# Part B — Release pipeline (`release.yml`)

**Goal:** on every push to `main`, produce a versioned release you can trace —
tag + GitHub Release with artifacts.

### Points to follow
1. **Trigger on push to `main`** (after a PR merges).
2. **Test before releasing** — never cut a release from an untested build.
3. **Version everything:** compute a version and stamp it into the build
   (`-p:Version=`) *and* the artifact filenames — not just the git tag. You must
   be able to tell which build a zip came from.
4. **`contents: write`** permission (needed to create tags/releases).
5. **Pin third-party actions** and keep them current — use
   `softprops/action-gh-release@v2` (v1 is outdated); for supply-chain safety,
   pin marketplace actions to a commit SHA.
6. **Be idempotent & safe:** a `concurrency` guard so two merges don't cut
   overlapping releases; `generate_release_notes` for automatic notes.

### Correct code

```yaml
name: Release
on:
  push:
    branches: [main]
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: release-main
  cancel-in-progress: false

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
      - name: Publish (stamp version)
        run: >
          dotnet publish backend/SimpleWebApp.Api/SimpleWebApp.Api.csproj
          --configuration Release --runtime win-x64 --self-contained false
          -p:Version=${{ needs.version.outputs.version }}
          --output publish/backend
      - name: Zip (versioned name)
        run: cd publish/backend && zip -r "$GITHUB_WORKSPACE/backend-${{ needs.version.outputs.version }}.zip" .
      - uses: actions/upload-artifact@v4
        with:
          name: backend
          path: backend-*.zip

  frontend:
    needs: version
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Install
        working-directory: frontend
        run: npm install
      - name: Build (production)
        working-directory: frontend
        run: npm run build -- --configuration=production
      - name: Zip (versioned name)
        run: cd frontend/dist/frontend && zip -r "$GITHUB_WORKSPACE/frontend-${{ needs.version.outputs.version }}.zip" .
      - uses: actions/upload-artifact@v4
        with:
          name: frontend
          path: frontend-*.zip

  release:
    needs: [version, backend, frontend]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2        # current major version
        with:
          tag_name: ${{ needs.version.outputs.tag }}
          name: Release ${{ needs.version.outputs.tag }}
          generate_release_notes: true
          files: |
            artifacts/backend/*.zip
            artifacts/frontend/*.zip
```

---

# Part C — Deploy pipeline (`deploy.yml`)

**Goal:** deploy a build to IIS without ever leaving the site broken. Building a
package is **not** the same as having a working site — so test, back up, deploy,
health-check, and roll back.

### The five deploy principles

**1. Test *before* you package.** Never deploy a build you haven't tested; if
tests fail, stop before producing an artifact.
```yaml
- name: Test the backend
  run: dotnet test backend/SimpleWebApp.sln --configuration Release
```

**2. Smoke-test *after* you deploy.** Compiling is "does it build"; a smoke test
is "does it run." Call the health endpoint and require HTTP `200`.
```powershell
$resp = Invoke-WebRequest -Uri 'http://localhost:8080/health' -UseBasicParsing -TimeoutSec 30
if ($resp.StatusCode -ne 200) { throw "Health check failed: $($resp.StatusCode)" }
```

**3. Back up the current release *before* overwriting.** "Check if a deploy
exists" → snapshot it first. You can't restore what you didn't save.
```powershell
if (Test-Path $sitePath) { Copy-Item $sitePath $backupDir -Recurse }
else { New-Item -ItemType Directory -Path $sitePath | Out-Null }   # first deploy
```

**4. Roll back on failure.** Wrap the deploy in `try/catch`; if anything fails,
restore the backup and restart, so the server is never left broken.

**5. Safety & where it runs.** Fail fast (`$ErrorActionPreference = 'Stop'`);
protect production with environment approvals; keep credentials in **secrets**.
A `ubuntu-latest` runner **cannot reach a private IIS server** — use a
**self-hosted runner on the server** (below) or a remote connection (SSH/WinRM).

### Correct code

```yaml
name: Deploy
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

permissions:
  contents: read

jobs:
  # 1) Build + TEST + package (cloud runner)
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Map environment names
        id: map
        run: |
          case "${{ github.event.inputs.environment }}" in
            development) echo "aspnet=Development" >> $GITHUB_OUTPUT ;;
            staging)     echo "aspnet=Staging"     >> $GITHUB_OUTPUT ;;
            production)  echo "aspnet=Production"   >> $GITHUB_OUTPUT ;;
          esac
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "8.0.x"
      - name: Test before packaging          # Principle 1
        run: dotnet test backend/SimpleWebApp.sln --configuration Release
      - name: Publish backend (win-x64)
        run: >
          dotnet publish backend/SimpleWebApp.Api/SimpleWebApp.Api.csproj
          --configuration Release --runtime win-x64 --self-contained false
          --output publish/backend
      - name: Stamp environment into web.config   # makes the package env-specific
        run: sed -i 's/value="Production"/value="${{ steps.map.outputs.aspnet }}"/' publish/backend/web.config
      - name: Zip backend
        run: cd publish/backend && zip -r "$GITHUB_WORKSPACE/backend.zip" .
      - uses: actions/upload-artifact@v4
        with:
          name: backend-${{ github.event.inputs.environment }}
          path: backend.zip

  # 2) Deploy with backup + health check + rollback
  deploy:
    needs: build-and-test
    runs-on: [self-hosted, windows]                       # runner ON the IIS server
    environment: ${{ github.event.inputs.environment }}   # add reviewers for prod
    steps:
      - name: Download the package
        uses: actions/download-artifact@v4
        with:
          name: backend-${{ github.event.inputs.environment }}
          path: incoming
      - name: Deploy with automatic rollback
        shell: powershell
        run: |
          $ErrorActionPreference = 'Stop'
          Import-Module WebAdministration

          $site      = 'SimpleWebApp-Api'
          $sitePath  = 'C:\inetpub\api'
          $healthUrl = 'http://localhost:8080/health'
          $backupDir = "C:\deploy-backups\api_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
          $newBuild  = "$env:GITHUB_WORKSPACE\incoming\extracted"

          Expand-Archive "$env:GITHUB_WORKSPACE\incoming\backend.zip" $newBuild -Force

          # Principle 3: back up the CURRENT release if one exists
          if (Test-Path $sitePath) {
            Write-Host "Existing deploy found -> backing up to $backupDir"
            Copy-Item $sitePath $backupDir -Recurse
          } else {
            Write-Host "No existing deploy -> first deployment"
            New-Item -ItemType Directory -Path $sitePath | Out-Null
          }

          try {
            # Principle 4: swap files
            Stop-Website -Name $site -ErrorAction SilentlyContinue
            Get-ChildItem $sitePath -Recurse | Remove-Item -Recurse -Force
            Copy-Item "$newBuild\*" $sitePath -Recurse -Force
            Start-Website -Name $site

            # Principle 2: smoke test
            Start-Sleep -Seconds 5
            $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 30
            if ($resp.StatusCode -ne 200) { throw "Health check returned $($resp.StatusCode)" }
            Write-Host "Deploy healthy (HTTP 200)."
          }
          catch {
            # Principle 4: ROLL BACK on any failure
            Write-Warning "Deploy failed: $($_.Exception.Message). Rolling back..."
            Stop-Website -Name $site -ErrorAction SilentlyContinue
            if (Test-Path $backupDir) {
              Get-ChildItem $sitePath -Recurse | Remove-Item -Recurse -Force
              Copy-Item "$backupDir\*" $sitePath -Recurse -Force
              Start-Website -Name $site
              Write-Host "Rolled back to previous release."
            }
            exit 1   # fail the pipeline, but the site is back to working
          }
```

> The frontend deploys the same way — back up the web folder, copy the new files
> in, load the page, and restore the backup if it doesn't return `200`.

### What you need on the server (one-time)
1. **Install a self-hosted runner:** repo → Settings → Actions → Runners → *New
   self-hosted runner* (Windows). Give it the label `windows`; run it with rights
   to manage IIS.
2. **Folders:** the site folder (`C:\inetpub\api`) and a backups folder
   (`C:\deploy-backups`).
3. **IIS site** named to match `$site`.

---

# Cross-cutting rules (all pipelines)

- **Least-privilege `permissions:`** — `contents: read` everywhere except Release
  (`contents: write`).
- **Pin actions** to a major version at minimum (`@v4`); pin third-party actions
  to a commit SHA for supply-chain safety.
- **Secrets** for anything sensitive; reference by name (`${{ secrets.NAME }}`),
  never hard-code, never `echo` a password.
- **`concurrency`** guards to avoid overlapping/duplicate runs.
- **Cache** dependencies for speed; use lockfiles for reproducibility.
- **Fail fast** and give steps clear names so logs are easy to read.

## Master checklist

**CI** — [ ] PR trigger  [ ] build+test both apps  [ ] same build/test config
[ ] caching  [ ] least-privilege

**Release** — [ ] push-to-main trigger  [ ] test before release  [ ] version
stamped in build + filenames  [ ] tag + Release with notes  [ ] actions pinned

**Deploy** — [ ] test before package  [ ] backup current release  [ ] deploy
[ ] health check (HTTP 200)  [ ] rollback on failure  [ ] secrets + prod approval
