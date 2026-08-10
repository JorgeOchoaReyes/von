# Deploying Von

Everything the platform needs, in the order you need it. Nothing here is asked
of a *user* — that is the whole premise (ARCHITECTURE §1). This is what **you**
provide once, so that they never have to.

CI (`.github/workflows/ci.yml`) runs typecheck and tests on every push and pull
request. CD (`.github/workflows/cd.yml`) deploys the control plane and the
console to Cloud Run when CI passes on `master`. CD only fires on a *successful*
CI run, so a red commit never reaches production.

**Start with §0** — it needs two tokens and exercises the product loop. The
rest of this document is what the platform needs to *create* apps from nothing.

---

## 0. Try the loop first, with two tokens

Before any of the below, you can exercise the part that *is* the product —
chat → agent edit → preview → publish — against a repository that already
exists. It needs `ANTHROPIC_API_KEY` and `GITHUB_INSTALLATION_TOKEN`, and
nothing else: no billing account, no Expo org, no DNS.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_INSTALLATION_TOKEN=ghs_...
pnpm --filter @von/api dev
```

Create an app that **adopts** a repo instead of provisioning one. Point it at a
clone of the blueprint, or any Expo app laid out with the app under `apps/expo`:

```bash
curl -s -X POST localhost:8787/v1/apps -H 'content-type: application/json' \
  -d '{"name":"Trial","repoFullName":"your-org/your-expo-app"}'
```

Then drive the loop:

```bash
# 1. Edit and preview — commits nothing, ships nothing.
curl -s -X POST localhost:8787/v1/apps/$APP/chat \
  -H 'content-type: application/json' -d '{"message":"add a settings screen"}'

# 2. Look at it. The chat response carries the preview URL.
curl -s localhost:8787/v1/apps/$APP/preview

# 3. Reject it...
curl -s -X DELETE localhost:8787/v1/apps/$APP/preview
# ...or ship it. This is the only call that pushes and dispatches a release.
curl -s -X POST localhost:8787/v1/apps/$APP/publish
```

The first turn takes a minute or so — the session clones the repo and installs
its dependencies before Metro starts. Every turn after that fast-refreshes.

Publishing needs the repository's own workflows (`eas-update.yml` and friends)
and its `EXPO_TOKEN` secret to be in place, so with only these two tokens the
publish step dispatches and then fails inside the repo's Actions. Everything up
to and including the commit and push is real.

**`GET /v1/readiness` tells you where you are** at any point — which
capabilities are configured, and what each gap blocks:

```bash
curl -s localhost:8787/v1/readiness | jq '.blockers'
```

---

## 1. Google Cloud

One project for the platform itself. Pool projects (§5) are separate and come
later.

```bash
export VON_PROJECT=von-platform          # your platform project
export REGION=us-central1

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudresourcemanager.googleapis.com \
  firebase.googleapis.com \
  identitytoolkit.googleapis.com \
  --project "$VON_PROJECT"
```

### Firestore for the control plane

The resource ledger lives here. This is the difference between a restart that
*resumes* provisioning and one that re-runs it — and a re-run with no memory
creates a second billable GCP project and orphans the first.

```bash
gcloud firestore databases create \
  --database=von-control \
  --location="$REGION" \
  --type=firestore-native \
  --project "$VON_PROJECT"
```

A named database, not `(default)`: the platform's own bookkeeping should not
share a database with anything else that project ever hosts.

### Container registry

CD builds two images — the control plane and the console — and tags each with
its commit SHA. Never `latest`: a rollback should name an exact image, not hope
a mutable tag still points where you think it does.

```bash
gcloud artifacts repositories create von \
  --repository-format=docker --location="$REGION" --project "$VON_PROJECT"
```

### Two service accounts

Separated because they fail differently. A leaked deploy credential redeploys
old code; a leaked runtime credential creates projects and spends money.

```bash
# CI/CD: builds the image and updates the service.
gcloud iam service-accounts create von-deployer --project "$VON_PROJECT"

