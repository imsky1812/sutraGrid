# SUTRA Expo Vehicle Client — Design

**Date:** 2026-08-18
**Status:** Approved for planning
**Supersedes:** the Kotlin/Compose client in `apk/` (kept for reference until the Expo app is proven on a device)

---

## 1. Goal

Replace the Kotlin vehicle client with an Expo (React Native) app, backed by
Supabase instead of the in-memory Node relay, and produce a working debug APK.

Scope is **core telemetry + routing**: login, live map, destination routing,
emergency broadcast, background streaming, and a preset simulation loop for
demos. Trip-history recording and the route/history replay simulation modes
from the Kotlin app are deliberately out of scope.

### Why a rewrite

The user chose this after being shown that the local Android toolchain works
(JDK 21, SDK platforms 34-36.1, Gradle 9.3.1 cached) and that a Kotlin build was
therefore viable. The trade-off was stated and accepted: the existing foreground
service, `FusedLocationProviderClient` tuning and OkHttp reconnect logic are
discarded and rebuilt on Expo equivalents.

---

## 2. Repository layout

```
mobile/            NEW  Expo app
supabase/          NEW  SQL migrations, RLS policies, one Edge Function
admin-dashboard/        unchanged this phase (still on the Node relay)
backend-mock/           retained, no longer used by the app
apk/                    retained for reference; removed once Expo is proven
docs/superpowers/specs/ this document
```

### Known breakage

Once the app streams to Supabase, **the admin dashboard goes blind.** It
subscribes to `ws://…/dashboard/stream` on the Node relay, which will no longer
receive telemetry. Migrating the dashboard to Supabase Realtime is a separate,
subsequent piece of work. This is expected and accepted, not a defect.

---

## 3. Data model

```sql
create table vehicles (
  id                      uuid primary key default gen_random_uuid(),
  owner                   uuid not null references auth.users (id) on delete cascade,
  vehicle_number          text not null unique,
  driver_name             text not null,
  vehicle_type            text not null default 'NORMAL'
                            check (vehicle_type in ('NORMAL','AMBULANCE','POLICE','FIRE')),
  is_emergency_authorized boolean not null default false,
  created_at              timestamptz not null default now()
);

create table vehicle_positions (
  vehicle_id       uuid primary key references vehicles (id) on delete cascade,
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  speed            real not null default 0 check (speed >= 0 and speed <= 500),
  heading          real not null default 0 check (heading >= 0 and heading <= 360),
  destination_lat  double precision,
  destination_lng  double precision,
  destination_name text,
  alert_message    text,
  updated_at       timestamptz not null default now()
);
```

One row per vehicle in `vehicle_positions`, upserted. Range checks live in the
database so the validation cannot be bypassed by a client, replacing the
`validateTelemetry()` function in the Node relay.

### Emergency privilege

`is_emergency_authorized` is set by an administrator and **cannot be written by
the driver.** This replaces the `EMERGENCY_CODES` shared-secret scheme in the
Node relay, where any driver who learned the code could self-declare as an
ambulance. The privilege is now data, enforced by the database.

### RLS policies

| Table | Policy |
| --- | --- |
| `vehicles` | select/insert/update where `owner = auth.uid()` |
| `vehicles` | update **excludes** `is_emergency_authorized` (enforced by trigger, see below) |
| `vehicle_positions` | insert/update where the vehicle's `owner = auth.uid()` |
| `vehicle_positions` | select granted to an `operator` role |

Postgres has no column-level RLS on `UPDATE`, so a `BEFORE UPDATE` trigger
raises if a non-service role attempts to change `is_emergency_authorized`.
This is the security-critical assertion in the test suite.

The `operator` read policy is created in this phase but has no consumer until
the dashboard is migrated. It is included now so the schema is complete and the
policy is covered by tests, not because anything reads through it yet.

**The client never sends an emergency flag at all** — there is no such column in
`vehicle_positions`. Emergency status is derived by joining to
`vehicles.is_emergency_authorized`, so a modified client has nothing to lie
about. This is a deliberate improvement on the Node relay, where the client sent
`isEmergency` in every frame and the server had to overwrite it.

---

## 4. Telemetry path

The app upserts into `vehicle_positions` at the location-update cadence:
**1 s when the vehicle is emergency-authorized, 3 s otherwise** — matching the
battery trade-off already tuned in the Kotlin client.

