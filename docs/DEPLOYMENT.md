# Deployment Runbook — SinterIQ on the Shared Hostinger VPS

How **Innovista Research AI** (repo `SinterIQ`) runs as one isolated Docker stack behind the host's nginx + TLS, deployed by the existing **Jenkins** pipeline — beside Pomotoro, Tawazun and Sentry, touching none of them.

> **Host:** Hostinger VPS · Alpine · `srv1601542` · IP `187.127.154.31`
> **Stack:** React 19 / Vite 8 · Express 5 (TypeScript via `tsx`) · embedded SQLite
> **Public URL:** `https://innovista-research-ai.zengineeringapp.com`
> **Localhost port:** `127.0.0.1:8110`
> **CI/CD:** Jenkins → Docker Hub → deploy via mounted `docker.sock`
> **Reference:** this follows `pomotoro/docs/DEPLOYMENT.md`; the deltas are called out in §2.

---

## 1. The mental model

Identical isolation contract to Pomotoro: a self-contained Compose stack with its own network, volume and localhost-only port. The host's single nginx is the only shared traffic cop.

```
Browser (HTTPS :443)
   │
   ▼
┌─────────────────────── Hostinger VPS (shared) ───────────────────────┐
│  Host nginx + certbot  (:80 / :443, one vhost per domain)            │
│        │                    │                     │                 │
│        ▼                    ▼                     ▼                 │
│  ┌───────────────┐   ┌───────────────┐   ┌──────────────────┐        │
│  │ pomotoro      │   │ tawazun       │   │ sinteriq         │        │
│  │ 127.0.0.1:8090│   │ 127.0.0.1:80xx│   │ 127.0.0.1:8110   │        │
│  │  web          │   │  ...          │   │  app  (API+SPA)  │        │
│  │  api          │   │               │   │  └ SQLite in-proc│        │
│  │  db (MySQL)   │   │               │   │  innovista-research-ai_data   │        │
│  │ pomotoro_net  │   │               │   │  innovista-research-ai_net    │        │
│  └───────────────┘   └───────────────┘   └──────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘

CI/CD:  git push → Jenkins → build image → Docker Hub → (docker.sock) compose up
```

| Layer | What it is | How it's isolated |
|---|---|---|
| **app** | One Node 22 process. `server.ts --production` serves the `/api` routes **and** the built `dist/` bundle. Same-origin by construction — no CORS, no container nginx. | Published only on `127.0.0.1:8110` |
| **database** | Embedded SQLite (`better-sqlite3`) in the `innovista-research-ai_data` volume | Never on the network at all — in-process |
| **host nginx** | Terminates TLS, forwards the domain to `127.0.0.1:8110` | One file: `/etc/nginx/http.d/innovista-research-ai.conf` |
| **Jenkins** | Builds & deploys through the mounted Docker socket | One job, per-build Docker login, labelled pruning |

### The four values

| Value | Pomotoro (prod) | **SinterIQ (prod)** |
|---|---|---|
| app / compose project name | `pomotoro` | `sinteriq` |
| localhost port | `127.0.0.1:8090` | `127.0.0.1:8110` |
| public domain | `pomotoro.zengineeringapp.com` | `innovista-research-ai.zengineeringapp.com` |
| Docker Hub repo | `yasinshaikh111/pomotoro` | `yasinshaikh111/innovista-research-ai` |

---

## 2. Four ways this differs from Pomotoro — read before deploying

**a. One container, not three.** Pomotoro splits static-nginx + .NET API + MySQL. Here `server.ts` in production mode serves the API and `dist/` from a single Express process, so there is no `web`/`api` split and no container-level `nginx.conf`. The image is tagged `app-<sha>` where Pomotoro uses `web-<sha>` / `api-<sha>`.

