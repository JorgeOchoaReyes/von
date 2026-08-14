# Handoff

Enough context to pick this up cold. Read this, then
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the reasoning behind the shape.

## What Von is

Describe an app in a chat; it gets built, deployed, and iterated for you, mobile
included. Expo + Firebase + EAS + GitHub Actions, driven from conversation, for
many apps at once.

## Where it stands

Everything below is merged to `master`. 262 tests, 10 packages typecheck clean,
both UIs build.

**Nothing has ever run against a live GCP, GitHub, Expo or Play account.** Every
driver is unit-tested against fakes. That is the single most important fact
about the current state: the code is complete and coherent, and unproven.

Also unverified:

- The `FROM node:22-slim` pull in both Dockerfiles. Everything *else* in both
  images is verified — the partial-workspace `--frozen-lockfile` install, the
  API booting and serving, the Next standalone runtime rendering live data and
  serving its CSS — by reconstructing each image's exact file set on disk.
- CD past its third step. It ran on the merge and failed at
  `google-github-actions/auth@v2` with no deploy secrets configured; checkout
  succeeded, everything after was skipped. Correct behaviour, and the rest of
  the workflow is still untested.

## Running it

Node 22+ and pnpm. Every package runs TypeScript directly under
`--experimental-strip-types` — **there is no build step**, and every relative
import carries an explicit `.ts` extension.

```bash
pnpm install
pnpm typecheck
pnpm test

pnpm configure           # staged credential walkthrough, writes .env
pnpm configure --check   # what is set, and whether the providers accept it

set -a && . ./.env && set +a
pnpm --filter @von/api dev        # control plane, :8787
pnpm --filter @von/admin dev      # console, :3000
pnpm --filter @von/chat  dev      # Expo chat client
```

Two endpoints answer "can this work yet":

- `GET /v1/readiness` — which variables are set, and what each gap blocks. No
  network calls.
- `GET /v1/preflight` — whether each provider *accepts* its credential.
  Read-only; reports the GitHub login, the Google identity, the Expo account
  name, because a credential that authenticates and belongs to the wrong
  account is the failure no boolean shows you.

## Layout

```
apps/api      Hono control plane. update.ts is the one path that makes and
              updates apps — chat, REST and fleet all funnel through it.
apps/admin    Next.js console (server actions; the API key never reaches the browser)
apps/chat     Expo chat client
packages/core          domain types, ids, resource ledger
packages/provisioning  Google/GitHub/EAS drivers, genesis plan, google-auth
packages/release       OTA-vs-native classifier, ship, rollback, health
packages/agent         the agent that edits a generated app's repo, GitWorkspace
packages/preview       preview sessions (checkout + Metro per app)
packages/store         Firestore persistence, pool allocation
packages/generator     blueprint -> per-app repo
templates/app-blueprint  the Expo+Firebase monorepo every app is generated from
```

## Invariants — break these and it fails silently

Each of these was a real bug. They share a shape: nothing errors, and the damage
shows up on someone's phone.

1. **The runtime version lives in `app.json`, not in the database.** The
   blueprint sets `runtimeVersion: { policy: "appVersion" }`, so a bump recorded
   only on the `App` record moves nothing. `publishChange` decides *before*
   committing so the bump lands in the same commit. That fence is what keeps a
   bundle referencing a new native module off the binary that lacks it.

2. **An OTA update reaches an installed build; it cannot install one.** The
   classifier is asked two questions — does this change the binary, and *is
   there* a binary — and `decideRelease` escalates to a build when no finished
   binary exists at the app's runtime version. Use `decideRelease`, never
   `classifyChange` directly, anywhere a user is told what publishing will cost.

3. **Workflow names in `packages/release` must exist in the blueprint.** GitHub
   answers a dispatch for a missing workflow with a 404. `apps/api/test/workflows.test.ts`
   is the guard; add a workflow constant, add the file.

4. **`firebase.json` names the database.** A pooled app's data lives in its own
   named database inside a shared project; rules deployed to `(default)` govern
   nothing it owns and trample every other pooled app's.

5. **Ledger keys must include everything the step's output depends on.** Keyed
   on the app id alone, promotion short-circuits the dedicated database and
   hydration keeps deploying to the pool project.

6. **`PROD_BRANCH` is `master` everywhere**, including the blueprint repo's
   default branch — generate-from-template copies it, and every generated
   workflow triggers on `master`.

7. **A generated repo gets its own `releaseToken`, never the platform API key.**
   One customer's CI must not be able to act on another's app.

8. **A store release's artifact is an `.aab`.** It is excluded from the install
   link; handing one to a person gives them a file their phone will not open.

## Conventions

- Comments explain *why*, especially the failure a piece of code prevents. The
  codebase is written to be picked up cold; match that.
- Commit messages: what changed, and what would break without it.
- Tests name the bug they prevent, not the function they call.
- Provisioning is idempotent and resumable via the resource ledger. Anything
  that creates an external resource writes a ledger record before and after.

## Next steps

1. **Stage 1 credentials** (`ANTHROPIC_API_KEY`, `GITHUB_INSTALLATION_TOKEN`),
   then create an app with `repoFullName` set to a repo you own and drive one
   real turn: chat -> agent edits -> preview -> publish. First honest evidence
   the product works. The preview session (clone, install, Metro boot) is the
   likeliest place for the first surprise.

2. **Stage 2** — push `templates/app-blueprint/` to its own repo, default branch
   `master`, marked a template; then the Google and Expo credentials. Creating
   an app *without* `repoFullName` is the first time seven drivers touch live
   APIs. Expect it to fail partway; the ledger makes it resumable.

3. **Deploy** — Workload Identity Federation plus the four repository secrets in
   [`DEPLOY.md`](DEPLOY.md), and CD gets past its third step.

### Worth building, roughly in order

- **A genesis progress stream in the console.** When provisioning fails partway
  the only visibility is server logs plus the ledger table after the fact. Step
  2 will fail somewhere on the first attempt; this is the difference between
  minutes and log archaeology.
- **Per-user identity.** The API key authorises *callers*, not tenants —
  `tenantId` still arrives in the request body. Fine for one operator, not for
  real users.
- **Horizontal scale.** Preview sessions live in the control plane's memory, so
  it runs at one instance. The runner is behind an interface for exactly this.
- **Wildcard DNS for `VON_PREVIEW_HOST`.** The proxy is built; without
  `*.preview.<domain>` pointed at the control plane, previews are loopback-only.
- **Zero-loss promotion.** The Firestore export is a live snapshot, so writes
  during cutover can be lost. Freezing writes for the window is the missing
  piece.
- **iOS.** Needs an Apple developer account, and EAS wants it interactively at
  least once, so it is not something the platform can do unattended yet.
  TestFlight waits on the same thing.
