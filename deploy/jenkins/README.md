# Creating the SinterIQ Jenkins job

`job-config.xml` in this directory is a **Pipeline script from SCM** job. Jenkins clones the repo and runs the root `Jenkinsfile`, so the pipeline is version-controlled with the app.

## Current state on `srv1601542`

The job definition is **already installed on disk** at
`/var/jenkins_home/jobs/sinteriq/config.xml` (owned `root:root`, matching
`pomotoro-deploy`). It is inert until the controller re-reads its config, so
finish these three things before the first build:

1. **Run certbot** — see the warning below. This is not optional.
2. **Create the `sinteriq-env` credential** — §1.
3. **Reload Jenkins** so the job appears — §2.

> ### ⚠ Run certbot BEFORE the first Jenkins build
> The pipeline's Health check stage runs `curl -fsS https://sinteriq.zengineeringapp.com/api/health`.
> Until the TLS certificate exists, that curl fails, the stage fails, and the
> `post { failure { ... } }` block **rolls the deployment back**. Issue the cert
> first:
>
> ```sh
> certbot --nginx -d sinteriq.zengineeringapp.com --non-interactive --agree-tos --redirect
> ```

### Credentials already present on this controller

Checked directly against `credentials.xml` (IDs only):

- `dockerhub-yasin` — **exists**, referenced by the Jenkinsfile as-is.
- `github-https-pat` — **exists**; `job-config.xml` uses it for SCM so no new
  credential is needed. **Unverified**: nobody has confirmed this PAT covers
  `sageershaggy/SinterIQ`. If checkout fails with an auth error, switch to the
  per-app convention (`pomotoro-scm`, `sagetrade-scm`) and create `sinteriq-scm`
  as described in §1.
- `sinteriq-env` — **missing, you must create it.** This is the only credential
  that genuinely has to be added.

Convenient shortcut: the exact env file the pipeline needs is already on the host
at `/srv/sinteriq/.env` (mode 600), written during the manual first deploy. It
contains **no secrets** — the setup token and all provider keys are intentionally
blank — so you can download it and upload it as the `sinteriq-env` Secret file
unchanged.

---

## 1. Credentials the pipeline needs

Manage Jenkins → Credentials → System → Global credentials.

| ID | Kind | Status |
|---|---|---|
| `dockerhub-yasin` | Username with password | **Already exists.** Reuse as-is; do not recreate. |
| `github-https-pat` | Username with password | **Already exists**, used for SCM by `job-config.xml`. Scope over this repo is unverified. |
| `sinteriq-env` | Secret file | **You must create this.** The only genuinely missing credential. |
| `sinteriq-scm` | SSH Username with private key | Only if `github-https-pat` turns out not to cover this repo. |

### Creating `sinteriq-env`

The file is already on the host at `/srv/sinteriq/.env` and contains no secrets,
so the quickest path is to copy it down and upload it verbatim:

```sh
scp -i ~/.ssh/pomotoro_vps root@187.127.154.31:/srv/sinteriq/.env ./sinteriq.env
```

Then Manage Jenkins → Credentials → System → Global → Add Credentials → **Secret
file**, ID `sinteriq-env`, and upload it. Delete your local copy afterwards.

If you would rather build it from the template, `cp .env.production.example
.env.production` and fill it in. Two fields deserve attention:

- `INNOVISTA_SETUP_TOKEN` — leave **blank** to keep browser-based setup disabled
  (the admin account already exists, so it is not needed). Only set it, via
  `openssl rand -base64 48`, if you ever need to re-bootstrap from the browser.
- `LEGACY_DB_HOST_PATH` — leave **blank** unless you are enabling the legacy
  import. A non-empty value pointing at a file that does not exist makes the
  Deploy stage's guard abort the build on purpose.

### Fallback: `sinteriq-scm` deploy key

Only needed if SCM checkout fails with an auth error:

```sh
ssh-keygen -t ed25519 -C 'jenkins-sinteriq-deploy' -f ./sinteriq_deploy -N ''
cat ./sinteriq_deploy.pub    # -> GitHub repo Settings > Deploy keys (read-only)
cat ./sinteriq_deploy        # -> Jenkins credential 'sinteriq-scm' (username: git)
```

