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
| Eyeball whether it works | **Mostly closed by the OTA loop** — see below |
| Hand-write schema/functions/rules | *Partial* — blueprint ships a working set; generation is P4 |

### Verification is the OTA update

The fast feedback loop is not a screenshot harness — it is the update itself.
A JS/asset change type-checks in CI and is on the user's phone in about a
minute, so *they* verify it, in the real app, on the real device, against what
they actually meant. That is both cheaper and more truthful than an agent
deciding its own change looked right.

This is why the classifier's bias matters so much (§8): every change it can
honestly route to OTA is a change the user confirms in a minute instead of ten,
and the whole loop stays conversational.

Two things still worth building on top of it:

- **An in-chat preview** for the seconds before the OTA lands — a web render of
  the changed screen, so the user sees something immediately. A convenience, not
  a replacement: the OTA is what proves it works on-device.
- **Automated post-update checks** — the agent watching for a crash spike or a
  failed launch on the new runtime and offering a rollback, which EAS Update
  supports natively by republishing the previous bundle to the channel.

---

## 10. What the blueprint changes, and what it keeps

Read from `JorgeOchoaReyes/ByteLearning`, branch `claude/old-project-review-auhe7k`
(**not** `master`, which is several versions behind at 0.1.0 vs 0.5.0).

**Already working, kept as-is.** The OTA pipeline is complete and proven:
`expo-updates@~0.26.10` is installed, `app.json` sets
`runtimeVersion: { policy: "appVersion" }` and an `updates.url`, `eas.json`
assigns a `channel` per build profile, and both `eas-update.yml` and
`deploy-firestore-rules.yml` exist and work. The blueprint uses these workflows
essentially verbatim.

**Changed, because they are per-app values that would leak across tenants:**

- **The Firebase web config is baked into the bundle**
  (`apps/expo/src/lib/firebase.ts` hardcodes `byte-learning-67778` as an env-var
  fallback). This is correct for one app and fatal for a platform — see §4. It
  becomes a runtime fetch.
- **Workflow branch triggers hardcode `master` and
  `claude/old-project-review-auhe7k`**; `FIREBASE_PROJECT` hardcodes
  `byte-learning-67778`. Both templated.
- **Channels are profile-named** (`development` / `preview` / `production`),
  which is right for one app. With a shared shell binary the channel is the only
  thing separating one tenant's bundle from another's, so it is derived from the
  app id instead.
- **CI runs Node 18 while every deploy workflow runs Node 20.** Standardised on
  20, so a type error cannot pass CI and then fail at deploy.

**Added:** a type-check gate in `eas-update.yml` before publishing. In
ByteLearning a human wrote and reviewed the diff before pushing; here an agent
wrote it, and OTA reaches devices with no review step in between.
