# CI/CD Assignment — Student Guide

Your job is to complete the three GitHub Actions workflows in
`.github/workflows/`. Right now each one only contains **triggers** (already
decided for you) and **`TODO` comments** describing the steps you must write.
Replace the placeholder steps with real ones until each workflow works.

Do **not** change the `on:` triggers — implementing the jobs *for those
triggers* is the whole exercise.

## What each workflow must do

### 1. `ci.yml` — the quality gate
Runs on every Pull Request into `main`.
- **backend job:** check out the code, install .NET 8, restore, build in
  Release, and run the tests.
- **frontend job:** check out the code, install Node 20, install dependencies,
  and build the Angular app.

✅ Done when: opening a PR runs both jobs and they pass on good code, fail on
broken code.

### 2. `release.yml` — package + tag + release
Runs on every push to `main`.
- Compute a version (e.g. `1.0.<run number>`) and matching tag `v1.0.<run number>`.
- Build and **publish** the .NET API, build the Angular production bundle.
- Zip each app.
- Create a **git tag** and a **GitHub Release** with both zips attached.

✅ Done when: merging a PR produces a new tag and a Release under the repo's
"Releases" tab with two downloadable zips.

### 3. `deploy.yml` — manual, environment-aware
Started by hand (**Actions tab → Deploy → Run workflow**). You pick
`development`, `staging`, or `production`.
- Map the chosen environment to the right build settings.
- Build + package the app for that environment.
- Upload the zips as artifacts you can download and copy onto the IIS server.

✅ Done when: running it for `staging` produces a `staging` package, and
`production` produces a `production` package.

## How to write a step

Each step is a list item under `steps:`. Two common shapes:

```yaml
# Use a prebuilt action from the Marketplace:
- name: Check out code
  uses: actions/checkout@v4

# Run shell commands directly:
- name: Build
  run: dotnet build --configuration Release
```

Useful actions: `actions/checkout`, `actions/setup-dotnet`, `actions/setup-node`,
`actions/upload-artifact`, `actions/download-artifact`.

## How to use secrets 🔐

Secrets are encrypted values (passwords, tokens, hostnames) that must **never**
be written directly in the YAML or committed to the repo.

**1. Add a secret in GitHub**
Repo → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**. Give it a name (e.g. `IIS_PASSWORD`) and a value.
> To limit a secret to one environment, add it under
> **Settings → Environments → (pick one) → Add secret** instead. Those are only
> available to jobs that declare `environment: <name>` (our `deploy.yml` does).

**2. Reference it by name in a workflow**
```yaml
- name: Use a secret
  env:
    PASSWORD: ${{ secrets.IIS_PASSWORD }}
  run: echo "connecting..."   # $PASSWORD is available here
```

**3. Rules to remember**
- Reference secrets **only** by name: `${{ secrets.NAME }}`. The real value
  lives in GitHub, not in your code.
- GitHub automatically **masks** secret values in the logs (they show as `***`).
- Never `echo` a secret on purpose, and never paste one into a `.yml`,
  `.env`, or `appsettings.json` that you commit.
- `${{ secrets.GITHUB_TOKEN }}` is provided automatically — you don't create it.
  `release.yml` can use it to create the Release.

**Secrets you might create for this project**
| Secret name    | Used for                                   |
|----------------|--------------------------------------------|
| `IIS_HOST`     | The server's IP/hostname (if you automate deploy) |
| `IIS_USERNAME` | Deploy account username                    |
| `IIS_PASSWORD` | Deploy account password                    |

(For the manual artifact workflow you may not need any of these yet — but wire
one in as practice.)

## Suggested order of work
1. Get `ci.yml`'s **backend** job green.
2. Get `ci.yml`'s **frontend** job green.
3. Do `release.yml`.
4. Do `deploy.yml`, and add + use one secret.

Commit small and often, and watch each run in the **Actions** tab. When a step
fails, read its log top-to-bottom — the error is almost always in the last few
red lines.
