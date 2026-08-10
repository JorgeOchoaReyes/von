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
  preview/      Live preview sessions — a checkout plus a dev server per app.
  store/        Durable persistence: apps, resource ledger, pool assignments.
  generator/    Blueprint -> a parameterised, per-app monorepo.
templates/
  app-blueprint/  A complete Expo + Firebase monorepo with per-app values as
                  {{TOKENS}}. Push this to its own repo and mark it a template;
                  genesis copies it, renames the branch to `master`, and
                  `hydrate` substitutes the values.
```

`apps/chat` is app #0 — the intent is for it to be built and shipped through the
same pipeline it sells. Today it is hand-written and deployed with the rest of
this repo; dogfooding it is a later step, not a claim about the present.

---

## The three ideas worth knowing

**1. Apps are pooled by default, dedicated on publish.**
A new app gets, inside a shared Firebase project, its own GCIP tenant (its own
user pool — app A's users cannot sign into app B) and its own named Firestore
database (its own indexes, rules, backups, throughput). Provisioned in seconds,
consuming no GCP project quota. It only gets a real Firebase project when it is
published or upgraded. This is what makes "describe it, use it" possible, and
what stops project quota from being the ceiling on signups.

A database per app rather than a path prefix in a shared one is the difference
between isolated and merely namespaced: composite indexes cap at ~200 *per
database*, one rules file governs a whole database, and backup granularity is
the database. Sharing one makes every app's data model everyone else's problem.

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

## Making and updating apps

One code path — `apps/api/src/update.ts` — backs every surface, so how an
instruction becomes a change on someone's phone is defined in exactly one place.
It has two halves, and the split between them is the product:

```
preview:  agent edits the working tree -> web preview -> classify what
          publishing would do
publish:  commit & push -> dispatch OTA or build -> record the runtime version
```

An over-the-air update reaches a build that is already installed; it cannot
install one. So the classifier is asked two questions, not one — *does this
change the binary?* and *is there a binary?* — and the first release of every
app is a build regardless of what it changed. Otherwise the very first
instruction, which is almost always a JavaScript edit, would be announced as
reaching the user's app in about a minute when no app exists on any phone.

A native release also *writes* its runtime version into the repo's `app.json`
before committing. The policy is `appVersion`, so app.json is where the runtime
version actually lives: a bump the control plane records but never commits
leaves every binary on the old version, and the fence that keeps a new bundle
off a binary lacking its native module never moves. Android's `versionCode` is
bumped alongside it, so a device will accept the newer APK over the one it has.

Nothing leaves the session until the user publishes. A preview session holds an
open checkout and a Metro dev server per app, so the first turn costs a few
seconds to boot and every turn after it fast-refreshes in place. Sessions are
capped and swept on idle — each one is a customer's repo on disk plus a
process.

Each session is served at its own origin, `<token>.$VON_PREVIEW_HOST`, proxied
to its loopback port (including the WebSocket upgrade, which is what makes fast
refresh work). An origin rather than a path prefix because Metro serves
root-absolute URLs that no prefix rewrite survives — and because separate
origins keep one customer's previewed code from reading another's.

| Surface | How |
|---|---|
| Chat | `POST /v1/apps/:id/chat` — streams the turn, ends in a preview |
| Publish | `POST /v1/apps/:id/publish` — the only call that ships |
| Reject | `DELETE /v1/apps/:id/preview` — back to the last published state |
| Undo a release | `POST /v1/apps/:id/rollback` — republish the previous update |
| History | `GET /v1/apps/:id/releases` — what shipped, newest first |
| Health | `GET /v1/apps/:id/health` — is the newest release crashing, can it be undone, and where is the installable build |
| Promote | `POST /v1/apps/:id/promote` — pooled backend to a Firebase project of its own, with or without its data |
| Preview state | `GET /v1/apps/:id/preview` — URL and what is pending |
| One app, no chat | `POST /v1/apps/:id/update` — preview and publish in one, for scripts |
| Every app | `POST /v1/fleet/update` with `{"instruction": "...", "dryRun": true}` first, or the console's Fleet page |

The fleet route is how a blueprint fix or dependency bump reaches apps that
already exist — the template only shapes apps created *after* it changed, so
without it every existing app silently drifts. It bounds concurrency (providers
rate-limit per installation), isolates per-app failures, and aborts after 5
failures rather than repeating a systemic error across the whole fleet.

It classifies the diff **git** reports, not the paths the agent claims it
touched: an agent that rewrites a file with identical content reports a change
where git does not, and trusting it would ship empty releases and bump runtime
versions for nothing — invalidating every installed build's OTA channel.

---

## Running it

### 1. Install

Node 22+ and pnpm. Every package runs TypeScript directly under
`--experimental-strip-types`, so there is no build step.

```bash
pnpm install
pnpm typecheck
pnpm test
```

Both run in CI on every push and pull request.

### 2. Start the control plane

```bash
pnpm --filter @von/api dev      # :8787
```

It starts with **no credentials at all** — in-memory storage, authentication
off — and prints exactly what it can and cannot do:

```
[readiness] MISS agent     Editing an app from a chat message
[readiness] MISS github    Creating an app's repository and dispatching releases
[readiness] agent: ANTHROPIC_API_KEY unset — without it, editing an app from a
                   chat message is unavailable
