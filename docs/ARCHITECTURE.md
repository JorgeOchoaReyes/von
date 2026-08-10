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
- delivery as a **standalone** app: its own EAS project, bundle id and binaries,
  on its own **EAS Update channel**. One ~10 minute build up front, then every
  change is a ~1 minute OTA. (The shell app was the alternative here; §12
  explains why it lost.)

Time from "user finishes describing the app" to "user is looking at it": seconds,
in the **web preview** (§13). Time to "using it on their phone": one build.
Marginal cost per app: Firestore storage.

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
| Install APK to see a native change | **Reduced to once per app** — one build, then OTAs; the web preview (§13) covers the wait |
| Paste API keys / credentials | **Automated** — `github.secret` driver seals and uploads |
| Trigger deploy and watch it | **Automated** — `dispatchWorkflow` + run polling |
| Eyeball whether it works | **Mostly closed by the OTA loop** — see below |
| Hand-write schema/functions/rules | *Partial* — blueprint ships a working set; generation is P4 |

### Verification is the OTA update

Final verification is not a screenshot harness — it is the update itself.
A JS/asset change type-checks in CI and is on the user's phone in about a
minute, so *they* verify it, in the real app, on the real device, against what
they actually meant. That is both cheaper and more truthful than an agent
deciding its own change looked right.

This is why the classifier's bias matters so much (§8): every change it can
honestly route to OTA is a change the user confirms in a minute instead of ten,
and the whole loop stays conversational.

But a minute is still too slow to be the *iteration* loop, and an OTA is not
reversible for free — it reaches whoever has the app. So verification is now two
stages, not one: the preview (§13) is where the user decides whether the change
is right, and the OTA is where it becomes real. Only the second one is a
release.

### Undo

An OTA reaches every installed device in about a minute with no review step
between an agent's diff and a user's phone. That speed is the product, and it is
also why undo has to exist: the recovery path for a bundle that crashes on
launch cannot be "describe a fix", performed by someone holding an app that no
longer opens.

Rolling back is a **forward** action. EAS Update has no un-publish, so the fix
is to publish the previous bundle again and let it become the newest on the
channel. A rollback is therefore itself a release, recorded like any other, and
the bad one is marked rather than deleted — the record of what went wrong is the
useful part, and it is what stops the next rollback from choosing the bundle
that was just rejected.

Two refusals matter more than the happy path:

- **A native release cannot be undone with an update.** The change lives in the
  installed binary; republishing an older JS bundle does not remove it, and if
  the build bumped the runtime version the bundle would not even reach the new
  binary. That needs another build, and saying so is better than dispatching
  something that appears to succeed.
- **A runtime version bump has no OTA path back.** An update only reaches builds
  whose runtime version matches, so restoring a bundle from before the bump
  would either target devices that cannot run it or silently reach nobody while
  reporting success.

### Noticing

Undo is one call, but nobody is watching. An update lands on every installed
device in about a minute; if it crashes on launch, the person best placed to
notice is holding an app that will not open. So the app reports for itself: a
fatal error posts one signal naming the build it was running, and the control
plane attributes it to the release those devices are actually on — by update
group when the client knows it, by runtime version otherwise. A signal that
matches nothing is dropped rather than guessed, because a crash count on a
bundle that is fine invites undoing it.

`GET /v1/apps/:id/health` answers both halves at once — is this release in
trouble, and can it be undone — because a UI that asks separately ends up
showing a button that fails when pressed.

**The counts are advisory and never trigger an automatic rollback.** The
endpoint cannot be authenticated: a client app holds no secret worth the name,
since anything in a bundle is readable by whoever has it. So the numbers can be
inflated by anyone who cares to. They are enough to raise a question with the
person who published the change, and nowhere near enough to act on unattended.

The report is deliberately thin — that a launch failed, and which build — with
no stack trace, message or device identifier. Those would be user data flowing
out of an app whose content the platform did not write, and the count alone
does the job.

Both UIs surface it. The console lists every release with its crash count and a
rollback button — a server action, so the API key never leaves the server and the
page works without JavaScript, which during an incident is the right trade. The
chat app polls and interrupts with a banner when devices start failing to open.

The wording in both avoids certainty neither has. "N devices failed to open your
app" is what the data supports; "your release is broken" is not, and the refusal
text — *that was a native build* — is shown as prominently as the button,
because during an incident knowing what you cannot do is as useful as the
button.

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

### Decision: no shell app for v1

Taken. `deliveryMode` defaults to `standalone`; every new app gets its own EAS
project and binaries, and `VON_SHELL_EAS_PROJECT_ID` is now optional
configuration rather than a required one. Shell delivery remains implemented and
selectable — genesis still skips the per-app EAS project for it — but nothing
chooses it by default, and genesis fails loudly rather than falling back if an
app asks for shell delivery without a shell project configured.

Note the two axes are independent: this changes only delivery. Pooled backends
(§3) are unaffected and remain the default.

---

## 13. Preview before publish

The delivery numbers above — 10 minutes for a build, 1 minute for an OTA — are
respectable for *shipping* and hopeless for *deciding*. A user working out what
they want changes their mind several times a minute, and neither number can keep
up. Worse, before this split every chat turn pushed to `master` and dispatched a
release, so a user exploring an idea was shipping each half-formed step of it to
their own users.

