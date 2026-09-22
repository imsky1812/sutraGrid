# Green corridor

**Status:** approved 2026-09-22

## Goal

When an emergency vehicle is on a call, show it the fastest route and clear the
way ahead of it. It has to hold up in a pitch to traffic authorities, so the
design separates what works today from what needs their signal systems.

| Part | Status | How |
| --- | --- | --- |
| Fastest route, drawn in emergency green | Real | OSRM |
| Drivers ahead are warned to give way, with a beep | Real | Postgres trigger → `alerts` |
| Real junctions along the route | Real | OpenStreetMap `highway=traffic_signals` via Overpass |
| Those junctions turning green as the vehicle nears | **Simulated** | State in the DB, always labelled SIMULATED |

A private app has no authority over signals in India. The simulation shows what
connecting to a city's adaptive signal control would unlock; it never claims to
do it.

## Who can start one

Only a vehicle an operator has marked `is_emergency_authorized`. Drivers cannot
set that flag themselves (existing `block_emergency_escalation` trigger).

## Flow

1. The driver picks a destination and taps **Start green corridor**.
2. The app calls the `corridor` Edge Function with origin and destination. It
   returns a route densified to at most 25 m between points (so distance-to-route
   checks are meaningful), the distance and duration, and the signals within 25 m
   of the route, merged into one per junction (within 40 m of each other). If
   Overpass fails, it returns no signals and `signalsAvailable: false`. The
   corridor still starts.
3. The app calls the RPC `start_corridor(vehicle, destination, route, signals)`.
   The RPC checks ownership and authorization, ends any corridor already active
   for that vehicle, and stores the route points with their cumulative distance.
   Each signal is placed at the distance of its nearest route point.
4. On every position of that vehicle, a trigger on `vehicle_positions`:
   - finds the vehicle's progress (its nearest route point);
   - advances signals: ahead > 500 m WAITING, ≤ 500 m PREEMPT, ≤ 200 m GREEN,
     more than 30 m behind PASSED (sticky);
   - warns every other vehicle that reported in the last 2 minutes and is within
     150 m of the route between the vehicle and 1.5 km ahead of it. Each vehicle
     is warned once per corridor (`corridor_warnings`), with a CRITICAL
     `EMERGENCY` alert that expires in 5 minutes;
   - ends the corridor within 50 m of the destination.
5. `end_corridor(id)` ends it by hand. Corridors also lapse at `expires_at` (1 h).

## Data

- `corridors`: id, vehicle_id, destination, distance and duration, status
  ACTIVE/ENDED, started_at, ended_at, expires_at.
- `corridor_route_points`: corridor_id, seq, lat, lng, along_m.
- `corridor_signals`: corridor_id, seq, osm_id, lat, lng, along_m, state.
- `corridor_warnings`: (corridor_id, vehicle_id), warned_at.
- `alerts.category` gains `EMERGENCY`.

Reads follow the existing RLS rules: an operator sees all; a driver sees
corridors of their own vehicles and warnings addressed to their own vehicles.
There are no client write policies. All writes go through the security-definer
RPCs and the trigger. `corridors` and `corridor_signals` are published to
Realtime. Retention prunes ended corridors after 30 days.

The route and signals are supplied by the authorized vehicle's own client, which
is already trusted to drive with emergency privilege. A tampered client can only
misdraw its own corridor.

## Clients

- **App (emergency vehicles):** a Start button once a destination is set. While
  active: a green route, junction markers by state, a strip showing the next
  signal and its distance, and an End button.
- **App (everyone):** EMERGENCY alerts beep through the existing alert channel,
  titled "Emergency vehicle behind you".
- **Dashboard:** an active-corridors panel; the green route and coloured junction
  markers on the map; a permanent "SIMULATED: no live signal control" badge.

## Limits stated in the pitch

- OSRM's "fastest" uses road speed limits, not live traffic.
- Only drivers running SUTRA are warned.
- Signal changes are simulated until integrated with the authority's system.

## Testing

- Schema (PGlite): authorization, signal transitions, warnings ahead-only and
  once, arrival auto-end, RLS reads.
- Handler (Node): routing and signal lookup, junction merging, densifying,
  Overpass failure fallback, input validation.
- App (Jest): corridor client helpers and next-signal selection.
