# Assignment — Build a Release & Deploy Pipeline (with rollback)

Your job is to **build the Deploy pipeline yourself** and upgrade the Release
pipeline. This document tells you the **goal**, **how it must work**, **what you
must implement**, and **how you'll be graded**. It does **not** give you the
finished code — that's the assignment.

---

## 1. The goal

Ship the app to the IIS server using the professional pattern:
**build once → publish a Release → deploy that exact Release**, safely.

"Safely" means: if the new version is broken, the pipeline must **automatically
put the old version back** so the site is never left down.

## 2. How it must work (the target flow)

```
  git tag v1.0.0                 Actions ▸ Deploy (choose env + tag)
        │                                  │
        ▼                                  ▼
  RELEASE workflow (on tag)         DEPLOY workflow (windows runner)
  test → build → package            1. download that Release's api.zip + web.zip
  publish Release with              2. VALIDATE the package
  api.zip + web.zip        ───────▶ 3. TEST the SSH connection
                                    4. copy files to the server
                                    5. BACK UP the current site
                                    6. deploy the new files
                                    7. HEALTH CHECK (with retries)
                                    8. healthy? done.  broken? ROLL BACK.
```

## 3. What you're given

- The app: `backend/` (.NET 8 API with a `/health` endpoint) and `frontend/`
  (Angular).
- A working **CI** workflow and a **Release** workflow that currently triggers on
  `main` (you'll change it).
- The server is already set up (see `SETUP-STEP-BY-STEP.md`): two IIS sites/pools,
  OpenSSH, and these fixed names you must target:

| | Frontend | Backend |
|---|---|---|
| Site & pool | `SimpleWebApp-Web` | `SimpleWebApp-Api` |
| Folder | `C:\inetpub\web` | `C:\inetpub\api` |
| Port | `80` | `8080` |

- Three secrets already exist: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`.

---

## 4. Your tasks

### Task A — Make Release tag-triggered
Change `release.yml` so it runs when you push a **version tag** (`v*.*.*`), not on
every push to main. It must:
- Derive the version from the tag.
- Test, then build/publish the API and the Angular app.
- Package them as **`api.zip`** and **`web.zip`** (these exact names).
- Publish a **GitHub Release** for the tag with both zips attached.

*Acceptance:* `git tag v1.0.0 && git push origin v1.0.0` produces a Release
`v1.0.0` with `api.zip` and `web.zip`.

### Task B — Build the Deploy workflow
Create `deploy.yml`. Requirements:

**Trigger & inputs**
- `workflow_dispatch` with two inputs: `environment` (choice:
  development/staging/production) and `version` (the release tag, default `latest`).

**Runner & config**
- `runs-on: windows-latest`.
- Put **all** non-secret config in an `env:` block (so nothing is hard-coded in
  steps). You must define at least:
  `WEB_SITE, WEB_POOL, WEB_PATH, API_SITE, API_POOL, API_PATH, WEB_HEALTH,
  API_HEALTH, INCOMING, BACKUPS, KEEP_BACKUPS, HEALTH_RETRIES, HEALTH_DELAY`.
- Use the secrets for `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`.

**Steps you must implement (in this order)**
1. **Download the release** assets for the chosen tag (do **not** rebuild).
2. **Validate the package** — confirm `api.zip`/`web.zip` exist, aren't empty, and
   contain the expected files (`web.config`, `index.html`) *before* touching the
   server.
3. **Test the SSH connection** — fail fast if you can't reach the server.
4. **Deploy to the server over SSH** so that it:
   - backs up the current `api` and `web` folders (timestamped),
   - keeps only the last `KEEP_BACKUPS` backups (prune older),
   - swaps in the new files (use `app_offline.htm` for the API so files aren't
     locked),
   - recycles both app pools,
   - **health-checks** `API_HEALTH` and `WEB_HEALTH`, retrying up to
     `HEALTH_RETRIES` times with `HEALTH_DELAY` seconds between tries,
   - if any check fails, **restores the backup** and exits with an error.

> Design note: because all config is in `env:`, you should **not** commit a
> `deploy.ps1`. Generate the server-side script from the `env:` values at run
> time (or pass them as parameters). Part of the grade is "no hard-coded config in
> steps."

### Task C — Make the two sites talk (config)
Set `frontend/src/environments/environment.production.ts` → `apiUrl` to
`http://YOUR_SERVER_IP:8080`, and add `http://YOUR_SERVER_IP` to the backend's
`appsettings.Production.json` CORS list. Explain in one sentence *why* this is
needed.

---

## 5. Starter skeleton (fill in the TODOs)

You may start `deploy.yml` from this skeleton. The triggers and `env:` are given;
the step logic is yours.

```yaml
name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [development, staging, production]
        default: development
        required: true
      version:
        description: "Release tag (e.g. v1.0.0) or 'latest'"
        default: "latest"
        required: true

permissions:
  contents: read

env:
  WEB_SITE: SimpleWebApp-Web
  WEB_POOL: SimpleWebApp-Web
  WEB_PATH: C:\inetpub\web
  API_SITE: SimpleWebApp-Api
  API_POOL: SimpleWebApp-Api
  API_PATH: C:\inetpub\api
  WEB_HEALTH: http://localhost/
  API_HEALTH: http://localhost:8080/health
  INCOMING: C:\deploy-incoming
  BACKUPS: C:\deploy-backups
  KEEP_BACKUPS: "5"
  HEALTH_RETRIES: "10"
  HEALTH_DELAY: "6"

jobs:
  deploy:
    runs-on: windows-latest
    environment: ${{ github.event.inputs.environment }}
    steps:
      # TODO 1: download the chosen release's api.zip + web.zip
      #         (hint: the `gh` CLI is preinstalled; set GH_TOKEN: ${{ github.token }})
      # TODO 2: validate the package (both zips exist, not empty, contain
      #         web.config / index.html) — fail before touching the server
      # TODO 3: write SSH_PRIVATE_KEY to a file, fix its permissions,
      #         and add the host to known_hosts (hint: ssh-keyscan)
      # TODO 4: test the SSH connection (hint: ssh ... "whoami"; fail if empty)
      # TODO 5: copy the zips + your deploy logic to the server (hint: scp)
      # TODO 6: run the deploy on the server so it does:
      #         backup -> prune -> app_offline swap -> recycle pools ->
      #         health check with retries -> ROLL BACK on failure
      - name: Not implemented yet
        run: echo "TODO - build the deploy job"
```

Hints for the server-side logic (PowerShell):
`Copy-Item`, `Expand-Archive`, `Restart-WebAppPool`, `Invoke-WebRequest` (check
`.StatusCode -eq 200`), a `for` loop for retries, and `try { ... } catch { ...
restore ...; exit 1 }` for rollback.

---

## 6. Prove it works
1. Tag and deploy a **good** build → site loads, `/health` returns 200.
2. Tag and deploy a **deliberately broken** build → the run fails **but the old
   site still loads** (rollback worked). Screenshot both.

---

### Reference material
- `SETUP-STEP-BY-STEP.md` — the server, sites, and secrets you deploy to.
