# Von — Architecture

How the proven ByteLearning loop becomes a platform that runs thousands of apps.

---

## 1. The question this document answers

> Do we OAuth users into their own Expo / Firebase / GitHub accounts, or do we
> create everything on our side as one giant project with thousands of projects?

**Neither, exclusively.** The right answer is different for each of the three
providers, because their APIs give you very different amounts of room:

| Provider | Can we create it on the user's behalf? | Verdict |
|---|---|---|
| **GitHub** | Yes — GitHub App install is 2 clicks and gives us scoped, revocable, per-installation rate limits. | **Support BYO from day one.** Default to our org; let them point at theirs whenever. |
| **Firebase / GCP** | Technically, but it requires `resourcemanager.projectCreator` on *their* org **and** an open billing account before they see anything work. | **We own it.** Offer BYO only as "you create the project, you add our service account". |
| **Expo / EAS** | No. There is no public API to create an Expo account for someone, and no third-party OAuth that would let us create projects in their account. | **We own the org, always.** Transfer the project to them on request. |

So the platform is built around **one axis — isolation tier — not around whose
account things live in.** That axis has three positions, and an app moves along
it without being rewritten.

---

## 2. Why "a giant project with thousands of projects" fails on its own

It is the obvious design and it hits a wall that is not obvious until you are in it:

- **GCP project quota is not a soft limit.** A new billing account is capped
  around a few dozen projects. Raising it is a support request, granted in
  increments, and reviewed against actual usage. Nobody is handing you 100,000
  projects.
- **Deleted projects keep consuming quota.** Project deletion is a ~30-day soft
  delete. A product where users spin up and abandon apps burns quota faster than
  it reclaims it.
- **Project creation is slow.** Create + billing + enable APIs + `addFirebase`
  is 60–180 seconds of long-running operations. Putting that in front of "I
  described my app, where is it?" is the single worst place to spend two minutes.
- **Cloud Functions have a per-project floor.** Each dedicated project with
  deployed functions carries build, storage, and minimum-instance cost even at
  zero traffic. Multiply by every abandoned experiment.

The failure is not that dedicated projects are wrong — they are exactly right for
a real, published, paying app. The failure is using them as the *default*.

---

## 3. The isolation tiers

### Tier 0 — Pooled (default, instant, free)

The app does **not** get a GCP project. It gets:

- a **GCIP tenant** inside a shared pool project — its own isolated user pool,
  its own sign-in settings, created in about a second;
- a Firestore path prefix, `t/{tenantId}/…`, enforced by security rules that
  read the tenant claim off the caller's token;
- **shared, platform-owned Cloud Functions**, not per-app ones. The generated
  app calls the same `generateCourse`-style callables every pooled app calls;
  the function reads the tenant from the auth token and scopes its writes.
- delivery through the **shell app** — Von's own host binary — on a per-app
  **EAS Update channel**. No native build.

Time from "user finishes describing the app" to "user is using it on their
phone": seconds. Marginal cost per app: Firestore storage.

**This is where the overwhelming majority of apps live, permanently.**

### Tier 1 — Dedicated (on publish / on payment)

A real Firebase project, created by `genesisPlan` with `backendTier: "dedicated"`:
its own Firestore, its own Anonymous auth, its own deployed functions, its own
EAS project, its own bundle id and binaries.

Because this consumes the scarce resource — GCP project quota — it is gated
behind an explicit action (publish to a store, or upgrade). That gate is what
keeps quota demand proportional to revenue rather than to signups. A few
thousand dedicated projects is a reasonable quota conversation with Google; a
few hundred thousand is not, and this design never asks for it.

### Tier 2 — BYO / Export (enterprise, and the anti-lock-in story)

- **GitHub**: they install the Von GitHub App on their own org. Generated repos
  are created there instead. Works from day one; no special casing.
