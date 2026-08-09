# {{APP_NAME}}

Built and maintained through [Von](https://github.com/JorgeOchoaReyes/von). You
own this repository: it is a normal Expo + Firebase monorepo with working CI,
and it runs without the platform.

## Layout

```
apps/expo/          The app. expo-router, Firebase, EAS Update.
  src/lib/config.ts   Backend config, fetched at boot (not baked in).
  src/lib/firebase.ts Firebase wired to this app's own tenant and database.
firestore.rules     Security rules, deployed by CI.
```

## How changes reach a phone

| Change | Path | Time |
|---|---|---|
| JS, assets, screens | `eas-update.yml` — OTA to installed builds | ~1 min |
| Dependencies, app config, native modules | a new EAS build | ~10 min |
| `firestore.rules` | `deploy-firestore-rules.yml` | seconds |

`master` is production. Everything merged there ships.

## Running it locally

```bash
pnpm install
pnpm --filter ./apps/expo dev
```

The app fetches its Firebase config at startup, so it needs the control plane
reachable at the `vonApiUrl` in `apps/expo/app.json`.
