# SUTRA — Real-Time Vehicle Telemetry

A three-part demo system: an Android client that streams live GPS telemetry, a
Node relay that authenticates and fans it out, and a browser dashboard that
renders the fleet on a map.

| Component | What it is |
| --- | --- |
| `apk/` | Android vehicle client — Kotlin, Jetpack Compose, foreground location service |
| `backend-mock/` | Node relay — REST login, session tokens, WebSocket fan-out (in-memory only) |
| `admin-dashboard/` | Operator dashboard — vanilla JS, Google Maps |

---

## What is real, and what is staged

This is a prototype. The telemetry pipeline is genuine; several presentation
features are illustrative placeholders. They are labelled `MOCK` in the UI and
in code comments so nothing here is mistaken for a working subsystem.

**Real:**

* GPS acquisition via `FusedLocationProviderClient`, with different accuracy and
  update rates for emergency and normal vehicles.
* WebSocket streaming with exponential-backoff reconnection.
* Server-side authentication, session-bound identity, and telemetry validation.
* Google Directions routing in the Android client, including polyline decoding.
* Local telemetry history in SQLite, with replay.
* Speed-limit violation counting and logging (local to the dashboard).

**Mocked — no real subsystem behind these:**

| Feature | What it actually does |
| --- | --- |
| "Nearest emergency services" | Fixed lat/lng offsets from the vehicle. The markers follow the vehicle around. Not a facility lookup. |
| Bypass overlay ("Optimize Global Flow") | Draws a line offset ~200 m from the route midpoint. No routing engine, no traffic data, nothing is rerouted. |
| Police dispatch payload | A JSON block generated in the browser with a random ticket number and officer name. No request is sent anywhere. |
| Green corridor / signal override | Displays the broadcast message. No traffic signal controller is contacted. |
| Connection performance gauge | A placeholder driven by vehicle count. No latency is measured. |
| Congestion detection | A single-vehicle speed threshold (`0 < speed < 15 km/h`). One car at a red light triggers it. |
| Dashboard route line | A straight line to the destination, not road geometry. |

---

## Setup

### 1. Secrets

No key is committed to this repository. Both components read local, gitignored
config files:

```bash
cp backend-mock/.env.example backend-mock/.env
cp apk/.env.example apk/.env
cp admin-dashboard/config.example.js admin-dashboard/config.js
```

Fill in each one. `EMERGENCY_CODES` in `backend-mock/.env` are the codes that
grant a client emergency-vehicle privileges; `OPERATOR_KEY` must match the value
in `admin-dashboard/config.js`.

> **Google Maps keys are not secret.** A browser key is visible to anyone who
> loads the page, and an Android key ships inside the APK. Protection comes from
> restriction, not concealment — in Google Cloud Console, restrict the browser
> key by HTTP referrer and the Android key by package name and signing SHA-1,
> and limit each to only the APIs it needs.

### 2. Backend

```bash
cd backend-mock
npm install
npm start
```

Listens on `:3000` and prints a live table of connected vehicles.

### 3. Dashboard

Serve `admin-dashboard/` over HTTP (`file://` will not work — the Maps library
and the referrer restriction both need an origin):

```bash
cd admin-dashboard
python -m http.server 8080
```

Open `http://localhost:8080`.

### 4. Android client

Open the `apk/` folder in Android Studio, let Gradle sync, then
**Build > Build Bundle(s) / APK(s) > Build APK(s)**.

Set `BACKEND_HOST` in `apk/.env` to reach your backend: `10.0.2.2:3000` from the
emulator, or your machine's LAN IP from a physical device.

---

## Authentication

Every streaming client is authenticated. There is no anonymous path into the
telemetry stream.

1. The client `POST`s to `/api/auth/login` with its driver name, vehicle ID and
   type. Requesting an emergency type requires a valid `emergencyCode`; without
   one the login is rejected with `403` rather than silently downgraded.
2. The server issues an opaque session token and records the vehicle's identity
   and privileges against it.
3. The client opens `ws://…/vehicle/stream?token=<token>`. An invalid or expired
   token is refused at the HTTP upgrade.
4. **Every identity field the dashboard displays comes from the session, not
   from the streamed frame.** A client cannot claim another vehicle's ID, rename
   its driver, or upgrade itself to emergency status by editing its own JSON.

Dashboards use a separate endpoint, `ws://…/dashboard/stream?key=<operator key>`,
and are subscribers only. Anything a dashboard sends is ignored.

### Known limitations

* Sessions are held in memory and are lost when the server restarts.
* Transport is cleartext `http://` and `ws://`, and the Android manifest sets
  `usesCleartextTraffic="true"`. This is a LAN demo, not a deployable posture —
  real use needs TLS.
* There is no rate limiting on login, and emergency codes are shared secrets
  rather than per-driver credentials.

---

## Data flow

```mermaid
sequenceDiagram
    participant App as Android Client
    participant Server as Node Relay
    participant Dash as Operator Dashboard

    App->>Server: POST /api/auth/login (name, vehicleId, type, emergencyCode?)
    Server-->>App: { success, token, isEmergency }
    Note over Server: Emergency status granted by the server, or not at all
    Dash->>Server: WS /dashboard/stream?key=<operator key>
    App->>Server: WS /vehicle/stream?token=<token>
    loop Every 1s (emergency) / 3s (normal)
        App->>Server: { lat, lng, speed, direction, ... }
        Note over Server: Validate; overwrite identity from session
        Server->>Dash: { type: "UPDATE", data }
    end
    App->>Server: close
    Server->>Dash: { type: "DISCONNECT", vehicleId }
```

---

## Repository layout note

`node_modules/` and Android `build/` output are ignored and must stay untracked.
They were committed early in this project's history; the working tree no longer
tracks them, but they remain in past commits, which is why the repository is
larger than its source.