- **Firebase**: *they* create the project (Google's console does this well), then
  grant our provisioner service account on it. We skip `firebase.project` and run
  every downstream step unchanged. This is far less friction than OAuthing us
  into project-creation rights on their org.
- **Expo**: we transfer the EAS project to their account. Expo supports project
  transfer; account creation stays theirs to do.

Tier 2 is also the honest answer to "what happens if we leave?" — the generated
repo is a normal Expo + Firebase monorepo with working CI. It runs without us.

---

## 4. What makes moving between tiers cheap

The ByteLearning reference bakes the Firebase web config into the bundle:

```ts
// apps/expo/src/lib/firebase.ts — the reference implementation
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? "AIzaSy…",
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? "byte-learning-67778",
  …
};
```

That is correct for one app and fatal for a platform: the backend identity is
frozen into the binary, so promoting an app from pooled to dedicated would mean
a rebuild and a reinstall.

**The blueprint changes exactly one thing: config is fetched at boot.**

```ts
// templates/app-blueprint — resolved at runtime, cached, falls back to cache offline
const config = await fetchRuntimeConfig(VON_APP_ID);
```

`RuntimeConfig` (see `packages/core/src/domain.ts`) carries the Firebase web
config, the optional `gcipTenantId`, and the `dataPrefix`. Pooled and dedicated
apps differ *only* in those values. Promotion becomes:

1. run `genesisPlan` with `backendTier: "dedicated"`,
2. migrate the `t/{tenantId}/…` subtree into the new project,
3. flip the runtime config.

No rebuild. No reinstall. No store review. That single indirection is what makes
the tier system usable rather than theoretical.

---

## 5. Scaling the pool itself

One pool project does not hold every app — GCIP allows on the order of a
thousand tenants per project. So pools are **sharded**:

- pool projects are provisioned *ahead of demand* by the platform, not on the
  user's critical path;
- each holds ~1000 apps;
- an allocator hands a new app the least-loaded pool with capacity;
- `App.gcipTenantId` plus the pool's project id fully identify where an app's
  data lives.

Growing to 100k apps is then 100 pool projects — a quota number you can actually
get, provisioned by you, at your pace, with no user waiting on any of it.

---

## 6. Repository layout

```
apps/
  chat/        Expo — the customer-facing chat app (users describe apps here)
  admin/       Next.js — Von's own console: tenants, apps, provisioning, releases
  api/         Control plane — chat streaming, provisioning runs, runtime config
packages/
  core/        Domain types, ids, the resource ledger
  provisioning/  Drivers (Google/GitHub/EAS) + idempotent plan orchestrator
  release/     OTA-vs-native diff classifier
  agent/       The Claude agent that edits a generated app's repo
  generator/   Blueprint → a parameterised, per-app monorepo
templates/
  app-blueprint/  The ByteLearning stack, parameterised
```

`apps/chat` is **app #0**: it is itself generated from the blueprint and shipped
through the same pipeline it sells. Dogfooding is not a nice-to-have here — it is
the only way the release path gets exercised often enough to be trustworthy.

---

## 7. Provisioning: DEPLOY.md as code

`packages/provisioning/src/plans/genesis.ts` is a direct, step-for-step
translation of the manual runbook:

| DEPLOY.md step (human, in a browser) | Plan step |
|---|---|
| §1.1 create Firebase project | `firebase.project` |
| §1.2 enable Anonymous auth | `firebase.auth` |
| §1.3 create Firestore | `firebase.firestore` |
| §1.4 upgrade to Blaze | billing attach inside `firebase.project` |
| §3.1–3.2 service account + Editor role | `firebase.serviceaccount` |
| §3.3 paste `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT` | `github.secret` |
| §4.1 create Expo project | `eas.project` |
| §4.2 paste `projectId` into `app.json` | generator, not a step |
| §5.1 paste `EXPO_TOKEN` | `github.secret` |

Three properties make this safe to run against real infrastructure:

1. **Every step is keyed.** `firebase.project:app_abc123` is derived purely from
   the app id, so a retried run resolves to the same key.
2. **The ledger is written before and after.** A crash between "GCP created the
   project" and "we recorded it" is recovered by the driver's `read()`, so we
   never orphan a resource we are billed for and cannot find.
3. **Terminal vs retryable errors are distinguished.** 429/5xx back off and
   retry; a 400 aborts the run and surfaces to the user instead of hammering.

For a pooled + shell app only three steps actually execute — `gcip.tenant`,
`github.repo`, `eas.channel`. Everything else is skipped until promotion.

---

## 8. Automating the OTA-vs-native hand-off

The brief calls this "the key decision" and leaves it to a human. It is a pure
function of the diff, and `packages/release/src/classify.ts` implements it.

The design is driven by an asymmetry:

- choosing **native** wrongly costs the user a ~10-minute build they did not need;
- choosing **OTA** wrongly ships JS referencing a native module the installed
  binary does not have. **The app crashes on launch, on a device we cannot
  reach.**

So anything the classifier cannot *prove* is JS-only is routed to a native
build — including, deliberately, any dependency it does not recognise. A false
rebuild is invisible; a false OTA is a support ticket and an uninstall.

`runtimeVersion` is bumped on exactly the native path, which is what stops a new
bundle from ever landing on an old binary.

---

## 9. Where the remaining human hand-offs go

| Brief §5 hand-off | Status here |
|---|---|
| Judge native rebuild vs OTA | **Automated** — `packages/release` |
| Install APK to see a native change | **Removed for Tier 0** — shell app + channel; native only on publish |
| Paste API keys / credentials | **Automated** — `github.secret` driver seals and uploads |
| Trigger deploy and watch it | **Automated** — `dispatchWorkflow` + run polling |
| Eyeball whether it works | *Open* — P3 self-verification is not built here |
| Hand-write schema/functions/rules | *Partial* — blueprint ships a working set; generation is P4 |

---

## 10. Known gaps in the reference implementation, carried into the blueprint

Read from `JorgeOchoaReyes/ByteLearning@b47307d`:

- **`expo-updates` is not installed and `runtimeVersion` is not set in
  `app.json`.** OTA is described in the brief but is not actually wired — there
  is no `eas-update.yml` workflow either. The blueprint adds both; without them
  the entire Tier 0 delivery story does not function.
- **`deploy-firestore-rules.yml` does not exist**, so `firestore.rules` is
  published by hand. The blueprint adds the workflow.
- **Workflow triggers hardcode a branch** (`claude/old-project-review-auhe7k`)
  and `FIREBASE_PROJECT` hardcodes `byte-learning-67778`. Both are templated.
- **CI uses Node 18 while deploys use Node 20**, and `turbo` is v1 while
  functions target Node 20. The blueprint standardises on Node 20.
