# SUTRA tools

Two command-line tools that run on a laptop against the live project:

| Tool | What it does |
| --- | --- |
| `simulate.mjs` | Drives simulated vehicles around a point, so the system can be shown without one phone per vehicle |
| `import-roads.mjs` | Loads OpenStreetMap roads for an area, so wrong-way checks (and later per-road speed limits) work there |

Both sign in as a real account and go through the same rules as the app.
Nothing here bypasses row-level security.

---

## One-time setup

You need [Node.js](https://nodejs.org) 20 or newer.

**1. Install the tools' dependency.** In PowerShell:

```powershell
cd D:\PROjects\sutraGrid\tools
npm install
```

**2. Give the tools a login.** They sign in with the same email and password
as the SUTRA app and console. The account must be an **operator**: only
operators may load roads or remove simulated vehicles.

```powershell
copy .env.example .env
notepad .env
```

Fill in the two lines, then save and close:

```
SUTRA_EMAIL=your-email@gmail.com
SUTRA_PASSWORD=your-password
```

No quotes, no spaces around `=`.

> **Keep the password out of chat and out of git.** `tools/.env` is listed in
> `.gitignore`, so it is never committed. Never paste the password into a
> chat, an issue or a shell command someone else can see.

---

## Running the simulator

From the `tools` folder:

```powershell
node simulate.mjs --count 5 --speeder --for 120
```

That registers five simulated vehicles (plates `SIM 0001` to `SIM 0005`),
drives them along real roads around **your own vehicle's last reported
position**, makes `SIM 0001` exceed the speed limit, and after 120 seconds
removes all five by itself.

What you should see:

```
Centring 5 vehicle(s) on 28.62525, 77.43631.
  SIM 0001  (will exceed the limit)
  SIM 0002
  ...
Running. Press Ctrl-C to stop and remove them.
Stopping by itself after 120s.

Removing simulated vehicles…
Removed 5.
```

While it runs:

- **Console** (https://sutra-control.expo.app): five `SIM` vehicles move on the
  map; `SIM 0001` shows red over the limit, and the event log fills with
  *Speeding* and any zone crossings.
- **Phone**: open **Around me**. If your phone is within about 400 m of them,
  the simulated cars appear on the radar.
- **Alerts**: the speeding car gets an *Overspeeding* alert; a car that drives
  into one of your zones gets that zone's message. These go to the simulated
  vehicles, not to your phone.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--count N` | `4` | How many vehicles (1 to 20) |
| `--speeder` | off | Make `SIM 0001` drive 25 km/h over the limit |
| `--for SECONDS` | runs until stopped | Stop and remove the vehicles after this long |
| `--near LAT,LNG` | your vehicle's last position | Where to centre them |
| `--radius METRES` | `1200` | How far from the centre they roam |
| `--speed KMH` | `38` | Normal cruising speed |
| `--cleanup` | | Remove leftover simulated vehicles and exit |

Examples:

```powershell
# A quick demo around your phone, stopping by itself.
node simulate.mjs --count 5 --speeder --for 300

# Somewhere specific, e.g. Connaught Place, until you press Ctrl-C.
node simulate.mjs --near 28.6315,77.2167 --count 8

# Remove anything a crashed or interrupted run left behind.
node simulate.mjs --cleanup
```

### Stopping it

- With `--for`, it stops and cleans up on its own.
- Without it, press **Ctrl-C** once and wait for `Removed N.`
- If the window was closed or the laptop slept, run `node simulate.mjs --cleanup`.
  Every run also clears leftovers when it starts.

Only vehicles that are plated `SIM ...`, named `Simulated...` **and** owned by
your account are ever removed. Real vehicles cannot be deleted this way, by
design: deleting a vehicle would erase its violations, and the system must not
let anyone wipe a record.

### How realistic it is

- Routes come from OSRM, so cars follow real roads and obey one-way streets.
- Speed wanders around the target and slows for occasional hold-ups, but never
  brakes harder than an ordinary driver (2.5 m/s²). Faster than that would be
  recorded as harsh braking.
- Positions go through the same table, triggers and rules as a phone's, so
  speeding, zones, collision warnings and corridors all treat them as real
  traffic.

---

## Loading roads

Wrong-way detection only covers areas whose roads have been loaded. Run once
per area you operate in:

```powershell
node import-roads.mjs --near 28.6241,77.4356 --radius 3000
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--near LAT,LNG` | your vehicle's last position | Centre of the area |
| `--radius METRES` | `2500` | Half the width of the area (200 to 10,000) |
| `--bbox S,W,N,E` | | An exact box instead of a centre and radius |
| `--dry-run` | | Fetch and count, but write nothing (no login needed) |

It downloads from the public Overpass servers, which are often busy. The tool
splits the area into tiles, tries four servers, waits and retries a refused
tile, and saves each tile as it arrives. If it still gives up part-way, run
**the same command again**: loaded roads stay loaded and nothing is duplicated.

---

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Set SUTRA_EMAIL and SUTRA_PASSWORD…` | Create `tools/.env` (see setup) |
| `Sign-in failed: Invalid login credentials` | Check the email and password in `tools/.env` |
| `Only an operator account can remove simulated vehicles.` | Use an operator account, or ask an operator to run `--cleanup` |
| `No position to centre on yet.` | Start a shift on a phone first, or pass `--near lat,lng` |
| `Every Overpass server refused…` | Public servers are busy; wait a few minutes and run the same command again |
| `SIM 000N: Routing failed` | OSRM could not route that pair; the vehicle picks a new destination next tick |

The tools' logic is tested in `supabase/tests` (`simulator.test.mjs`,
`roads.test.mjs`, `remove_simulated.test.mjs`):

```powershell
cd ..\supabase\tests
node --test --test-concurrency=1 simulator.test.mjs roads.test.mjs remove_simulated.test.mjs
```

---

## Recorded test run

Run against the live project on **16 October 2026, 00:18 IST** (18:48 UTC on
the 15th), with the command from *Running the simulator*:

```powershell
node simulate.mjs --count 5 --speeder --for 120
```

Five vehicles were centred on the test phone's last position (28.62525,
77.43631), drove for two minutes, and were removed (`Removed 5.`). The road
data for the area had been imported beforehand (2,337 roads), and one zone
existed: a school zone drawn in the console.

