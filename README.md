# Von

Describe an app in a chat; it gets built, deployed, and iterated for you — mobile
included.

This is the platform build of the loop proven by hand in
[ByteLearning](https://github.com/JorgeOchoaReyes/ByteLearning): Expo + Firebase
+ EAS + GitHub Actions, driven from conversation. The reference implementation
shipped one app with two human hand-offs left (deciding OTA-vs-native, and
installing builds). Von's job is to remove those and run the loop for many apps
at once.

**Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** It answers the
load-bearing question — how this scales without either drowning in GCP project
quota or forcing every user through three OAuth screens and a credit card form.

---

## Layout

```
apps/
  chat/     Expo — customer-facing chat app. Users describe apps here.
  admin/    Next.js — Von's console: tenants, apps, provisioning, releases.
  api/      Hono — control plane. Chat streaming, provisioning, runtime config.
packages/
  core/         Domain types, ids, the resource ledger.
  provisioning/ Google/GitHub/EAS drivers + idempotent plan orchestrator.
  release/      OTA-vs-native diff classifier.
  agent/        The Claude agent that edits a generated app's repo.
  generator/    Blueprint -> a parameterised, per-app monorepo.
templates/
  app-blueprint/  The ByteLearning stack with per-app values templated out.
```

`apps/chat` is app #0 — it is generated from the same blueprint and shipped
through the same pipeline it sells.

---

## The three ideas worth knowing

**1. Apps are pooled by default, dedicated on publish.**
A new app gets a GCIP tenant inside a shared Firebase project plus a Firestore
path prefix — isolated auth and data, provisioned in about a second, consuming
no GCP project quota. It only gets a real Firebase project when it is published
or upgraded. This is what makes "describe it, use it" possible, and what stops
project quota from being the ceiling on signups.

**2. Backend config is fetched at runtime, not baked into the bundle.**
The reference implementation hardcodes the Firebase web config in
`apps/expo/src/lib/firebase.ts`. Von's blueprint fetches it from
`/v1/apps/:id/runtime-config` at boot. That one indirection is why an app can be
promoted from pooled to dedicated without a rebuild, a reinstall, or a store
review.

**3. OTA-vs-native is a pure function of the diff, and it is biased.**
`packages/release` routes JS/asset changes over the air and anything else to a
native build. When it cannot *prove* a change is JS-only — an unrecognised new
dependency, an unfamiliar path — it chooses native. A needless rebuild costs ten
minutes; a wrong OTA ships JS referencing a missing native module and crashes
the app on a device you cannot reach.

---

## Running it

```bash
pnpm install
pnpm test        # release classifier + generator guards
pnpm typecheck
```

```bash
pnpm --filter @von/api dev      # control plane on :8787
pnpm --filter @von/admin dev    # admin console on :3000
pnpm --filter @von/chat  dev    # Expo chat app
```

The control plane runs with an in-memory store and needs no credentials until
you provision something real.

### Credentials for real provisioning

All platform-owned. Users supply none of these — that is the point.

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Powers the build agent |
| `GOOGLE_ACCESS_TOKEN` | Provisioner service account (ADC in production) |
| `GCP_PARENT` | Folder/org new projects are created under, e.g. `folders/123` |
| `GCP_BILLING_ACCOUNT` | Billing account to attach — Blaze is required for Functions |
| `VON_POOL_PROJECT_ID` | The shared project backing pooled apps |
| `VON_POOL_WEB_CONFIG` | That project's Firebase web config, as JSON |
| `GITHUB_INSTALLATION_TOKEN` | Von GitHub App installation token |
| `VON_GITHUB_ORG` | Org that owns generated repos |
| `VON_TEMPLATE_REPO` | `owner/repo` of the blueprint, marked as a template |
| `EXPO_TOKEN` / `EXPO_ACCOUNT_ID` / `EXPO_ACCOUNT_NAME` | Platform's Expo org |
| `GEMINI_API_KEY` | Handed to generated apps' Cloud Functions |

---

## Status

Built and tested:

- resource ledger + idempotent, resumable provisioning orchestrator
- Google (project, billing, Firestore, anonymous auth, GCIP tenant, deploy SA),
  GitHub (template repo, sealed Actions secrets, workflow dispatch) and EAS
  (project, channel) drivers
- the genesis plan — DEPLOY.md translated step-for-step into code
- OTA-vs-native classifier (9 tests) and blueprint token guard (4 tests)
- streaming build agent with a scoped file-edit tool surface
- control plane, admin console, Expo chat client

Not built yet:

- **P3 self-verification** — running the generated app, screenshotting it, and
  checking the result against the request. This is the largest remaining gap
  between "the agent edited files" and "the change actually works".
- Firestore-backed store (everything is in-memory today)
- the pool allocator that shards apps across pool projects at ~1000 each
- pooled -> dedicated data migration
- store submission (TestFlight / Play internal)

### Gaps found in the reference implementation

Read from `JorgeOchoaReyes/ByteLearning@b47307d`. These are carried as fixes in
the blueprint, not criticisms — they are the difference between one app and many:

- `expo-updates` is not installed and `runtimeVersion` is not set, so **OTA does
  not actually work yet** despite being central to the brief. There is no
  `eas-update.yml`. Both are added here.
- No `deploy-firestore-rules.yml`; rules are pasted into the console by hand, so
  deployed rules can drift from the repo. Added here.
- Workflow triggers hardcode a working branch, and `FIREBASE_PROJECT` hardcodes
  `byte-learning-67778`. Both templated.
- CI runs Node 18 while deploys run Node 20. Standardised on 20.