So the loop has two stages and two different costs:

| | Preview | Publish |
|---|---|---|
| What runs | the working tree, uncommitted | a commit on `master` |
| Who sees it | only the author | everyone with the app installed |
| Speed | seconds; fast-refresh after the first turn | ~1 min OTA / ~10 min build |
| Undo | `DELETE /v1/apps/:id/preview` | a follow-up release |

**A preview session** is a pair: a git checkout of the app's repo and a Metro
dev server serving its web target from that checkout. It is keyed by app and
held open across requests, because the thing the user is looking at is an
uncommitted working tree — it has to survive from the turn that produced it to
the turn where they accept or reject it.

Three properties do the work:

- **One session per app.** Two concurrent turns must edit the same tree. Two
  clones would mean the second push silently discarding the first's work, which
  a user experiences as "it forgot what I asked for".
- **Metro, not `expo export`.** Export rebuilds the whole bundle every turn;
  a dev server pays that once per session and then fast-refreshes. The first
  turn takes a moment, every turn after it is instant.
- **Bounded.** Each session is a customer's repo on disk plus a process, so
  sessions are capped, evicted LRU, and swept on idle. An abandoned session's
  unpublished changes are lost — they were never committed, and keeping a
  checkout alive forever because a user might come back is how the host fills up.

Publishing classifies the change set recorded at preview time rather than asking
git again, because by then the commit is what holds the diff and a fresh `git
status` would report a clean tree and classify every publish as a no-op. The
pending change is cleared only after the dispatch succeeds, so a failed dispatch
leaves the change republishable rather than committed-but-never-shipped.

### Reaching a preview from a device

A session's dev server binds to a loopback port. To reach it from a phone, each
session is published at **its own origin** — `<token>.preview.von.app` — which
the control plane proxies to that port.

An origin per session, not a path prefix, and the reason is not cosmetic. Metro
serves an index full of root-absolute references (`/index.bundle`,
`/node_modules/...`, the HMR socket); under a prefix like `/p/<token>/` every
one of them breaks, and `<base href>` does not fix root-absolute URLs. Giving a
session a whole origin makes the proxy a pure pass-through — the app is served
exactly as it would be on its own.

It gets the security boundary right for free. Separate origins mean one
customer's previewed code cannot read another's, and none of it can read the
control plane's. The subdomain label *is* the credential: 128 bits of
randomness, issued per session, dropped when the session closes, so a stale URL
stops resolving rather than landing on whatever now occupies that port. An
unknown token and an expired one get the same 404, because a distinguishable
answer confirms which tokens exist.

WebSocket upgrades are piped raw rather than re-issued through `fetch`, which
cannot express an upgrade. Without that the preview loads once and never
changes — fast refresh is the whole reason it feels instant after the first
turn.

What is left is operational, not code: `*.preview.<domain>` has to resolve to
the control plane, with a wildcard certificate. `VON_PREVIEW_HOST` turns it on;
unset, previews stay loopback-only and nothing is exposed.

---

## 14. Running it for real

### Durability is not a nice-to-have here

Provisioning is safe to retry *because* the ledger remembers what it already
created (§7). With the ledger in memory, a restart between "GCP created the
project" and "we recorded it" does not resume — it re-runs, and the re-run
creates a **second** billable project and orphans the first. Losing the app
list is annoying; losing the ledger costs money and leaves resources nobody can
find.

So the control plane's own state — apps, runtime configs, the ledger, and pool
assignments — lives in Firestore in the platform project, in a named database
kept apart from anything a customer app touches. `/healthz` reports `durable`,
and CD fails a deploy that comes up without it: a control plane silently
running in memory is a failed deploy, not a healthy one.

Pool allocation is the one place where correctness needs more than a write.
`tryAssign` reads the occupancy and takes a slot **inside a transaction**, so
two signups arriving together cannot both see 99/100 and both commit — which
would put the pool over its Firestore database quota and fail app creation for
everyone assigned to it. The seed list in `VON_POOLS` is create-if-absent for
the same reason: `used` is live state, and rewriting it from configuration on
every boot would hand the allocator a pool it believes is empty.

### The gate

Every endpoint spends money — it creates GCP projects, GitHub repositories and
EAS projects, and runs an agent against a key we pay for. Deployed without a
gate, the first thing that finds it turns the platform into someone else's free
build farm. So the control plane refuses to start without `VON_API_KEYS` once
it is configured for deployment.

Two endpoints stay open deliberately: `/healthz`, because a load balancer
cannot hold a secret, and `/v1/apps/:id/runtime-config`, which returns a
Firebase *web* config — the same values baked into every client binary, whose
access control lives in Firestore rules and the GCIP tenant (§4).

This authorises **callers, not tenants**. `tenantId` still arrives in the
request, which is honest for a platform whose only clients are its own admin
console and chat app, and insufficient the moment that stops being true.

### One instance, for now

The control plane runs at `--max-instances 1`. That is a correctness
constraint: a preview session is a checkout plus a Metro process in *this*
process's memory, so a second instance would answer a publish for a session it
does not hold. The preview runner sits behind an interface precisely so those
sessions can move to their own workers when scale demands it — at which point
the rest of the system does not change.

Operator setup is in [DEPLOY.md](DEPLOY.md).