# The running control plane: provisions customers' resources.
gcloud iam service-accounts create von-runtime --project "$VON_PROJECT"
```

Roles for `von-deployer`: `roles/run.admin`, `roles/artifactregistry.writer`,
`roles/iam.serviceAccountUser`.

Roles for `von-runtime`: `roles/datastore.user`,
`roles/secretmanager.secretAccessor`, and — on the **folder or organisation**
that holds pool projects, not on the platform project —
`roles/resourcemanager.projectCreator` and `roles/billing.user`.

### Workload Identity Federation

So CD holds no long-lived key at all. Follow
[google-github-actions/auth](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation),
restricting the provider to this repository. The workflow needs
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT`.

---

## 2. GitHub

A GitHub App owned by your org, installed on the org that will hold generated
repositories. It needs **Contents: read & write**, **Actions: read & write**,
**Secrets: write**, and **Administration: write** (to create repositories).

Push `templates/app-blueprint/` from this repo to a repository of its own and
mark it as a **template** — genesis creates each app's repo with the
template-generate API, which copies it verbatim, tokens and all. The `hydrate`
step then substitutes the per-app values as the repo's first real commit, and
fails the run if any token survives.

```bash
gh repo create your-org/app-blueprint --private
# push the contents of templates/app-blueprint to it, then mark it a template
```

> The default branch of generated repositories must be `master`, matching
> `PROD_BRANCH`. Set it as the template's default branch; the API used here
> cannot change repository settings after creation.

---

## 3. Expo

One Expo organisation that owns every generated project. There is no API to
create an Expo account on a user's behalf (ARCHITECTURE §1), so this is
permanent — projects transfer to a customer's own org only on request, at store
submission time.

You need a bot user's access token, the account id, and the account name.

---

## 4. Preview hosting

Previews are served at `<token>.$VON_PREVIEW_HOST`, proxied to the session's
loopback port. Point a **wildcard** record at the Cloud Run service and map the
domain:

```bash
gcloud beta run domain-mappings create \
  --service von-api --domain "*.preview.example.com" \
  --region "$REGION" --project "$VON_PROJECT"
```

Leave `VON_PREVIEW_HOST` unset and previews stay loopback-only — usable from the
machine running the control plane, invisible from a phone. Nothing is exposed
either way.

---

## 5. Pool projects

Each pool holds ~100 apps, bounded by the Firestore database quota
(ARCHITECTURE §5). Create them **ahead of demand** — never on a user's path —
each with billing attached and a Firebase web app, then list them in
`VON_POOLS`:

```json
[{ "projectId": "von-pool-001", "used": 0, "capacity": 100, "accepting": true }]
```

`VON_POOL_WEB_CONFIGS` maps each pool project id to its Firebase web config.

`VON_POOLS` seeds the registry **create-if-absent**. `used` is live state, so
editing the list later will not resurrect an occupancy count — capacity changes
and draining are deliberate operator actions against Firestore.

---

## 6. Secrets

Create these in Secret Manager under exactly these names; `cd.yml` mounts them
by name, so nothing sensitive appears in a workflow log or in the service
description.

| Secret | What it is |
|---|---|
| `von-api-keys` | Comma-separated keys that may call the control plane |
| `von-admin-api-key` | The single key the console presents. One of the above |
| `anthropic-api-key` | Powers the build agent |
| `github-installation-token` | GitHub App installation token |
| `expo-token` | Expo bot user's access token |
| `gemini-api-key` | Handed to generated apps' Cloud Functions |
| `gcp-billing-account` | e.g. `billingAccounts/0X0X0X-...` |
| `von-pools` | The JSON above |
| `von-pool-web-configs` | Firebase web config per pool project |

Two more secrets are written *into each generated repository* by genesis, not
created by you: `VON_API_URL` and `VON_RELEASE_TOKEN`. They are how the app's own
CI reports what a release did — including the EAS update group, which is the only
handle a rollback has on a published bundle.