| Vehicle | Positions | Top speed | What the system did |
| --- | --- | --- | --- |
| SIM 0001 (speeder) | 59 | 112 km/h | Speeding recorded; alert *Overspeeding: 105 km/h in a 80 km/h zone*. Collision warning: *a vehicle is closing ahead, about 3 s away* |
| SIM 0002 | 59 | 40 km/h | Nothing - correctly |
| SIM 0003 | 59 | 41 km/h | Nothing - correctly |
| SIM 0004 | 59 | 41 km/h | The other half of that collision warning: *closing from your right* |
| SIM 0005 | 59 | 41 km/h | Entered and left the school zone; alert *School zone: slow down, children crossing.* |

Also checked:

- **No false harsh braking** and **no false wrong-way** flags, with every car
  driving real one-way streets.
- **Clean-up**: no `SIM` vehicles left afterwards; the three real vehicles
  untouched.
- Each position update, with every check running against the imported roads,
  took about **6 ms** in the database (measured separately).

Two bugs this kind of run found, both fixed before the run above:

1. **Clean-up silently did nothing.** Vehicles deliberately have no delete
   policy, so the tool's delete matched no rows and left five cars behind. It
   now uses `remove_simulated_vehicles()`, which lets an operator remove only
   their own simulated vehicles, and it reports a failure instead of ignoring
   it.
2. **Unrealistic braking.** Hold-ups dropped speed from 38 to 4 km/h in one
   two-second step, and harsh-braking checks flagged four of five cars in the
   first minute. Speed now changes no faster than an ordinary driver would.
