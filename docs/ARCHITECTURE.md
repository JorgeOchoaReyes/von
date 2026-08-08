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

The app does **not** get a GCP project. It gets, inside a shared pool project:

- its own **GCIP tenant** — a genuinely separate user pool. A user of app A
  cannot authenticate into app B: different tenant, different credential store,
  different uid space. Created in about a second.
- its own **named Firestore database**. Not a path prefix inside a shared
  database — an actual separate database, which is the difference between
  isolated and merely namespaced. See §3.1.
- **shared, platform-owned Cloud Functions**. Tier 0 users do not write server
  code; the generated app calls the same platform callables every pooled app
  calls, and the function scopes its work by the tenant claim on the caller's
  token.
- delivery through the **shell app** — Von's own host binary — on a per-app
  **EAS Update channel**. No native build.

Time from "user finishes describing the app" to "user is using it on their
phone": seconds. Marginal cost per app: Firestore storage.

**This is where the overwhelming majority of apps live, permanently.**

### 3.1 Blast radius: why a database per app, not a path prefix

The requirement is that one app's problems cannot break everyone else's apps.
Path-prefixing inside one shared Firestore database fails that, because the
things that break are **per-database, not per-document**:

| Shared resource | What one app can do to everyone |
|---|---|
| **Composite indexes** (~200 per database) | A few indexes per app and one tenant's data model exhausts indexing for the whole pool. New queries silently fail to deploy fleet-wide. This alone disqualifies the design. |
| **The security rules file** | One rules file governs the whole database. A bad rule is not one app's bug, it is a cross-tenant data leak. |
| **Backup / point-in-time recovery** | Granularity is the database. You cannot restore one app without restoring all of them, so any recovery is a fleet-wide rollback. |
| **Hot-spotting and throughput** | Sequential keys or a write-heavy collection degrade neighbours. |

A **named database per app** removes every row of that table. Databases are
created in seconds, cost nothing extra at rest, and each carries its own
indexes, own rules, own backups, own throughput. The cost is a tighter per-project
cap (~100 databases instead of ~1000 GCIP tenants), which just means more pool
projects — and those are provisioned in bulk, ahead of demand, with nobody
waiting (§5).

What *remains* shared in Tier 0, and how it is contained:

- **Cloud Functions.** Since Tier 0 runs no user-written server code, the risk
  is traffic, not code: one app's volume consuming the project's function
  concurrency. Contained with per-tenant rate limits and concurrency caps
  enforced inside the platform function, plus per-tenant quota alerting. The
  moment an app needs *custom* server code, that is the signal to promote it.
- **Project-level API quotas.** Bounded by pool size; a pool is ~100 apps, not
  100,000.

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
config, the optional `gcipTenantId`, and the `firestoreDatabaseId`. Pooled and
dedicated apps differ *only* in those values. Promotion becomes:

1. run `genesisPlan` with `backendTier: "dedicated"`,
2. export the app's database and import it into the new project — a managed
   Firestore export/import of one whole database, not a bespoke subtree
   extraction. This is a second reason the database-per-app split matters:
   it makes promotion a standard operation instead of a migration script.
3. flip the runtime config.

No rebuild. No reinstall. No store review. That single indirection is what makes
the tier system usable rather than theoretical.

---

## 5. Scaling the pool itself

One pool project does not hold every app. Two per-project limits bind, and the
tighter one wins:

- GCIP allows on the order of a **thousand tenants** per project;
- Firestore allows on the order of a **hundred databases** per project (a quota
  that can be raised, but not indefinitely).

Since every pooled app now owns a database (§3), **the database quota is the
binding constraint and pools shard at roughly 100 apps each** — not the ~1000
an earlier draft of this document assumed. That is 10x more pool projects than
first estimated: 100k apps is on the order of 1000 pool projects.

That is still fine, and it is fine for a specific reason: pool projects are
**platform-provisioned ahead of demand**, in bulk, on your schedule. Nobody
waits on one. Compare that to 100k *dedicated* projects, which you could never
get quota for and which would each be created on a user's critical path.

- an allocator hands a new app the least-loaded pool with database capacity;
- `App.gcipTenantId` + the pool project id + the app's `firestoreDatabaseId`
  fully identify where an app's users and data live.

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

---

## 11. Decision: Firebase or Supabase for the data tier?

Supabase is the natural alternative — close enough to Firebase to be a small
conceptual jump, with Postgres underneath. Worth taking seriously, so here is
the comparison on the axis that actually matters, blast radius:

| | Firestore, database per app | Supabase, schema per app (pooled) | Supabase, project per app |
|---|---|---|---|
| Provision time | seconds | milliseconds (`CREATE SCHEMA`) | 1–2 min (a Postgres instance) |
| Idle cost per app | ~$0 (serverless) | amortised instance cost | a real per-project floor |
| Index isolation | own | own | own |
| Rules isolation | own rules file | own RLS policies | own |
| **Identity isolation** | **own GCIP tenant** | **shared — one `auth.users` table** | own |
| Noisy neighbour | strong — serverless, no shared CPU | weaker — shared CPU, shared connection pool | strong |
| Density per project | ~100 databases | thousands of schemas | 1 |
| Agent ergonomics | rules DSL + index JSON | **SQL migrations — far more reviewable** | same |