**b. There is no `db` service, by design.** The database is *embedded* SQLite: `data/innovista.db` plus `data/.innovista-encryption-key`, which encrypts stored AI provider keys. **The `innovista-research-ai_data` volume IS the database.** Adding a MySQL container would require rewriting `server/database.ts` (~700 lines of raw SQLite against `better-sqlite3`'s synchronous API), `server/legacy.ts` (which opens `sintertechnik.db` as a read-only SQLite file), `server/secrets.ts`, `scripts/init-admin.ts` and the test suite — a data-layer port, not a deployment change. Every other isolation property Pomotoro gets from its stack (own network, own volume, localhost-only port, own env secret file, labelled pruning) is preserved here.

> **Back up `innovista.db` and `.innovista-encryption-key` TOGETHER.** Losing the key makes stored provider credentials permanently unreadable. See §8.

**c. Health path is `/api/health`, not `/health`.** It queries the database's initialization record: HTTP 200 `{"database":"connected"}` or HTTP 503 `{"database":"unavailable"}`. It deliberately exposes no paths, records or raw database errors.

**d. No AI key is ever a build arg.** Pomotoro's `Dockerfile` bakes `GEMINI_API_KEY` into its bundle. Here provider keys are **runtime env only** — a project invariant, because a build arg lands in an image layer and anything `VITE_`-prefixed lands in the browser bundle. Keys can also be entered in **Workspace settings**, where they are encrypted at rest.

Two more app-specific behaviours worth knowing:

- **There is no default administrator and no default password.** The first admin is created explicitly (§6).
- **The app refuses to start in production without an `https://` `INNOVISTA_ORIGIN`**, and returns `403 Unrecognized host.` for any other `Host` header. This is why the vhost must forward `Host $host` — verified in §7.

---

## 3. Files this repo already contains

| File | Purpose |
|---|---|
| `Dockerfile` | 3-stage build: prod deps (compiles `better-sqlite3`) → Vite bundle → slim runtime |
| `.dockerignore` | Keeps `.env*`, `data/`, `*.db` and keys out of the build context |
| `docker-compose.prod.yml` | The isolation contract: `innovista-research-ai_net`, `innovista-research-ai_data`, `127.0.0.1:${APP_PORT}` |
| `Jenkinsfile` | checkout → build → push → deploy → health check → auto-rollback |
| `deploy/nginx/innovista-research-ai.conf` | The host vhost to copy to `/etc/nginx/http.d/` |
| `.env.production.example` | Template for the `innovista-research-ai-env` Jenkins secret file |
| `deploy/jenkins/job-config.xml` | Importable Jenkins job definition (pipeline-from-SCM) |
| `deploy/jenkins/README.md` | Credential setup, UI and API job creation, pipeline walkthrough |

### Why Debian slim, and why the `.ts` sources ship

`better-sqlite3` is a native addon, so the build stages install `python3 make g++` and the runtime uses `node:22-bookworm-slim` (glibc) rather than Alpine/musl, which would force a source build for no benefit.

The app is **not compiled to JavaScript**. `npm start` runs `tsx server.ts`, and `server/documents.ts` forks `server/document-worker.ts` with `--import tsx` to extract PDF/DOCX uploads in an isolated process. So the runtime image ships `server.ts`, `server/`, `shared/` and `scripts/` as TypeScript, with `tsx` as a production dependency. It also ships `docs/sintertechnik-training.md`, which first-run DB seeding reads with an **unguarded** `readFileSync` — omit it and a fresh database crash-loops the container on boot.

---

## 4. Prerequisites (already on the VPS — reuse, don't reinstall)

- **Docker + Docker Compose**
- **Host nginx** on `:80/:443`, vhosts in `/etc/nginx/http.d/` (Alpine)
- **certbot** for Let's Encrypt (account already registered)
- **Jenkins** at `jenkins.zengineeringapp.com` with `/var/run/docker.sock` mounted
- **Docker Hub** account `yasinshaikh111` + access token
- Repo `github.com/sageershaggy/SinterIQ` reachable by Jenkins (read-only deploy key if private)

**Confirm the port is free before anything else.** Do **not** use `ss` — it is not installed on this Alpine host, so `ss -ltnp | grep <port>` matches nothing and reports a *busy* port as free. That is exactly how the original `8100` choice collided with `sagetrade-app`. Use both of these instead:

```sh
ssh root@187.127.154.31

# 1. authoritative kernel view (hex port -> decimal)
{ awk 'NR>1{split($2,a,":"); print strtonum("0x" a[2])}' /proc/net/tcp
  awk 'NR>1{split($2,a,":"); print strtonum("0x" a[2])}' /proc/net/tcp6
} | sort -n -u | tr '
' ' '

# 2. every port Docker has published, including stopped containers
docker ps -a --format '{{.Ports}}' | grep -oE '127[.]0[.]0[.]1:[0-9]+'   | cut -d: -f2 | sort -n -u | tr '
' ' '
```

Taken as of SinterIQ's first deploy: **8080** (tawazun-edge), **8081** (jenkins), **8090** (pomotoro-web), **8091 / 8092 / 8095 / 8097** (tawazun variants), **8096** (pomotoro-staging), **8100** (sagetrade-app), **9000** (sentry), **5050** (pgadmin), **50000** (jenkins agents). SinterIQ therefore uses **8110**.

If you change it, change it in **both** `.env.production` (`APP_PORT`) and `deploy/nginx/innovista-research-ai.conf` (`proxy_pass`).

---

## 5. Deploy — the six additive steps

Nothing below edits another app's files.

### Step 1 — DNS

Add an `A` record: `sinteriq` → `187.127.154.31`. Wait for it to resolve **before** running certbot:

```sh
nslookup innovista-research-ai.zengineeringapp.com
```

> The public host is `innovista-research-ai.zengineeringapp.com` — one `e` in "zengineering", one `p` in "app".

### Step 2 — Legacy database import (OPTIONAL — disabled in the live stack)

**The current deployment skips this**: `sintertechnik.db` was not available, so the bind mount in `docker-compose.prod.yml` is commented out and `LEGACY_DB_HOST_PATH` is blank. The live workspace has the Sintertechnik starter project, its qualification handbook and a draft rubric, but **no imported companies, contacts, activities, notes or prior research**.

The one-time SinterIQ → Innovista import reads `./sintertechnik.db` from the working directory and **silently skips** when absent, so the bind mount is what enables it. The file is gitignored and never baked into the image.

> **The import runs only on first database initialization.** Enabling it now against the already-initialized `innovista-research-ai_data` volume imports nothing. To add it you must remove that volume first, which discards whatever is in the workspace:
>
> ```sh
> cd /srv/innovista-research-ai
> docker compose -p innovista-research-ai -f docker-compose.prod.yml --env-file .env down
> docker volume rm innovista-research-ai_data
> # place the file, set LEGACY_DB_HOST_PATH, uncomment the mount, then up -d,
> # and re-create the administrator (section 6).
> ```

To enable it, all three of these must be true: the file exists on the host, `LEGACY_DB_HOST_PATH` names it, and the `sintertechnik.db` mount in `docker-compose.prod.yml` is uncommented.

```sh
# on the VPS
mkdir -p /srv/innovista-research-ai/legacy

# from your workstation
scp D:/yasin/github/SinterIQ/sintertechnik.db \
    root@187.127.154.31:/srv/innovista-research-ai/legacy/sintertechnik.db

# back on the VPS — must be a FILE, not a directory
chmod 600 /srv/innovista-research-ai/legacy/sintertechnik.db
ls -l     /srv/innovista-research-ai/legacy/sintertechnik.db
```

> **Why this matters:** Docker turns a missing bind-mount source into an empty **directory**. The app would then see `sintertechnik.db` "exist" and fail to open it as a database. The `Deploy` stage in the `Jenkinsfile` pre-checks this and aborts with a clear message rather than starting a broken container.
>
> **To start clean instead:** blank `LEGACY_DB_HOST_PATH` in the env file and delete that one `volumes:` line from `docker-compose.prod.yml`. Orders and all original records stay in the legacy database either way; only companies, contacts, activities, notes and prior research are copied in as immutable project-scoped reference material.
>
> If the legacy DB holds **encrypted provider keys** you want carried over, also set `SINTERIQ_ENCRYPTION_KEY` in the env file. Otherwise leave it blank and re-enter the provider key in Workspace settings after deploy.

### Step 3 — Host nginx vhost + TLS

```sh
# on the VPS, as root: copy deploy/nginx/innovista-research-ai.conf from the repo to
#   /etc/nginx/http.d/innovista-research-ai.conf
nginx -t && rc-service nginx reload

certbot --nginx -d innovista-research-ai.zengineeringapp.com \
  --non-interactive --agree-tos --redirect
```

certbot rewrites the file in place to add the `:443` block and the http→https redirect, and auto-renews thereafter. The vhost forwards `Host`, `X-Real-IP`, `X-Forwarded-For` and `X-Forwarded-Proto`, allows a 10 MB body (uploads are capped at 5 MB by multer) and uses a 300 s read timeout for long AI runs.

### Step 4 — Jenkins credentials

| ID | Kind | What it is |
|---|---|---|
| `dockerhub-yasin` | Username/Password | Docker Hub user + access token — **already exists**, reused as-is |
| `innovista-research-ai-env` | Secret file | The production `.env`, built from `.env.production.example` |
| SCM credential | SSH deploy key | Read-only key for `github.com/sageershaggy/SinterIQ` (if private) |

Build the secret file locally, fill in real values, upload it as `innovista-research-ai-env`, then delete your local copy:

```sh
cp .env.production.example .env.production
openssl rand -base64 48      # -> INNOVISTA_SETUP_TOKEN
# GEMINI_API_KEY -> your real key (or leave blank and set it in Workspace settings)
```

Leave `INNOVISTA_ENCRYPTION_KEY` **blank** unless you have a reason to manage it yourself; the app then generates `data/.innovista-encryption-key` inside the volume, and §8's backup covers it. If you do set it, it can never change afterwards.

### Step 5 — Create the Jenkins job

1. New Item → **Duplicate an existing item** from the working `pomotoro` job (inherits the SCM key pattern).
2. Point Git at `github.com/sageershaggy/SinterIQ`, **Branch Specifier** = `*/main`, **Script Path** = `Jenkinsfile`.
3. Attach the three credentials above.
4. **Build Now.**

Or import the job in one API call instead — `deploy/jenkins/job-config.xml` is a ready-to-post job definition, and [`deploy/jenkins/README.md`](../deploy/jenkins/README.md) has the `curl` commands (including the CSRF crumb), the deploy-key setup, a stage-by-stage walkthrough of the pipeline, and one inherited tagging quirk worth knowing about.

### Step 6 — Watch it go green

The pipeline pushes `app-<sha>`, runs `compose up -d`, then polls `https://innovista-research-ai.zengineeringapp.com/api/health` for up to 2 minutes. On failure it dumps the last 80 log lines and redeploys the previous image tag.

---

## 6. Create the first administrator (one time, after the first green deploy)

There is no seeded admin and no default password. Two options — **pick one**.

> **What the live deployment did:** Option B. `INNOVISTA_SETUP_TOKEN` is deliberately **blank** in `/srv/innovista-research-ai/.env`, which makes the server refuse browser-based setup in production altogether, so Option A is currently unavailable by design. The `admin` account was created with `scripts/init-admin.ts` and its one-time password written to `/srv/innovista-research-ai/admin-credentials.txt` (mode 600). **Sign in, change the password in Workspace settings, then delete that file.**

**Option A — from the browser (uses the setup token):**
Open `https://innovista-research-ai.zengineeringapp.com`. Because the accounts table is empty, the sign-in page offers workspace setup. Enter the `INNOVISTA_SETUP_TOKEN` value from the env file along with your chosen username, display name and password.

**Option B — on the server (generates a random password):**

```sh
docker exec -it innovista-research-ai-app node --import tsx scripts/init-admin.ts admin "Your Name"
```

It prints the username and a one-time random password, and **refuses to run if any account already exists**.

**Then close the door:** blank `INNOVISTA_SETUP_TOKEN` in the `innovista-research-ai-env` credential and re-run the job. (The setup route already returns `409` once an account exists, so this is defence in depth.) Additional accounts are created by an administrator inside **Workspace settings**, never from the sign-in page.

Finally, sign in and set the AI provider under **Workspace settings** if you left `GEMINI_API_KEY` blank.

---

## 7. Verify the deployment

```sh
# health, through the public domain — exercises nginx + TLS + the app
curl -fsS https://innovista-research-ai.zengineeringapp.com/api/health
# -> {"ok":true,"application":"Innovista Research AI","database":"connected"}

# security headers present, no x-powered-by
curl -sSI https://innovista-research-ai.zengineeringapp.com/ \
  | grep -i 'strict-transport\|content-security\|x-frame'

# bound to localhost only — never 0.0.0.0
docker port innovista-research-ai-app            # -> 3000/tcp -> 127.0.0.1:8110

# unreachable from outside except through nginx
curl -sS -m 5 http://187.127.154.31:8110/   # must fail to connect

# the Host allowlist is real (this is why the vhost must pass Host $host)
docker exec innovista-research-ai-app node -e "
const http=require('http');
http.request({host:'127.0.0.1',port:3000,path:'/api/health',
  headers:{Host:'evil.example.com'}},r=>console.log(r.statusCode)).end();"
# -> 403
```

Then sign in and confirm the Sintertechnik starter project is present with its qualification handbook in the training library. **The migrated rubric requires human review and explicit publication before qualification runs** — old qualification statuses are not treated as results of the new training.

---

## 8. Backups — the one thing you must not skip

The volume holds everything: the database, the uploaded source documents, and the encryption key for provider credentials.

```sh
# Consistent snapshot. Stop the app first: SQLite runs in WAL mode, and copying
# a live WAL database file alone yields a corrupt backup.
docker stop innovista-research-ai-app

docker run --rm \
  -v innovista-research-ai_data:/data:ro \
  -v /srv/innovista-research-ai/backups:/backup \
  alpine tar czf /backup/sinteriq-$(date +%F-%H%M).tgz -C /data .

docker start innovista-research-ai-app
```

The archive contains `innovista.db` **and** `.innovista-encryption-key` — keep them together, and keep the archive encrypted at rest. Restore by extracting into a fresh `innovista-research-ai_data` volume before the first `up`.

---

## 9. Adding a staging stack later

Same recipe on a second port: a `Jenkinsfile.staging`, a `docker-compose.staging.yml` with `sinteriq-staging-*` names and a `sinteriq_staging_data` volume, a `staging-innovista-research-ai-env` credential, and a second vhost + cert for `staging-innovista-research-ai.zengineeringapp.com`. This is how `staging-pomotoro.zengineeringapp.com` runs on port `8096`.

Note that "refresh staging from prod" is a **volume copy** here, not a `mysqldump`:

```sh
docker stop innovista-research-ai-app sinteriq-staging-app
docker run --rm -v innovista-research-ai_data:/from:ro -v sinteriq_staging_data:/to \
  alpine sh -c 'rm -rf /to/* && cp -a /from/. /to/'
docker start innovista-research-ai-app sinteriq-staging-app
```

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Container exits: `Production requires INNOVISTA_ORIGIN with an HTTPS origin.` | `INNOVISTA_ORIGIN` missing or `http://` | Set the exact `https://` origin in the `innovista-research-ai-env` file |
| Container exits: `Run npm run build before starting production.` | `dist/` missing from the image | The build stage asserts `dist/index.html`; rebuild — never mount over `/app/dist` |
| Every request → `403 {"error":"Unrecognized host."}` | nginx not forwarding `Host` | Keep `proxy_set_header Host $host;`, and make `INNOVISTA_ORIGIN`'s host match the vhost's `server_name` exactly |
| Writes → `403 Cross-origin request refused.` | Browser origin ≠ `INNOVISTA_ORIGIN` (e.g. a `www.` prefix, or http) | Use one canonical origin; let certbot's redirect handle http |
| Signed in, then instantly signed out | Session cookie is `secure`; the app cannot tell the request was HTTPS | `INNOVISTA_TRUST_PROXY=1` **and** `proxy_set_header X-Forwarded-Proto $scheme;` |
| Crash loop right after adding the legacy mount | Bind source did not exist → Docker created a directory | Step 2: put a real file at `LEGACY_DB_HOST_PATH`, then `up -d --force-recreate` |
| `EACCES` on `/app/data` | Volume was pre-created as root before the image defined it | `docker run --rm -v innovista-research-ai_data:/d alpine chown -R 1000:1000 /d` (`node` is uid 1000) |
| Health check 503 `database: "unavailable"` | Data volume unreadable, or the DB never initialized | `docker logs innovista-research-ai-app`; check the volume mounted and `/app/data` ownership |
| certbot fails the http-01 challenge | DNS not propagated, or the `:80` block missing | Re-check `nslookup`, `nginx -t`, then retry |
| `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` in logs | Rate limiter sees a forwarded header without trusted-proxy config | Ensure `INNOVISTA_TRUST_PROXY=1` is set (exactly one proxy in front) |
| Uploads fail at ~1–5 MB | nginx body cap, or multer's per-file limit | `client_max_body_size 10m` is set; 5 MB per document is the app's own limit |
| Long AI runs cut off at 60 s | nginx default read timeout | `proxy_read_timeout 300s;` is set in the vhost |

### Appendix — VPS ops cheatsheet

```sh
# SSH in
ssh root@187.127.154.31

# see all running app containers
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'

# tail this app's logs
docker logs -f innovista-research-ai-app

# restart / recreate
docker restart innovista-research-ai-app
docker compose -p innovista-research-ai -f docker-compose.prod.yml --env-file <env> up -d --force-recreate

# nginx: test + reload after editing a vhost
nginx -t && rc-service nginx reload

# TLS certs
certbot certificates
certbot renew --dry-run

# inspect the database volume
docker run --rm -v innovista-research-ai_data:/data:ro alpine ls -la /data
```

> **Never** run `docker system prune` on this box — it is shared. Prune by label only:
> `docker image prune -f --filter "label=com.zengineering.app=innovista-research-ai"`