```bash
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create von-api-keys --data-file=- --project "$VON_PROJECT"
```

`VON_API_KEYS` is not optional in a deployment. Every endpoint here creates
billable cloud resources, and the control plane **refuses to start** without it
once `VON_FIRESTORE_PROJECT` or `VON_PREVIEW_HOST` is set — an open control
plane is someone else's free build farm.

---

## 7. Repository configuration

**Secrets** (Settings → Secrets and variables → Actions → Secrets):

| Name | Value |
|---|---|
| `GCP_PROJECT` | Platform project id |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full provider resource name |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `von-deployer@…iam.gserviceaccount.com` |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `von-runtime@…iam.gserviceaccount.com` |

**Variables** (same page → Variables) — non-secret, so they are readable in
logs, which is what you want when diagnosing a deploy:

| Name | Example |
|---|---|
| `GCP_REGION` | `us-central1` |
| `GCP_PARENT` | `folders/123456789` |
| `VON_FIRESTORE_DATABASE` | `von-control` |
| `VON_PREVIEW_HOST` | `preview.example.com` |
| `VON_GITHUB_ORG` | `von-apps` |
| `VON_TEMPLATE_REPO` | `your-org/app-blueprint` |
| `VON_PUBLIC_URL` | `https://api.example.com` — baked into every generated app |
| `EXPO_ACCOUNT_ID` / `EXPO_ACCOUNT_NAME` | from Expo |

Create a `production` environment (Settings → Environments) if you want a manual
approval in front of deploys; `cd.yml` already targets it.

---

## 8. Deploy

Push to `master`. CI runs; on green, CD builds and deploys two services:

| Service | From | Reachable by |
|---|---|---|
| `von-api` | `apps/api/Dockerfile` | Anyone — it gates itself on `VON_API_KEYS` |
| `von-admin` | `apps/admin/Dockerfile` | Google identity only (`--no-allow-unauthenticated`) |

The console deploys *after* the control plane, and reads the API's URL from
Cloud Run rather than from configuration, so the two cannot drift apart. It is
not publicly reachable: it holds a key that creates billable resources, so
reach it through IAP or

```bash
gcloud run services proxy von-admin --region "$REGION" --project "$VON_PROJECT"
```

The control plane's deploy fails if it comes up **without durable storage** —
`/healthz` reports `durable`, and one silently running in memory is a failed
deploy, not a healthy one.

To verify by hand:

```bash
curl -s https://<service-url>/healthz            # {"ok":true,"durable":true,...}

# Every capability, and what any gap still blocks.
curl -s -H "Authorization: Bearer $VON_API_KEY" \
     https://<service-url>/v1/readiness | jq '{ready, blockers}'

curl -s -H "Authorization: Bearer $VON_API_KEY" https://<service-url>/v1/apps
```

An app created before a credential was in place is not stranded — genesis is
idempotent, so re-running it resumes rather than duplicating:

```bash
curl -s -X POST -H "Authorization: Bearer $VON_API_KEY" \
     https://<service-url>/v1/apps/$APP/provision
```

### What runs on one instance, and why

`--max-instances 1` applies to the **control plane only**, and it is a
correctness constraint rather than a cost decision. A preview session is a git
checkout plus a Metro process held in that process's own memory, so a second
instance would answer a publish for a session it does not have. Scaling out
means moving preview sessions onto their own workers first — the runner is
already behind an interface for exactly that reason.

The console has no such constraint: it holds nothing in memory, scales to zero,
and runs several instances freely.

### Rolling back

Run the **CD** workflow manually with a known-good commit SHA as `ref`. Images
are tagged by commit, so this redeploys exactly what ran before.

---

## Local development

No credentials needed:

```bash
pnpm install
pnpm --filter @von/api dev
```

It runs in memory, with authentication off, and says so on startup. Setting
either `VON_FIRESTORE_PROJECT` or `VON_PREVIEW_HOST` puts it in deployment mode,
where a missing `VON_API_KEYS` is a startup error.
