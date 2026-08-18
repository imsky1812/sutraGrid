# SUTRA — Real-Time Vehicle Telemetry

A vehicle client that streams live GPS to Supabase, and an operator dashboard
that renders the fleet on a map.

| Component | What it is | Status |
| --- | --- | --- |
| `mobile/` | Expo (React Native) vehicle client | current |
| `supabase/` | Postgres schema, RLS policies, Directions Edge Function | current |
| `admin-dashboard/` | Operator dashboard, vanilla JS + Google Maps | **not yet migrated** |
| `backend-mock/` | Node WebSocket relay | superseded, kept for the dashboard |
| `apk/` | Original Kotlin/Compose client | superseded, kept for reference |

> **The operator dashboard is currently blind.** It still subscribes to the Node
> relay, which no longer receives telemetry now that the app writes to Supabase.
> Migrating it to Supabase Realtime is the next piece of work.

---

## What is real, and what is staged

The telemetry pipeline is genuine. Some presentation features in the operator
dashboard are illustrative placeholders and are labelled `MOCK` in the UI.

**Real:** GPS acquisition and background streaming, authentication with
row-level security, server-enforced emergency authorization, Google Directions
routing, speed-limit violation logging.

**Mocked (operator dashboard only):** the bypass overlay, the latency gauge, the
police dispatch payload, the green-corridor signal override, and the
single-vehicle speed threshold labelled as congestion detection. See the
dashboard UI for the specifics; each carries a badge.

---

## Security model

Emergency privilege is a database column an administrator sets. It is **not**
something a driver can claim.

- `vehicles.is_emergency_authorized` is protected by a `BEFORE UPDATE` trigger,
  because Postgres has no column-level RLS on `UPDATE`. A driver attempting to
  set it gets `P0001`.
- `vehicle_positions` has **no emergency column at all**. Status is derived by
  joining to `vehicles`, so a modified client has nothing to forge.
- Range checks on latitude, longitude, speed and heading are database
  constraints, not application code, so they cannot be bypassed.
- Routing runs through an Edge Function so the provider can be swapped without
  an app rebuild. It uses OSRM, which needs no key at all.

To authorize a vehicle, run this in the Supabase SQL editor:

```sql
update public.vehicles
   set is_emergency_authorized = true
 where vehicle_number = 'KA-03-AB-1234';
```

---

## Setup

### 1. Secrets

No key is committed. Copy the examples and fill them in:

```bash
cp mobile/.env.example        mobile/.env
cp admin-dashboard/config.example.js admin-dashboard/config.js
```

The mobile app needs exactly two values, both Supabase. **There is no maps key**
— tiles come from OpenFreeMap and routing from OSRM, neither of which requires
an account, a key, or a quota. Nothing to restrict, rotate, or leak.

`supabase/.env` is optional and holds no secret; see `supabase/.env.example`.

> The legacy `admin-dashboard/` still uses Google Maps and still needs a browser
> key in its `config.js`. That component has not been migrated.

### 2. Database

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
npx supabase functions deploy directions
npx supabase secrets set GOOGLE_DIRECTIONS_KEY=<key>
```

`link` prompts for the database password. It is not stored in the repo.

### 3. Mobile app — EAS Build (recommended)

Builds in Expo's cloud. Prefer this: the native build compiles a large amount of
React Native C++, which needs more RAM than a typical laptop has spare.

One-time setup — the first two steps are interactive and prompt for credentials:

```bash
cd mobile
npx eas login
npx eas init                     # writes the project id into app.config.ts

# Build-time env. android/ and .env are gitignored, so EAS cannot see them;
# these have to live as EAS secrets.
npx eas secret:create --name EXPO_PUBLIC_SUPABASE_URL      --value https://<ref>.supabase.co
npx eas secret:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key>
```

Then, for an installable APK:

```bash
npm run build:apk                # eas build -p android --profile preview
```

EAS runs `prebuild` itself from `app.config.ts`, so no local Android SDK, JDK or
NDK is involved. It returns a download link when the build finishes.

### 3b. Local build (fallback)

Works, but needs the Android SDK and enough free RAM:

```bash
cd mobile
npm install
npm run prebuild                 # expo prebuild + Gradle memory tuning
npm run apk                      # gradlew assembleDebug, parallelism capped
```

The APK lands at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

Two things this path needs that EAS does not:

- **Memory.** Ninja spawns one clang per core to compile the RN C++ codegen. On
  a machine with little free RAM this fails with `LLVM ERROR: out of memory`,
  which surfaces as an opaque Gradle task failure. `npm run apk` caps this via
  `CMAKE_BUILD_PARALLEL_LEVEL`; note that `org.gradle.workers.max` does *not*
  reach ninja's parallelism.
- **A physical device.** The local build is pinned to `arm64-v8a` to halve the
  native work, so the APK will not install on an x86_64 emulator. Add `x86_64`
  to `reactNativeArchitectures` in `scripts/tune-gradle.mjs` if you need one.

No map key is needed at any point: tiles come from OpenFreeMap and routing from
OSRM.

### 4. Operator dashboard (legacy path)

```bash
cd backend-mock && npm install && npm start
cd admin-dashboard && python -m http.server 8080
```

---

## Testing

```bash
cd mobile          && npm test && npm run typecheck   # 45 tests
cd supabase/tests  && npm install && npm test         # 30 tests
```

Schema and RLS tests run against **PGlite** — Postgres compiled to WASM, in
process — so no Docker daemon or hosted database is needed. The `auth` schema is
a stub matching Supabase's shape, so these verify policy logic rather than
Supabase's own runtime; `db push` against the hosted project is where that gets
confirmed.

The test runner is pinned to `--test-concurrency=1`: each test boots its own
WASM Postgres, and running files in parallel exhausts memory.

---

## Design

The app is dark-only with a single acid-lime accent. The accent marks the live
thing — the route on the map, the active nav item, the primary action — and
nothing decorative uses it.

Icon, adaptive icon layers, splash mark and favicon are generated from code:

```bash
cd mobile && npm run generate-assets
```

Editing `scripts/generate-assets.mjs` regenerates all six.

---

## Data flow

```mermaid
sequenceDiagram
    participant App as Expo Client
    participant SB as Supabase
    participant Dash as Operator Dashboard

    App->>SB: signInWithPassword
    SB-->>App: session
    App->>SB: select vehicles (RLS: own only)
    Note over App: expo-location background task starts
    loop Every 1s (emergency) / 3s (normal)
        App->>SB: upsert vehicle_positions
        Note over SB: constraints validate; RLS checks ownership
    end
    SB-->>Dash: Realtime postgres_changes (once migrated)
```

---

## Known limitations

- Transport for the legacy dashboard is cleartext `ws://`; the Expo client uses
  HTTPS to Supabase.
- Sessions in the retired Node relay were in-memory. Supabase sessions persist.
- There is no rate limiting on sign-in beyond Supabase's own defaults.
- `node_modules/` and Android `build/` output are ignored and must stay
  untracked. They were committed early in this project's history, which is why
  the repository is larger than its source.
