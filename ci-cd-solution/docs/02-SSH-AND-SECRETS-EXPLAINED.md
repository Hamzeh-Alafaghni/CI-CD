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
