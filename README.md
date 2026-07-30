# Simple Web App — .NET 8 API + Angular + CI/CD to IIS

A small full-stack starter for learning how a modern web app is built, packaged,
and deployed to IIS through GitHub Actions.

- **Frontend:** Angular 18 (standalone components) — Home, About, and a Data page
  that fetches a list from the API.
- **Backend:** ASP.NET Core Web API on .NET 8 — `GET /api/items`, `GET /api/items/{id}`,
  and `GET /health`. Swagger UI is enabled.
- **CI/CD:** three GitHub Actions workflows (CI, Release, Deploy).

## Repository layout

```
simple-webapp/
├─ backend/
│  ├─ SimpleWebApp.sln
│  ├─ SimpleWebApp.Api/            # the Web API (with web.config for IIS)
│  └─ SimpleWebApp.Api.Tests/      # xUnit integration tests
├─ frontend/                       # Angular app (dev/staging/prod environments)
│  └─ src/
├─ .github/workflows/
│  ├─ ci.yml                       # build + test on PRs to main
│  ├─ release.yml                  # version + package + tag + GitHub Release on push to main
│  └─ deploy.yml                   # manual, pick environment, produces deploy zips
└─ README.md
```

## Run it locally

**Backend** (needs the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)):

```bash
cd backend/SimpleWebApp.Api
dotnet run
# API on http://localhost:5080, Swagger at http://localhost:5080/swagger
```

**Frontend** (needs Node 20+):

```bash
cd frontend
npm install      # first run also creates package-lock.json — commit it
npm start        # http://localhost:4200
```

The dev frontend calls the API at `http://localhost:5080` (see
`src/environments/environment.ts`), and the API's CORS policy already allows
`http://localhost:4200`.

## The CI/CD pipeline — this is YOUR assignment

The three workflows in `.github/workflows/` are **templates, not finished
pipelines**. Each contains the triggers (already decided) and `TODO` comments
describing the steps you must write. Your task is to implement them.

👉 **Read [`.github/STUDENT_GUIDE.md`](.github/STUDENT_GUIDE.md)** for the full
brief, step-by-step requirements, and **how to use GitHub secrets**.

In short, what you must build:

1. **`ci.yml`** — on every PR to `main`, build and test both apps (the quality
   gate that protects `main`).
2. **`release.yml`** — on every push to `main`, version the app, package both
   apps into zips, create a git tag, and publish a GitHub Release.
3. **`deploy.yml`** — a manual workflow where you pick
   `development` / `staging` / `production`, build for that environment, and
   produce downloadable deploy packages. This is where you practise **secrets**.

> Tip: create GitHub **Environments** named `development`, `staging`, and
> `production` (repo Settings → Environments) so you can attach reviewers and
> environment-scoped secrets.

## Deploying to your IIS server (manual step)

On the Windows server, one-time prerequisites:

1. Install the **[.NET 8 Hosting Bundle](https://dotnet.microsoft.com/download/dotnet/8.0)**
   (gives IIS the ASP.NET Core Module).
2. Install the IIS **URL Rewrite** module (for Angular client-side routing).

Then for each release:

1. In IIS Manager, create two sites (or use one site + an `/api` application),
   e.g. `web-production` on port 80 and `api-production` on port 8080.
2. Download the zips from the Deploy run's **Artifacts**.
3. Stop the sites, extract `frontend-*.zip` into the web site folder and
   `backend-*.zip` into the API site folder, then start them.
4. Point the frontend at the API: in `environment.production.ts`, set `apiUrl`
   (empty string = same host; otherwise the API's URL).

## Adjusting versions / environments

- API URLs per environment: `frontend/src/environments/environment*.ts`
- API CORS allow-list per environment: `backend/SimpleWebApp.Api/appsettings.*.json`
- Version scheme: edit the `version` job in `release.yml`.

## Faster, reproducible frontend builds (optional)

The workflows use `npm install` so they work before a lockfile exists. After you
run `npm install` locally once and **commit `frontend/package-lock.json`**, switch
the frontend steps to `npm ci` and re-enable `cache: npm` in the workflows (the
lines are noted as comments in `ci.yml`).