**Recommendation: stay on Firebase for v1.** Three reasons, in order of weight:

1. **Identity isolation is the deciding factor.** Supabase Auth is per-*project*.
   Pooled Supabase means every app shares one `auth.users` table — a user of
   app A exists in app B. There is no in-project equivalent of a GCIP tenant.
   You could fake it with a shared identity provider and an `app_id` JWT claim,
   but then "their own users" is a claim you cannot honestly make. GCIP tenants
   give it for free.
2. **Serverless beats shared CPU for the pooled tier.** Thousands of mostly-idle
   experimental apps is exactly Firestore's shape and exactly Postgres's worst
   shape — a schema-per-app pool shares a connection pool and CPU, so one
   runaway query degrades neighbours. Firestore has no shared compute to
   contend for.
3. **It is proven and shipping.** ByteLearning's auth, functions, client code
   and CI all work today. Rewriting the data layer before v1 spends weeks to
   arrive back where we started, with new unknowns.

**Where Supabase genuinely wins, and when to revisit.** Its real advantage is
agent ergonomics: a SQL migration is enormously easier for an agent to write
correctly and for a human to review than Firestore's rules DSL plus index JSON.
Per-app Edge Functions are also a better isolation story than shared Cloud
Functions. Both of those bite hardest in the **dedicated** tier, where apps have
custom server logic — so the honest position is:

> Firebase for v1 and for the pooled tier. Re-evaluate Supabase for the
> dedicated tier once we see how often generated apps need custom server code
> and custom schema. Nothing in the design prevents Tier 1 running on a
> different stack from Tier 0 — `RuntimeConfig` is already the seam.

**What would change the recommendation:** if pooled apps turn out to need
custom server code often, the shared-Functions constraint becomes the binding
problem rather than identity, and per-app Edge Functions start to outweigh
GCIP tenants.

---

## 12. Definitions: pool project and shell app

Two pieces of platform-owned infrastructure the rest of this document assumes.

### Pool project

A **Firebase/GCP project that Von owns and many customers' apps live inside**.
Concretely, `von-pool-001`. It is created by you, in bulk, ahead of demand — never
on a user's critical path.

Inside one pool project, each app gets:

- its own **GCIP tenant** — an isolated user pool, so app A's users cannot sign
  into app B;
- its own **named Firestore database** — its own indexes, rules, backups and
  throughput.

A pool holds roughly 100 apps, bound by the Firestore database quota. Reaching
100k apps is therefore ~1000 pool projects. `allocatePool` decides which pool a
new app lands in, never overfills one, and is sticky so a re-run of genesis
resolves to the same pool.

The whole point: **a new app consumes no GCP project quota and waits on no
project creation.** Provisioning is seconds instead of 1–3 minutes.

### Shell app

One Expo binary that Von builds and publishes **once**, which the user installs
**once**. A customer's app is delivered into it as a JavaScript bundle over an
EAS Update channel, so making an app requires no native build at all.

This is the mechanism behind "describe it, use it in a minute" for a *brand-new*
app. It is also the least-proven part of this design — ByteLearning never did it
— and it carries three real constraints:

1. **Runtime channel switching requires disabling anti-bricking measures.**
   `Updates.setUpdateURLAndRequestHeadersOverride()` (SDK 52+, expo-updates
   0.27+) is what lets one binary point at different apps' channels. Expo
   requires `disableAntiBrickingMeasures: true` to use it. On a binary that runs
   *many customers' apps*, that means removing the safety net that stops a bad
   bundle from bricking the app — and one bad bundle bricks the shell for that
   user, not just one of their apps.
2. **The shell's native modules are fixed at build time.** Any app needing a
   native module the shell was not built with cannot run inside it. The shell
   has to ship a kitchen-sink set (camera, notifications, …) and is still a
   ceiling on what a generated app can be.
3. **One update loads at a time.** Switching between a user's apps means
   overriding the channel and reloading.

### The alternative: no shell app

Every app is `standalone` from the start — its own EAS project, bundle id and
binaries. The first build costs ~10 minutes, once. **Every iteration after that
is still a ~1 minute OTA**, because an installed build receives updates on its
own channel with none of the above machinery.

What is lost: the very first run is ten minutes instead of one.
What is gained: no `disableAntiBrickingMeasures`, no fixed native ceiling, no
channel-override complexity, and one less axis in the system.

The instant-feedback gap can be covered by a **web preview** — the same Expo
bundle rendered in the chat — which is genuinely instant, needs no binary, and
is useful regardless of which delivery model wins.

**Recommendation: drop the shell app for v1.** Note the two axes are
independent, and this changes only delivery: pooled backends (§3) are unaffected
and remain the default.