Then switch `job-config.xml` to the SSH URL and `sinteriq-scm`, as noted in the
comment inside that file. Delete the local key files afterwards.

---

## 2. Option A — through the UI

Because the definition is already on disk, the job only needs the controller to
re-read it:

1. **Manage Jenkins → Reload Configuration from Disk.** `sinteriq` then appears
   in the job list. (This re-reads *all* job configs — harmless, but it is a
   controller-wide action on shared CI, so do it when no other build is mid-flight.)
2. Confirm **Pipeline script from SCM**, repo `sageershaggy/SinterIQ`,
   **Branch Specifier** `*/main`, **Script Path** `Jenkinsfile`.
3. **Build Now.**

If you would rather not reload the controller, delete
`/var/jenkins_home/jobs/sinteriq/` and create the job through the API instead
(§3) — that registers it immediately without a reload. Or create it by hand:
**New Item → Duplicate an existing item**, copying `pomotoro-deploy`, then set
the repo, branch and script path as above.

---

## 3. Option B — one API call

Run from any machine that can reach Jenkins. Use a Jenkins **API token**, not a password (User → Configure → API Token).

```sh
JENKINS=https://jenkins.zengineeringapp.com
AUTH='your-jenkins-user:your-api-token'

# Jenkins enforces CSRF, so fetch a crumb and send it as a header.
CRUMB=$(curl -sS -u "$AUTH" \
  "$JENKINS/crumbIssuer/api/xml?xpath=concat(//crumbRequestField,\":\",//crumb)")

# Create the job
curl -sS -X POST -u "$AUTH" -H "$CRUMB" \
  -H 'Content-Type: application/xml' \
  --data-binary @deploy/jenkins/job-config.xml \
  "$JENKINS/createItem?name=sinteriq"

# Trigger the first build
curl -sS -X POST -u "$AUTH" -H "$CRUMB" "$JENKINS/job/sinteriq/build"

# Follow the console output
curl -sS -u "$AUTH" "$JENKINS/job/sinteriq/lastBuild/consoleText"
```

Update an existing job from the same file:

```sh
curl -sS -X POST -u "$AUTH" -H "$CRUMB" \
  -H 'Content-Type: application/xml' \
  --data-binary @deploy/jenkins/job-config.xml \
  "$JENKINS/job/sinteriq/config.xml"
```

---

## 4. What the pipeline does

`Jenkinsfile` at the repo root:

1. **Checkout** the branch.
2. **Build image** — one image, tagged `app-<tag>` and `app-latest`. Pomotoro builds two (`web-`/`api-`); this app serves the API and the SPA from a single Node process, so there is only one.
3. **Push to Docker Hub** using a per-build `DOCKER_CONFIG`, so this job's `docker login` never overwrites the shared Jenkins auth the pomotoro/tawazun jobs rely on.
4. **Deploy** over the mounted `docker.sock`: writes the `sinteriq-env` secret file next to the compose file, forces `IMAGE_TAG` to the tag just pushed, **pre-checks that `LEGACY_DB_HOST_PATH` is a real file** (a missing bind source would become a directory and break the app), runs `compose pull && compose up -d`, deletes the env file, then prunes images filtered to `label=com.zengineering.app=sinteriq` only.
5. **Health check** — polls `https://sinteriq.zengineeringapp.com/api/health` (note: `/api/health`, not `/health`) for up to ~2 minutes, dumping the last 80 container log lines on failure.
6. **On failure** — redeploys the previously running image tag.

### Known quirk inherited from the pomotoro Jenkinsfile

`TAG` is computed in the `environment` block as `env.GIT_COMMIT?.take(12) ?: env.BUILD_NUMBER`. Declarative `environment` entries are resolved before `checkout scm` runs, so `GIT_COMMIT` is usually still null and **images end up tagged by build number rather than commit SHA**. This matches the pomotoro job's existing behaviour and is harmless — tags stay unique and rollback still works. To tag by SHA instead, move the assignment into the `Checkout` stage:

```groovy
stage('Checkout') {
  steps {
    checkout scm
    script { env.TAG = env.GIT_COMMIT.take(12) }
  }
}
```

---

## 5. Full deployment context

This directory only covers the CI job. DNS, the host nginx vhost, TLS, the legacy database upload, first-administrator setup and backups are in [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).
