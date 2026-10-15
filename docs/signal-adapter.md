# SUTRA signal-adapter interface

How a city's traffic-signal control system connects to SUTRA's green
corridors. Version 1.

## Why this exists

When an authorized ambulance opens a green corridor, SUTRA works out the route
and the signalized junctions on it, warns SUTRA drivers ahead to give way, and
tracks the vehicle's progress. What it **cannot** do is change a traffic
light. That authority belongs to the city's adaptive traffic control system
(ATCS) and the traffic police, and that is as it should be.

So today the junction states shown in the app and console are **simulated**.
This interface is the join: it defines exactly what SUTRA would ask of a
city's controller, and SUTRA already produces those requests for every
corridor. Connecting a real controller is a configuration change on SUTRA's
side and an implementation of this contract on the city's.

## Principles

1. **SUTRA requests; the city decides.** Every message is a request. The
   controller may refuse any of them - manual control, a fault, a conflicting
   pre-emption - and SUTRA records the refusal and its reason.
2. **A junction is never left held.** SUTRA sends `RELEASE` when the vehicle
   has passed, and for every junction still held when a corridor ends: on
   arrival, when the driver ends it, after an hour, or **two minutes after the
   vehicle stops reporting** (a phone that dies must not leave a junction held). Independently, every request
   carries `max_hold_seconds`; the controller **must** return the junction to
   normal operation by itself if no `RELEASE` arrives in that time, because
   SUTRA, a phone network or the link between them can fail.
3. **Off until switched on.** In the default `simulation` mode SUTRA records
   each request with status `SIMULATED` and sends nothing. Nothing reaches a
   city system until an authority configures an endpoint and turns it on.
4. **Everything is on record.** Every request, its timing, and the city's
   answer are stored in `signal_commands` and visible in the operator console
   alongside the corridor.

## The three requests

| Command | Sent when | Asks the controller to |
| --- | --- | --- |
| `PREEMPT` | The vehicle is within about 500 m of the junction | Start clearing the junction for its approach: end conflicting phases safely and prepare a green |
| `HOLD_GREEN` | Within about 200 m | Hold green on the vehicle's approach |
| `RELEASE` | The vehicle has passed (30 m beyond), or the corridor has ended | Return the junction to normal operation |

The distances are SUTRA's current corridor thresholds and can be agreed with
the city per junction class.

## Transport

- `HTTPS POST` to an endpoint the city provides, one request per command.
- `Content-Type: application/json`.
- Each request is signed. The city verifies before acting:

  ```
  X-SUTRA-Timestamp: 1792090000
  X-SUTRA-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
  ```

  using a secret shared out of band. Requests whose timestamp is more than five
  minutes from the controller's clock should be refused, so a captured request
  cannot be replayed.
- SUTRA waits up to 5 seconds for an answer and does not retry a command: a
  late pre-emption is worse than none. The next state change produces the next
  command.

## Request body

```json
{
  "version": 1,
  "command_id": 4211,
  "command": "PREEMPT",
  "issued_at": "2026-10-16T09:00:12.481Z",
  "junction": { "osm_id": 2201837719, "lat": 28.62681, "lng": 77.43852 },
  "approach_bearing_deg": 172,
  "eta_seconds": 38,
  "vehicle_type": "AMBULANCE",
  "corridor_id": "7d1c2a10-5be4-4f0e-9a51-0c3f6b8e2d44",
  "max_hold_seconds": 120
}
```

| Field | Meaning |
| --- | --- |
| `command_id` | Unique per request; quote it in logs and support calls |
| `junction.osm_id` | The OpenStreetMap node for the signal. A city will normally map this to its own junction ID once, when integrating |
| `approach_bearing_deg` | Compass direction the vehicle is travelling (0 = north), so the controller knows which approach to give green |
| `eta_seconds` | Estimated seconds to arrival when the request was made; `null` for `HOLD_GREEN` and `RELEASE` |
| `vehicle_type` | `AMBULANCE`, `POLICE` or `FIRE`; a city may prioritise by type |
| `max_hold_seconds` | Upper bound on any hold; revert unaided after this |

## Response

HTTP 200 with:

```json
{ "status": "ACKNOWLEDGED", "controller_ref": "JN-118/PE-5521" }
```

or

```json
{ "status": "REJECTED", "reason": "Junction under manual control." }
```

Anything else - a non-200, a timeout, a 200 without a `status` - is recorded
by SUTRA as `FAILED`. A `RELEASE` should always be acknowledged: returning a
junction to normal is always safe.

## Turning it on

On SUTRA's side, by the project's administrators:

```bash
npx supabase secrets set SIGNAL_ADAPTER_URL=https://atcs.example.gov.in/sutra \
                         SIGNAL_ADAPTER_SECRET=<shared secret>
npx supabase functions deploy signal-dispatch
```

then set the mode:

```sql
update public.settings set value = '"http"' where key = 'signal_adapter_mode';
```

Setting it back to `"simulation"` stops all sending immediately.

## Trying it without a city

`tools/mock-signal-adapter.mjs` is a reference implementation of the city's
side. It verifies signatures, refuses stale requests, answers, and logs what it
would do - it changes no lights:

```bash
SIGNAL_ADAPTER_SECRET=test-secret node tools/mock-signal-adapter.mjs
# REJECT_OSM_IDS=2201837719 to see a refusal handled
```

The dispatch function is tested against it end to end, signature included
(`supabase/tests/signal_dispatch.test.mjs`).

## What this does not cover

- **Live traffic.** Routes are fastest by posted speed, not by current
  congestion. A city's ATCS usually has detector data that would improve both
  routing and timing; that would be a second interface.
- **Vehicles that are not running SUTRA** are not warned. Signal pre-emption
  helps them indirectly, by clearing the junction.
- **Legal authority.** This document describes a technical interface. Whether
  and how a city connects it is the city's and the traffic police's decision.