The dashboard (next phase) subscribes via Realtime Postgres Changes. Persistence
and late-joiner replay come free, so the Node relay's "push current state to
newly connected dashboards" logic has no equivalent and is simply dropped.

**Deliberately not built:** a Realtime Broadcast hot path. At one write per
vehicle per second, a demo fleet is comfortably within Postgres capacity. If
write volume becomes a real constraint, the live path moves to Broadcast with a
throttled upsert for durability. Building that now would be speculative.

---

## 5. Application structure

Expo Router, file-based:

```
mobile/app/
  _layout.tsx        session provider, auth gate
  login.tsx          Supabase email/password
  vehicle-setup.tsx  pick or register a vehicle
  dashboard.tsx      map + bottom sheet controls
mobile/src/
  supabase.ts        client, session persisted via expo-secure-store
  telemetry.ts       background task definition + start/stop
  directions.ts      calls the Edge Function, decodes the polyline
  polyline.ts        ported verbatim from the Kotlin PolylineDecoder
```

### Key packages

| Package | Purpose |
| --- | --- |
| `expo-location` | foreground + background updates, `foregroundService` notification |
| `expo-task-manager` | background task registration |
| `react-native-maps` | Google Maps |
| `@supabase/supabase-js` | auth, Postgres, Realtime |
| `expo-secure-store` | session storage |
| `@gorhom/bottom-sheet` | dashboard controls |

`expo-location`'s `startLocationUpdatesAsync({ foregroundService: {...} })` is
the direct equivalent of the Kotlin foreground service and produces the same
persistent notification. This requires a **dev build**; Expo Go cannot do
background location or Google Maps.

### Login UX change

Login becomes email + password rather than typing a driver name. This is the
cost of real authentication and was accepted. If the friction proves too high on
a demo device, Supabase anonymous sign-in would preserve the "just type a vehicle
number" flow while still yielding a real `auth.uid()` for RLS — noted as a
future option, not built now.

---

## 6. Directions and API keys

The Maps SDK key must ship inside the APK; it is restricted by package name and
signing fingerprint, which is the only available protection.

The **Directions** key does not need to ship. A Supabase Edge Function
(`directions`) proxies the call, keeping that key server-side:

```
app → POST /functions/v1/directions { origin, destination }
    → Google Directions API (key from Edge Function env)
    → { polyline: string }
```

The app decodes the polyline locally using the ported decoder. This closes the
third instance of client-side key exposure found in this project.

---

## 7. Build path

No EAS account required, because the local SDK is present:

```bash
cd mobile
npx expo prebuild --platform android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

`mobile/android/` and `mobile/ios/` are generated output and must be gitignored,
along with `mobile/node_modules/`. This project has already been burned once by
committing `node_modules/` and `app/build/`; those ignore rules go in before the
first build, not after.

---

## 8. Testing

| Layer | Method | Runnable here |
| --- | --- | --- |
| Polyline decoder | Jest, against known Google fixtures | yes |
| Telemetry payload shaping | Jest | yes |
| RLS policies | SQL against a local Supabase stack | yes |
| Directions Edge Function | Deno test, mocked upstream | yes |
| App on device | manual | **no — user runs it** |

The security-critical test: a driver session attempting to set
`is_emergency_authorized = true` on its own vehicle must fail.

---

## 9. Prerequisites from the user

1. **A Supabase project.** The user must create it; account creation and
   credential entry are outside what the assistant may do. Needed: project URL
   and `anon` key (publishable by design, safe to share).
2. **A Google Maps Android key** restricted to the new package name.
3. **A Google Directions key** for the Edge Function environment.

Work that does not depend on these — scaffolding, schema, RLS, decoder, tests —
proceeds without them.

---

## 10. Decisions taken by default

The user approved the design without selecting on two points, so these are
defaulted and recorded here rather than left open:

- **Package name: `com.sutra.vehicle`**, matching the Kotlin app, so an existing
  restricted Maps key can be reused rather than provisioned again.
- **`apk/` is retained** until the Expo app is confirmed working on a device. It
  is the only working reference for the foreground-service behaviour being
  reimplemented. Deleting it afterwards is a one-line change.
- **Login is email/password**, as designed in section 5.

Any of these can be reversed cheaply; none blocks implementation.