```

`GET /v1/readiness` returns the same thing as JSON, at any time.

### 3. Drive the loop with two tokens

This is the fastest way to see the product work, and it needs no billing
account, no Expo organisation and no DNS:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_INSTALLATION_TOKEN=ghs_...
pnpm --filter @von/api dev
```

Create an app that **adopts** a repository you already have — a clone of
`templates/app-blueprint`, or any Expo app with its code under `apps/expo`:

```bash
APP=$(curl -s -X POST localhost:8787/v1/apps \
  -H 'content-type: application/json' \
  -d '{"name":"Trail Notes","repoFullName":"your-org/your-expo-app"}' \
  | jq -r .id)
```

Then: describe a change, look at it, ship it or throw it away.

```bash
# 1. The agent edits a working tree. Nothing is committed, nothing ships.
curl -s -X POST "localhost:8787/v1/apps/$APP/chat" \
  -H 'content-type: application/json' \
  -d '{"message":"add a settings screen with a dark mode toggle"}'

# 2. The response carries a preview URL — the app running from that tree.
curl -s "localhost:8787/v1/apps/$APP/preview" | jq

# 3a. Not right? Back to the last published state.
curl -s -X DELETE "localhost:8787/v1/apps/$APP/preview"

# 3b. Right? This is the only call that commits, pushes and releases.
curl -s -X POST "localhost:8787/v1/apps/$APP/publish" | jq

# 4. What has shipped, and undo if it was wrong.
curl -s "localhost:8787/v1/apps/$APP/releases" | jq
curl -s -X POST "localhost:8787/v1/apps/$APP/rollback" | jq
```

The first turn takes a minute or so — the session clones the repo and installs
its dependencies before Metro starts. Every turn after that fast-refreshes.

> Publishing dispatches the *target repository's* own workflows, so with only
> these two tokens the release fails inside that repo's Actions unless it has
> `eas-update.yml` and an `EXPO_TOKEN`. Everything up to and including the
> commit and push is real.

### 4. The other two apps

```bash
pnpm --filter @von/admin dev    # console on :3000
pnpm --filter @von/chat  dev    # Expo chat client
```

The console reads `VON_API_URL` and `VON_API_KEY`. The chat client reads
`EXPO_PUBLIC_VON_API_URL` and `EXPO_PUBLIC_VON_API_KEY`; both are optional while
the control plane is running open.

### 5. Everything else

`VON_FIRESTORE_PROJECT` or `VON_PREVIEW_HOST` puts the control plane in
**deployment mode**, where a missing `VON_API_KEYS` is a startup error rather
than an open door. Full provisioning — creating an app's backend, repository and
EAS project from nothing — needs the credentials in
**[`docs/DEPLOY.md`](docs/DEPLOY.md)**, which is the operator's checklist in the
order you need it.

---

## Status

Built and tested:

- resource ledger + idempotent, resumable provisioning orchestrator
- Google (project, billing, Firestore, anonymous auth, GCIP tenant, deploy SA),
  GitHub (template repo, sealed Actions secrets, workflow dispatch) and EAS
  (project, channel) drivers
- the genesis plan — DEPLOY.md translated step-for-step into code
- OTA-vs-native classifier and blueprint token guard (235 tests overall; the two UIs are typechecked and built, not unit-tested)
- streaming build agent with a scoped file-edit tool surface
- preview-then-publish: live web preview of the uncommitted tree, explicit
  publish, one-gesture discard
- preview proxy — per-session origin, token-addressed, WebSocket upgrades for
  fast refresh
- durable Firestore persistence — apps, resource ledger, and pool assignment as
  a real conditional write
- API-key gate that refuses to run open once deployed
- adopt-an-existing-repo, so the product loop runs on two tokens
- release history and one-call rollback — republishes the previous bundle, and
  refuses when there is no honest OTA path back
- generated apps report their release outcome back, so a release records the EAS
  update group a rollback needs
- generated apps report a failed launch, attributed to the release the device is
  actually running — advisory only, never an automatic undo
- both UIs surface it: the console lists every release with its crash count and
  a rollback button, and the chat app interrupts with one when devices start
  failing to open
- a native build path — an installable Android APK, dispatched for the first
  release of every app and for every later change to dependencies or app config,
  with the install link surfaced in both UIs
- pooled -> dedicated promotion — a Firebase project of its own, picked up on the
  app's next launch with no rebuild, with the app's Firestore data copied across
- a Fleet page: preview which apps an instruction would touch, then apply
- `GET /v1/readiness` — every capability, and what each missing variable blocks
- CI on every push and pull request; CD of both services to Cloud Run on
  green `master`, with a rollback path
- control plane, admin console, Expo chat client
- pool allocator — sticky per app, never overfills, warns before capacity runs out

Not built yet:

- **Wildcard DNS and a certificate for `VON_PREVIEW_HOST`.** The proxy is
  built; it needs `*.preview.<domain>` pointed at the control plane. Without it
  previews stay loopback-only, which works on the machine running the control
  plane and nowhere else.
- **Horizontal scale.** Preview sessions live in the control plane's memory, so
  it runs at one instance. Scaling out means moving sessions to their own
  workers — the runner is behind an interface for exactly that.
- **Per-user identity.** The API-key gate authorises *callers*, not *tenants*;
  `tenantId` still comes from the request. A real multi-tenant boundary needs
  signed user tokens.
- **Zero-loss migration.** Promotion copies Firestore data via managed
  export/import, but an export is a live snapshot: writes during the cutover can
  be lost. Freezing writes for the window is the missing piece, so today this
  suits apps with light or paused traffic.
- **iOS builds.** Android is self-signed and installs from a link. iOS cannot
  be: it needs an Apple developer account, and EAS wants it interactively at
  least once, so it is not something the platform can do unattended on a user's
  behalf yet.
- store submission (TestFlight / Play internal)

### Relationship to ByteLearning

Read from branch `claude/old-project-review-auhe7k` — **not `master`**, which is
several versions behind (0.1.0 vs 0.5.0) and is missing most of the pipeline.

The OTA path is complete and proven there: `expo-updates` installed,
`runtimeVersion: { policy: "appVersion" }`, an `updates.url`, per-profile
channels in `eas.json`, and both `eas-update.yml` and
`deploy-firestore-rules.yml` working. The blueprint uses those workflows
essentially verbatim.

What changes is only what has to be per-app:

- **The Firebase web config is baked into the bundle** (`byte-learning-67778`
  hardcoded as an env fallback in `apps/expo/src/lib/firebase.ts`). Right for one
  app, fatal for a platform — it becomes a runtime fetch.
- Workflow branch triggers and `FIREBASE_PROJECT` are hardcoded; both templated.
- Channels are profile-named; here the channel is what separates one app's
  bundles from another's, so it is derived from the app id, never from a name
  the user chose.
- CI runs Node 18 while deploys run Node 20. Standardised on 20.

One thing added: a type-check gate in `eas-update.yml` before publishing. In
ByteLearning a human wrote and reviewed the diff first; here an agent wrote it,
and OTA reaches devices with no review step in between.
