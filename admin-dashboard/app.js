// SUTRA control console.
//
// One interface for both roles. What differs is scope, not layout: row-level
// security decides whether the fleet list holds every vehicle or only your own,
// and the same account signs in here and in the mobile app.
//
// Operators additionally get the alert composer. That is the single
// role-conditional piece of UI in this file.
//
// Rendering rule: telemetry and alert text are untrusted input. Nothing from a
// payload is ever concatenated into HTML or an inline attribute.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import maplibregl from 'https://esm.sh/maplibre-gl@5.6.1';
import { formatDuration, positionAt } from './replay-math.js';

const CONFIG = window.SUTRA_CONFIG || {};
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const STALE_AFTER_MS = 30_000;
const MAX_LOG_ITEMS = 150;
/** Safety net: how often the live positions are re-read regardless of Realtime. */
const RECONCILE_MS = 15_000;
const REJOIN_BASE_MS = 2_000;
const REJOIN_MAX_MS = 30_000;
const HISTORY_DAYS = 7;

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const TYPE_GLYPH = { NORMAL: '\u{1F697}', AMBULANCE: '\u{1F691}', POLICE: '\u{1F693}', FIRE: '\u{1F692}' };

const state = {
  isOperator: false,
  speedLimit: 80,
  fleet: new Map(), // vehicle_id -> { position, vehicle, marker }
  violations: 0,
  filter: 'all',
  sort: 'plate',
  query: '',
  selectedId: null,
  map: null,
  historyLayerIds: [],
  hasFramedFleet: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = String(props.text);
  if (props.type) node.type = props.type;
  if (props.placeholder) node.placeholder = props.placeholder;
  if (props.href) node.href = props.href;
  if (props.style) Object.assign(node.style, props.style);
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

const num = (v, f = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : f);
const plate = (entry) => entry.vehicle?.vehicle_number ?? '—';
const glyph = (entry) => TYPE_GLYPH[entry.vehicle?.vehicle_type] ?? TYPE_GLYPH.NORMAL;
const isStale = (entry) => Date.now() - new Date(entry.position.updated_at).getTime() > STALE_AFTER_MS;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function gateError(message) {
  const node = $('gate-error');
  node.textContent = message;
  node.hidden = false;
}

/** RLS makes this row visible only to the caller, so an empty result means
 *  "not an operator" rather than "no operators exist". */
async function checkOperator() {
  const { data, error } = await supabase.from('operators').select('user_id').limit(1);
  return !error && (data ?? []).length > 0;
}

let consoleStarted = false;

async function enterConsole() {
  // A stored session starts the console on load, and signing in starts it
  // again. The second run reused the already-subscribed Realtime channel, which
  // rejects handlers added after subscribe().
  if (consoleStarted) {
    $('gate').hidden = true;
    $('console').hidden = false;
    return;
  }
  consoleStarted = true;

  state.isOperator = await checkOperator();

  const { data: limitRow } = await supabase
    .from('settings').select('value').eq('key', 'speed_limit_kmh').maybeSingle();
  if (limitRow) state.speedLimit = Number(limitRow.value) || 80;

  $('gate').hidden = true;
  $('console').hidden = false;
  $('events-label').textContent = state.isOperator ? 'Fleet events' : 'My events';
  $('open-vehicles').hidden = !state.isOperator;
  await startConsole();
}

$('gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('gate-error').hidden = true;
  const button = $('gate-submit');
  button.disabled = true;
  button.textContent = 'Signing in…';

  const credentials = readCredentials();
  if (!credentials) {
    button.disabled = false;
    button.textContent = 'Sign in';
    return;
  }

  try {
    const { error } = await supabase.auth.signInWithPassword(credentials);
    if (error) gateError(error.message);
    else await enterConsole();
  } catch (e) {
    // Anything thrown past this point used to hang the button on "Signing in".
    consoleStarted = false;
    console.error('[sutra] sign-in failed', e);
    gateError(`Signed in, but the console failed to start: ${e?.message ?? e}`);
    $('gate').hidden = false;
    $('console').hidden = true;
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

/** Both paths need the same check, so it lives in one place. */
function readCredentials() {
  const email = $('email').value.trim();
  const password = $('password').value;

  // Supabase reads signUp with empty fields as an anonymous sign-in, and
  // reports "Anonymous sign-ins are disabled" - which says nothing about the
  // actual problem, that the form is blank.
  if (!email) {
    gateError('Enter your email address.');
    return null;
  }
  if (password.length < 6) {
    gateError('Enter a password of at least 6 characters.');
    return null;
  }
  return { email, password };
}

$('gate-signup').addEventListener('click', async () => {
  $('gate-error').hidden = true;
  const credentials = readCredentials();
  if (!credentials) return;

  const button = $('gate-signup');
  button.disabled = true;
  button.textContent = 'Creating…';

  const { data, error } = await supabase.auth.signUp(credentials);

  button.disabled = false;
  button.textContent = 'Create an account';

  if (error) {
    // Supabase deliberately blurs whether an address is already registered.
    return gateError(
      /already|registered/i.test(error.message)
        ? 'That address already has an account. Use Sign in instead.'
        : error.message,
    );
  }

  // With email confirmation on, signUp returns a user but no session.
  if (!data.session) {
    return gateError('Account created. Confirm the link we emailed you, then sign in.');
  }
  await enterConsole();
});

$('gate-reset').addEventListener('click', async () => {
  $('gate-error').hidden = true;
  const email = $('email').value.trim();
  if (!email) return gateError('Enter your email address first, then press this.');

  const button = $('gate-reset');
  button.disabled = true;
  button.textContent = 'Sending…';

  // The link returns here, where the recovery session is picked up below.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });

  button.disabled = false;
  button.textContent = 'Forgot your password?';

  // Whether the address exists is not disclosed, so the message is the same
  // either way.
  gateError(error ? error.message : 'If that address has an account, a reset link is on its way.');
});

/**
 * Supabase returns from a reset link with a recovery session already active, so
 * the only thing left is to collect a new password.
 */
supabase.auth.onAuthStateChange(async (event, session) => {
  // Realtime authorizes each row against the token it holds. Without this it
  // keeps the one from sign-in, which expires after an hour - and then the
  // socket stays open while postgres_changes quietly stop arriving.
  if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session?.access_token) {
    try {
      await supabase.realtime.setAuth(session.access_token);
    } catch (e) {
      console.warn('[sutra] could not refresh realtime auth', e);
    }
  }

  if (event !== 'PASSWORD_RECOVERY') return;

  const next = window.prompt('Enter a new password (at least 6 characters)');
  if (!next || next.length < 6) {
    gateError('Password not changed. It must be at least 6 characters.');
    return;
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) return gateError(error.message);

  gateError('Password updated. Signing you in…');
  await enterConsole();
});

$('sign-out').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.reload();
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap() {
  if (!maplibregl?.Map) {
    throw new Error('Map library failed to load. Check the network tab for esm.sh.');
  }
  state.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [77.5946, 12.9716],
    zoom: 11,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
}

function markerElement(entry) {
  const wrap = el('div', { className: 'marker' });
  wrap.appendChild(el('div', { className: 'marker-avatar', text: glyph(entry) }));
  wrap.appendChild(el('span', { className: 'marker-badge', text: plate(entry) }));
  wrap.addEventListener('click', () => selectVehicle(entry.position.vehicle_id));
  return wrap;
}

function refreshMarker(entry) {
  if (!state.map) return;
  const lngLat = [entry.position.lng, entry.position.lat];
  if (!entry.marker) {
    entry.marker = new maplibregl.Marker({ element: markerElement(entry) })
      .setLngLat(lngLat)
      .addTo(state.map);
  } else {
    entry.marker.setLngLat(lngLat);
  }

  const root = entry.marker.getElement();
  root.classList.toggle('emergency', !!entry.vehicle?.is_emergency_authorized);
  root.classList.toggle('selected', state.selectedId === entry.position.vehicle_id);

  const badge = root.querySelector('.marker-badge');
  const speed = num(entry.position.speed);
  const stale = isStale(entry);
  badge.textContent = stale ? `${plate(entry)} · offline` : `${plate(entry)} · ${speed.toFixed(0)} km/h`;
  badge.classList.toggle('over', !stale && speed > state.speedLimit);
  root.classList.toggle('stale', stale);

  const avatar = root.querySelector('.marker-avatar');
  if (avatar.textContent !== glyph(entry)) avatar.textContent = glyph(entry);
}

function selectVehicle(vehicleId) {
  state.selectedId = vehicleId;
  const entry = state.fleet.get(vehicleId);
  if (entry && state.map) {
    state.map.easeTo({ center: [entry.position.lng, entry.position.lat], zoom: 15, duration: 600 });
  }
  state.fleet.forEach(refreshMarker);
  renderFleet();
  renderDetail();
}

$('fit-all').addEventListener('click', () => {
  const entries = [...state.fleet.values()];
  if (entries.length === 0 || !state.map) return;
  const first = [entries[0].position.lng, entries[0].position.lat];
  const bounds = entries.reduce(
    (b, e) => b.extend([e.position.lng, e.position.lat]),
    new maplibregl.LngLatBounds(first, first),
  );
  state.map.fitBounds(bounds, { padding: 120, maxZoom: 15, duration: 700 });
});

/** Draw a vehicle's recent track. Reuses one source id so switching vehicles
 *  replaces the trail rather than stacking layers. */
function drawTrack(points) {
  if (!state.map) return;
  const SRC = 'track';
  const coords = points.map((p) => [p.lng, p.lat]);

  if (state.map.getLayer('track-line')) state.map.removeLayer('track-line');
  if (state.map.getSource(SRC)) state.map.removeSource(SRC);
  if (coords.length < 2) return;

  state.map.addSource(SRC, {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
  });
  state.map.addLayer({
    id: 'track-line',
    type: 'line',
    source: SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#D7F94A', 'line-width': 4, 'line-opacity': 0.9 },
  });
  state.map.fitBounds(
    coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0])),
    { padding: 100, maxZoom: 16, duration: 700 },
  );
}

// ---------------------------------------------------------------------------
// Fleet list
// ---------------------------------------------------------------------------

function visibleFleet() {
  const query = state.query.trim().toLowerCase();
  let rows = [...state.fleet.values()];

  if (state.filter === 'emergency') rows = rows.filter((e) => e.vehicle?.is_emergency_authorized);
  if (state.filter === 'speeding') rows = rows.filter((e) => num(e.position.speed) > state.speedLimit);

  if (query) {
    rows = rows.filter((e) =>
      `${e.vehicle?.vehicle_number ?? ''} ${e.vehicle?.driver_name ?? ''}`.toLowerCase().includes(query),
    );
  }

  rows.sort((a, b) =>
    state.sort === 'speed'
      ? num(b.position.speed) - num(a.position.speed)
      : plate(a).localeCompare(plate(b)),
  );
  return rows;
}

function renderFleet() {
  const list = $('vehicle-list');
  clear(list);

  const rows = visibleFleet();
  $('fleet-count').textContent = `${state.fleet.size} vehicle${state.fleet.size === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    list.appendChild(
      el('p', {
        className: 'muted empty',
        text: state.fleet.size === 0
          ? (state.isOperator
              ? 'No vehicles streaming. Start a shift in the mobile app.'
              : 'No vehicles yet. Register one in the mobile app and start a shift.')
          : 'Nothing matches that filter.',
      }),
    );
    return;
  }

  rows.forEach((entry) => {
    const speed = num(entry.position.speed);
    const over = speed > state.speedLimit;
    const stale = isStale(entry);

    const row = el('div', {
      className: 'row' + (state.selectedId === entry.position.vehicle_id ? ' selected' : ''),
    });
    row.addEventListener('click', () => selectVehicle(entry.position.vehicle_id));

    row.appendChild(
      el('div', {
        className: 'avatar' + (entry.vehicle?.is_emergency_authorized ? ' emergency' : ''),
        text: glyph(entry),
      }),
    );

    const meta = el('div', { className: 'row-meta' }, [
      el('span', {
        className: stale ? 'stale' : over ? 'over' : 'live',
        text: stale ? 'Offline' : `${speed.toFixed(0)} km/h`,
      }),
      el('span', { text: '·' }),
      el('span', { text: entry.vehicle?.driver_name ?? 'Unknown driver' }),
    ]);

    row.appendChild(
      el('div', { className: 'row-body' }, [
        el('div', { className: 'row-title', text: plate(entry) }),
        meta,
      ]),
    );

    list.appendChild(row);
  });
}

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderFleet();
});

function wireChips(containerId, key, onChange) {
  $(containerId).addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    state[key] = button.dataset[key === 'filter' ? 'filter' : 'sort'];
    [...$(containerId).children].forEach((c) => c.classList.toggle('active', c === button));
    onChange();
  });
}
wireChips('filter-chips', 'filter', renderFleet);
wireChips('sort-chips', 'sort', renderFleet);

// ---------------------------------------------------------------------------
// Detail card
// ---------------------------------------------------------------------------

function stat(label, value, over) {
  return el('div', { className: 'stat' }, [
    el('b', { text: value, className: over ? 'over' : '' }),
    el('small', { text: label }),
  ]);
}

function renderDetail() {
  const card = $('detail');
  const entry = state.selectedId ? state.fleet.get(state.selectedId) : null;

  if (!entry) {
    card.hidden = true;
    return;
  }

  clear(card);
  card.hidden = false;

  const speed = num(entry.position.speed);
  const stale = isStale(entry);
  const seen = new Date(entry.position.updated_at);

  card.appendChild(
    el('div', { className: 'detail-head' }, [
      el('div', {
        className: 'avatar' + (entry.vehicle?.is_emergency_authorized ? ' emergency' : ''),
        text: glyph(entry),
      }),
      el('div', {}, [
        el('div', { className: 'detail-title', text: plate(entry) }),
        el('div', {
          className: 'detail-sub',
          text: `${entry.vehicle?.driver_name ?? 'Unknown'} · ${entry.vehicle?.vehicle_type ?? 'NORMAL'}`,
        }),
      ]),
    ]),
  );

  card.appendChild(
    el('div', { className: 'stat-row' }, [
      stat('Speed', `${speed.toFixed(0)}`, speed > state.speedLimit),
      stat('Status', stale ? 'Offline' : 'Live'),
      stat('Last seen', seen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    ]),
  );

  card.appendChild(
    el('div', {
      className: 'detail-sub',
      text: `${entry.position.lat.toFixed(5)}, ${entry.position.lng.toFixed(5)}`,
    }),
  );

  if (entry.position.alert_message) {
    card.appendChild(el('div', { className: 'detail-alert', text: entry.position.alert_message }));
  }

  const actions = el('div', { className: 'detail-actions' });

  const trackBtn = el('button', { className: 'btn', text: 'Track' });
  trackBtn.addEventListener('click', () => openInsights(entry.position.vehicle_id));
  actions.appendChild(trackBtn);

  // The one role-conditional control in the interface.
  if (state.isOperator) {
    const alertBtn = el('button', { className: 'btn accent', text: 'Send alert' });
    alertBtn.addEventListener('click', () => openComposer(entry.position.vehicle_id));
    actions.appendChild(alertBtn);
  }

  const closeBtn = el('button', { className: 'btn', text: 'Close' });
  closeBtn.addEventListener('click', () => {
    state.selectedId = null;
    state.fleet.forEach(refreshMarker);
    renderFleet();
    renderDetail();
  });
  actions.appendChild(closeBtn);

  card.appendChild(actions);
}

// ---------------------------------------------------------------------------
// Insights drawer: history, violations, APK download
// ---------------------------------------------------------------------------

const drawer = $('drawer');

function closeDrawer() {
  drawer.hidden = true;
  clear(drawer);
}

function drawerShell(title) {
  clear(drawer);
  drawer.hidden = false;
  const close = el('button', { className: 'icon-btn', text: '\u2715' });
  close.addEventListener('click', closeDrawer);
  drawer.appendChild(el('div', { className: 'drawer-head' }, [el('h2', { text: title }), close]));
}

function describeViolation(v) {
  const started = new Date(v.occurred_at);
  const when = started.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const where = `${Number(v.lat).toFixed(4)}, ${Number(v.lng).toFixed(4)}`;
  const peak = `${Number(v.speed).toFixed(0)} km/h`;

  if (v.kind === 'HARSH_BRAKE') {
    const d = v.detail ?? {};
    return {
      when,
      where,
      peak,
      headline: 'Harsh braking',
      why: d.from_kmh !== undefined
        ? `${d.from_kmh} to ${d.to_kmh} km/h in ${d.seconds}s (${d.decel_mps2} m/s²)`
        : `Braked hard from ${peak}`,
    };
  }

  if (v.kind === 'WRONG_WAY') {
    return {
      when,
      where,
      peak,
      headline: 'Wrong way',
      why: `Against one-way ${v.detail?.road ?? 'road'} at ${peak}`,
    };
  }

  const over = Number(v.speed) - Number(v.speed_limit);
  const ended = v.cleared_at ? new Date(v.cleared_at) : null;
  const seconds = ended ? Math.max(1, Math.round((ended - started) / 1000)) : null;
  return {
    when,
    where,
    peak,
    headline: `Speeding · peak ${peak}`,
    // "Why" in the only sense the data supports: by how much, and for how long.
    why: `${over.toFixed(0)} km/h over the ${Number(v.speed_limit).toFixed(0)} limit` +
      (seconds ? ` for ${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`}` : ', still open'),
  };
}

async function openInsights(vehicleId) {
  const entry = state.fleet.get(vehicleId);
  const title = entry ? `${plate(entry)} · last ${HISTORY_DAYS} days` : `Last ${HISTORY_DAYS} days`;
  drawerShell(title);
  drawer.appendChild(el('p', { className: 'muted', text: 'Loading…' }));

  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();

  const [tripRes, violationRes] = await Promise.all([
    supabase.rpc('vehicle_trips', { p_vehicle_id: vehicleId, p_days: HISTORY_DAYS }),
    supabase
      .from('violations')
      .select('kind, speed, speed_limit, lat, lng, occurred_at, cleared_at, detail')
      .eq('vehicle_id', vehicleId)
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false }),
  ]);

  drawerShell(title);

  if (tripRes.error) {
    drawer.appendChild(el('p', { className: 'error', text: tripRes.error.message }));
    return;
  }

  const trips = tripRes.data ?? [];
  const violations = violationRes.data ?? [];

  // From trips, which are built from moving points only. Summing every
  // recorded point counted a parked phone's GPS wobble as kilometres driven.
  const metres = trips.reduce((m, t) => m + Number(t.distance_m), 0);
  const topSpeed = trips.reduce((m, t) => Math.max(m, Number(t.top_speed) || 0), 0);

  drawer.appendChild(
    el('div', { className: 'summary-row' }, [
      el('div', { className: 'summary' }, [
        el('b', { text: (metres / 1000).toFixed(1) }),
        el('small', { text: 'km driven' }),
      ]),
      el('div', { className: 'summary' }, [
        el('b', { text: topSpeed.toFixed(0) }),
        el('small', { text: 'top km/h' }),
      ]),
      el('div', { className: 'summary' }, [
        el('b', { text: String(violations.length) }),
        el('small', { text: 'violations' }),
      ]),
    ]),
  );

  drawer.appendChild(el('small', { className: 'muted', text: 'TRIPS · TAP TO REPLAY' }));

  if (trips.length === 0) {
    drawer.appendChild(
      el('p', {
        className: 'muted',
        text: 'No trips in this window. Time spent parked is not counted as driving.',
      }),
    );
  } else {
    trips.forEach((trip) => {
      const started = new Date(trip.started_at);
      const row = el('button', { className: 'trip-row' }, [
        el('span', {
          className: 'when',
          text: started.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
        }),
        el('span', {
          className: 'trip-stats',
          text: `${(Number(trip.distance_m) / 1000).toFixed(1)} km · ${formatDuration(
            new Date(trip.ended_at) - started,
          )} · top ${Number(trip.top_speed).toFixed(0)} km/h`,
        }),
        trip.violations > 0
          ? el('span', { className: 'tag over', text: `${trip.violations} rule break${trip.violations === 1 ? '' : 's'}` })
          : el('span', { className: 'tag', text: 'clean' }),
      ]);
      row.addEventListener('click', () => startReplay(vehicleId, trip));
      drawer.appendChild(row);
    });
  }

  drawer.appendChild(el('small', { className: 'muted', text: 'RULE BREAKS' }));

  if (violations.length === 0) {
    drawer.appendChild(el('p', { className: 'muted', text: 'No violations. Clean week.' }));
  } else {
    violations.forEach((v) => {
      const d = describeViolation(v);
      drawer.appendChild(
        el('div', { className: 'violation-item' }, [
          el('span', { className: 'when', text: d.when }),
          el('span', { className: 'peak', text: d.headline }),
          el('span', { className: 'why', text: d.why }),
          el('span', { className: 'why', text: `at ${d.where}` }),
        ]),
      );
    });
  }
}


// ---------------------------------------------------------------------------
// Alert composer (operators only)
// ---------------------------------------------------------------------------

async function openComposer(vehicleId) {
  const entry = vehicleId ? state.fleet.get(vehicleId) : null;
  drawerShell('Send alert');

  const target = el('select', { className: 'field-sm' });
  target.appendChild(el('option', { text: 'Whole fleet (broadcast)' })).value = '';
  state.fleet.forEach((e, id) => {
    const option = el('option', { text: `${plate(e)} · ${e.vehicle?.driver_name ?? ''}` });
    option.value = id;
    if (id === vehicleId) option.selected = true;
    target.appendChild(option);
  });

  const category = el('select', { className: 'field-sm' });
  [
    ['CONGESTION', 'Congestion ahead'],
    ['HAZARD', 'Hazard'],
    ['RULE', 'Rule broken'],
    ['MESSAGE', 'Message'],
  ].forEach(([value, label]) => {
    const option = el('option', { text: label });
    option.value = value;
    category.appendChild(option);
  });

  const severity = el('select', { className: 'field-sm' });
  ['INFO', 'WARNING', 'CRITICAL'].forEach((value) => {
    const option = el('option', { text: value });
    option.value = value;
    severity.appendChild(option);
  });

  const message = el('textarea', {
    className: 'field-sm',
    placeholder: entry
      ? `Message to ${plate(entry)}…`
      : 'Message to every vehicle on shift…',
  });
  message.maxLength = 300;

  const status = el('p', { className: 'muted', text: '' });
  const send = el('button', { className: 'btn accent', text: 'Send alert' });

  send.addEventListener('click', async () => {
    const text = message.value.trim();
    if (!text) {
      status.textContent = 'Write a message first.';
      return;
    }

    send.disabled = true;
    send.textContent = 'Sending…';

    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from('alerts').insert({
      created_by: userData.user.id,
      vehicle_id: target.value || null,
      category: category.value,
      severity: severity.value,
      message: text,
    });

    send.disabled = false;
    send.textContent = 'Send alert';

    if (error) {
      status.textContent = error.message;
      return;
    }

    message.value = '';
    status.textContent = 'Sent.';
    logEvent('alert', 'Alert sent', target.value ? `to ${plate(state.fleet.get(target.value))}` : 'to the whole fleet');
  });

  drawer.appendChild(el('small', { className: 'muted', text: 'RECIPIENT' }));
  drawer.appendChild(target);
  drawer.appendChild(el('small', { className: 'muted', text: 'CATEGORY' }));
  drawer.appendChild(category);
  drawer.appendChild(el('small', { className: 'muted', text: 'SEVERITY' }));
  drawer.appendChild(severity);
  drawer.appendChild(el('small', { className: 'muted', text: 'MESSAGE' }));
  drawer.appendChild(message);
  drawer.appendChild(send);
  drawer.appendChild(status);
}

// The Insights button opens whatever is useful for the current role and
// selection, so both roles reach it the same way.
$('open-drawer').addEventListener('click', () => {
  if (state.selectedId) return openInsights(state.selectedId);
  const first = [...state.fleet.keys()][0];
  if (first) return openInsights(first);

  drawerShell('Nothing to show yet');
  drawer.appendChild(
    el('p', {
      className: 'muted',
      text: 'Register a vehicle in the mobile app and start a shift. History appears here once positions are recorded.',
    }),
  );
  drawer.appendChild(apkLink());
});

function apkLink() {
  const url = CONFIG.APK_URL;
  if (!url) {
    return el('span', {
      className: 'download disabled',
      text: 'Android app — build link not configured',
    });
  }
  return el('a', { className: 'download', href: url, text: 'Download the Android app' });
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

function pushLog(node) {
  const log = $('log');
  const placeholder = log.querySelector('.empty');
  if (placeholder) clear(log);
  log.insertBefore(node, log.firstChild);
  while (log.childElementCount > MAX_LOG_ITEMS) log.removeChild(log.lastElementChild);
}

function logEvent(kind, title, detail) {
  pushLog(
    el('div', { className: `event ${kind}` }, [
      el('div', {}, [
        el('strong', { text: title }),
        el('br'),
        el('span', { className: 'muted', text: detail }),
      ]),
      el('time', { text: new Date().toLocaleTimeString() }),
    ]),
  );
}

/** Vehicle identity is fetched once and cached; positions arrive far more often
 *  than the row changes, so joining on every frame would be wasteful. */
async function ensureVehicle(entry, vehicleId) {
  if (entry.vehicle) return;
  const { data } = await supabase
    .from('vehicles')
    .select('id, vehicle_number, driver_name, vehicle_type, is_emergency_authorized')
    .eq('id', vehicleId)
    .maybeSingle();
  if (!data) return;
  entry.vehicle = data;
  refreshMarker(entry);
  renderFleet();
  logEvent('info', 'Vehicle online', `${data.vehicle_number} · ${data.driver_name}`);
}

function applyPosition(position) {
  if (!position || typeof position.vehicle_id !== 'string') return;
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return;

  const entry = state.fleet.get(position.vehicle_id) ?? { vehicle: null, marker: null };
  entry.position = position;
  state.fleet.set(position.vehicle_id, entry);

  const isFirst = state.fleet.size === 1 && !state.hasFramedFleet;
  ensureVehicle(entry, position.vehicle_id);
  refreshMarker(entry);

  if (isFirst && state.map) {
    state.hasFramedFleet = true;
    state.map.easeTo({ center: [position.lng, position.lat], zoom: 14, duration: 900 });
  }

  if (state.selectedId === position.vehicle_id) {
    state.map?.easeTo({ center: [position.lng, position.lat], duration: 400 });
    renderDetail();
  }

  renderFleet();
}

function setConnection(text, live) {
  $('conn-state').textContent = text;
  $('live-dot').classList.toggle('on', !!live);
}

async function loadViolationCount() {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
  const { count } = await supabase
    .from('violations')
    .select('id', { count: 'exact', head: true })
    .gte('occurred_at', since);
  state.violations = count ?? 0;
  $('violation-count').textContent = `${state.violations} speeding`;
}

// ---------------------------------------------------------------------------
// Green corridors
//
// The route and the drivers warned are real. The signal states are SIMULATED:
// SUTRA does not control traffic lights, and the panel says so permanently so
// nobody watching a demo is misled.
// ---------------------------------------------------------------------------

const CORRIDOR_COLOR = '#22C55E';
const SIGNAL_COLOR = { WAITING: '#FF6B5A', PREEMPT: '#F5B63B', GREEN: '#22C55E', PASSED: '#6B6F65' };
const SIGNAL_LABEL = { WAITING: 'red', PREEMPT: 'clearing', GREEN: 'green', PASSED: 'passed' };
// PostgREST caps a response at 1,000 rows; a long route has more points.
const PAGE = 1000;

state.channelState = 'idle';
state.rejoinAttempt = 0;
state.rejoinTimer = null;
state.lastReconcileAt = 0;
state.corridors = new Map(); // corridor id -> { corridor, route, signals, markers, warned }

async function fetchRoutePoints(corridorId) {
  const points = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('corridor_route_points')
      .select('lat, lng')
      .eq('corridor_id', corridorId)
      .order('seq')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    points.push(...(data ?? []));
    if (!data || data.length < PAGE) return points;
  }
}

function paintSignal(item, signal) {
  item.signals.set(signal.id, signal);
  if (!state.map) return;
  let marker = item.markers.get(signal.id);
  if (!marker) {
    marker = new maplibregl.Marker({ element: el('div', { className: 'signal-marker' }) })
      .setLngLat([signal.lng, signal.lat])
      .addTo(state.map);
    item.markers.set(signal.id, marker);
  }
  const dot = marker.getElement();
  dot.style.background = SIGNAL_COLOR[signal.state] ?? SIGNAL_COLOR.WAITING;
  dot.title = `Junction ${signal.seq}: ${SIGNAL_LABEL[signal.state]} (simulated)`;
}

function drawCorridorRoute(item) {
  if (!state.map || item.route.length < 2) return;
  const src = `corridor-${item.corridor.id}`;
  const data = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: item.route.map((p) => [p.lng, p.lat]) },
  };
  const draw = () => {
    if (state.map.getSource(src)) return state.map.getSource(src).setData(data);
    state.map.addSource(src, { type: 'geojson', data });
    state.map.addLayer({
      id: `${src}-glow`,
      type: 'line',
      source: src,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': CORRIDOR_COLOR, 'line-width': 14, 'line-opacity': 0.22 },
    });
    state.map.addLayer({
      id: `${src}-line`,
      type: 'line',
      source: src,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': CORRIDOR_COLOR, 'line-width': 5 },
    });
  };
  // A corridor can arrive before the map style has finished loading.
  if (state.map.isStyleLoaded()) draw();
  else state.map.once('load', draw);
}

function removeCorridor(corridorId) {
  const item = state.corridors.get(corridorId);
  if (!item) return;
  item.markers.forEach((m) => m.remove());
  const src = `corridor-${corridorId}`;
  if (state.map) {
    for (const layer of [`${src}-line`, `${src}-glow`]) {
      if (state.map.getLayer(layer)) state.map.removeLayer(layer);
    }
    if (state.map.getSource(src)) state.map.removeSource(src);
  }
  state.corridors.delete(corridorId);
  renderCorridors();
}

async function loadCorridor(corridor) {
  if (state.corridors.has(corridor.id)) return;
  const item = { corridor, route: [], signals: new Map(), markers: new Map(), warned: new Set() };
  state.corridors.set(corridor.id, item);

  try {
    const [route, signals, warnings] = await Promise.all([
      fetchRoutePoints(corridor.id),
      supabase.from('corridor_signals').select('*').eq('corridor_id', corridor.id).order('seq'),
      supabase.from('corridor_warnings').select('vehicle_id').eq('corridor_id', corridor.id),
    ]);
    // Ended while this was loading.
    if (!state.corridors.has(corridor.id)) return;
    item.route = route;
    (signals.data ?? []).forEach((s) => paintSignal(item, s));
    (warnings.data ?? []).forEach((w) => item.warned.add(w.vehicle_id));
    drawCorridorRoute(item);
  } catch (e) {
    logEvent('violation', 'Could not load corridor', e?.message ?? String(e));
  }
  renderCorridors();
}

async function loadCorridors() {
  const { data, error } = await supabase
    .from('corridors')
    .select('*')
    .eq('status', 'ACTIVE')
    .gt('expires_at', new Date().toISOString());
  if (error) return logEvent('violation', 'Could not load corridors', error.message);
  await Promise.all((data ?? []).map(loadCorridor));
}

function focusCorridor(item) {
  if (!state.map || item.route.length < 2) return;
  const first = [item.route[0].lng, item.route[0].lat];
  const bounds = item.route.reduce(
    (b, p) => b.extend([p.lng, p.lat]),
    new maplibregl.LngLatBounds(first, first),
  );
  state.map.fitBounds(bounds, { padding: 120, maxZoom: 16, duration: 700 });
}

function corridorName(item) {
  const entry = state.fleet.get(item.corridor.vehicle_id);
  return `\u{1F691} ${entry ? plate(entry) : 'Emergency vehicle'} → ${item.corridor.destination_name ?? 'destination'}`;
}

function renderCorridors() {
  const panel = $('corridors');
  clear(panel);
  panel.hidden = state.corridors.size === 0;
  if (panel.hidden) return;

  panel.appendChild(
    el('div', { className: 'corridor-head' }, [
      el('strong', { text: `Green corridors · ${state.corridors.size}` }),
      el('span', { className: 'sim-badge', text: 'SIMULATED: no live signal control' }),
    ]),
  );

  state.corridors.forEach((item) => {
    const signals = [...item.signals.values()].sort((a, b) => a.seq - b.seq);
    const cleared = signals.filter((s) => s.state === 'PASSED').length;
    const next = signals.find((s) => s.state !== 'PASSED');
    const warned = item.warned.size;

    const row = el('button', { className: 'corridor-row' }, [
      el('span', { className: 'corridor-title', text: corridorName(item) }),
      el('span', {
        className: 'muted',
        text: [
          signals.length ? `${cleared}/${signals.length} junctions cleared` : 'no mapped junctions',
          next ? `next ${SIGNAL_LABEL[next.state]}` : null,
          `${warned} driver${warned === 1 ? '' : 's'} warned`,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    ]);
    row.type = 'button';
    row.addEventListener('click', () => focusCorridor(item));
    panel.appendChild(row);
  });
}

function onCorridorChange(payload) {
  const corridor = payload.new;
  if (!corridor?.id) return;
  if (corridor.status === 'ACTIVE') {
    if (payload.eventType === 'INSERT') {
      logEvent('alert', 'Green corridor opened', corridorName({ corridor }));
    }
    loadCorridor(corridor);
  } else if (state.corridors.has(corridor.id)) {
    logEvent('alert', 'Green corridor closed', corridorName(state.corridors.get(corridor.id)));
    removeCorridor(corridor.id);
  }
}

function onSignalChange(payload) {
  const item = state.corridors.get(payload.new.corridor_id);
  if (!item) return;
  paintSignal(item, payload.new);
  renderCorridors();
}

function onWarning(payload) {
  const item = state.corridors.get(payload.new.corridor_id);
  if (!item) return;
  item.warned.add(payload.new.vehicle_id);
  renderCorridors();
}

// Corridors lapse at expires_at without any update event, so sweep them.
setInterval(() => {
  const now = Date.now();
  state.corridors.forEach((item, id) => {
    if (new Date(item.corridor.expires_at).getTime() <= now) removeCorridor(id);
  });
}, 30_000);

// ---------------------------------------------------------------------------
// Vehicles: emergency authorization
//
// The flag that lets a vehicle open a green corridor. A driver cannot set it on
// their own vehicle - a database trigger refuses - so it is granted here, by a
// named operator, and every change is recorded in emergency_grants.
//
// This lists the vehicles table rather than the live fleet, so a vehicle that
// has never started a shift can still be authorized.
// ---------------------------------------------------------------------------

const VEHICLE_TYPES = ['NORMAL', 'AMBULANCE', 'POLICE', 'FIRE'];

/** Keep a granted flag visible on the map and in the list straight away. */
function applyAuthorizationLocally(vehicleId, patch) {
  const entry = state.fleet.get(vehicleId);
  if (!entry?.vehicle) return;
  Object.assign(entry.vehicle, patch);
  refreshMarker(entry);
  renderFleet();
  if (state.selectedId === vehicleId) renderDetail();
}

function vehicleAdminRow(vehicle, lastGrant, onChanged) {
  const row = el('div', { className: 'admin-row' });

  const authorized = !!vehicle.is_emergency_authorized;
  const head = el('div', { className: 'admin-head' }, [
    el('strong', { text: vehicle.vehicle_number }),
    el('span', {
      className: authorized ? 'tag granted' : 'tag',
      text: authorized ? 'Emergency authorized' : vehicle.vehicle_type,
    }),
  ]);
  row.appendChild(head);

  row.appendChild(
    el('small', {
      className: 'muted',
      text: lastGrant
        ? `${vehicle.driver_name} · last changed ${new Date(lastGrant.at).toLocaleString([], {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}`
        : vehicle.driver_name,
    }),
  );

  const type = el('select', { className: 'field-sm' });
  VEHICLE_TYPES.forEach((value) => {
    const option = el('option', { text: value });
    option.value = value;
    if (value === vehicle.vehicle_type) option.selected = true;
    type.appendChild(option);
  });

  const action = el('button', {
    className: authorized ? 'btn' : 'btn accent',
    text: authorized ? 'Revoke' : 'Authorize',
  });
  const status = el('small', { className: 'error', text: '' });
  status.hidden = true;

  action.addEventListener('click', async () => {
    action.disabled = true;
    status.hidden = true;
    const wanted = !authorized;
    try {
      const { error } = await supabase.rpc('set_emergency_authorization', {
        p_vehicle_id: vehicle.id,
        p_authorized: wanted,
        p_vehicle_type: type.value,
      });
      if (error) throw error;

      logEvent(
        'alert',
        wanted ? 'Emergency authorization granted' : 'Emergency authorization revoked',
        `${vehicle.vehicle_number} · ${type.value}`,
      );
      applyAuthorizationLocally(vehicle.id, {
        is_emergency_authorized: wanted,
        vehicle_type: type.value,
      });
      onChanged();
    } catch (e) {
      status.textContent = e?.message ?? String(e);
      status.hidden = false;
      action.disabled = false;
    }
  });

  row.appendChild(el('div', { className: 'admin-actions' }, [type, action]));
  row.appendChild(status);
  return row;
}

async function openVehicleAdmin() {
  drawerShell('Vehicles');
  drawer.appendChild(el('p', { className: 'muted', text: 'Loading…' }));

  const [vehicleRes, grantRes] = await Promise.all([
    supabase
      .from('vehicles')
      .select('id, vehicle_number, driver_name, vehicle_type, is_emergency_authorized')
      .order('vehicle_number'),
    supabase
      .from('emergency_grants')
      .select('vehicle_id, authorized, at')
      .order('at', { ascending: false })
      .limit(200),
  ]);

  drawerShell('Vehicles');

  if (vehicleRes.error) {
    drawer.appendChild(el('p', { className: 'error', text: vehicleRes.error.message }));
    return;
  }

  const vehicles = vehicleRes.data ?? [];
  // Newest first, so the first row seen for a vehicle is its latest change.
  const latest = new Map();
  (grantRes.data ?? []).forEach((g) => {
    if (!latest.has(g.vehicle_id)) latest.set(g.vehicle_id, g);
  });

  drawer.appendChild(
    el('p', {
      className: 'muted',
      text: 'Emergency authorization lets a vehicle open a green corridor. Drivers cannot grant it; every change here is recorded against your account.',
    }),
  );

  if (vehicles.length === 0) {
    drawer.appendChild(
      el('p', { className: 'muted', text: 'No vehicles registered yet.' }),
    );
    return;
  }

  const list = el('div', { className: 'admin-list' });
  vehicles.forEach((v) => list.appendChild(vehicleAdminRow(v, latest.get(v.id), openVehicleAdmin)));
  drawer.appendChild(list);
}

$('open-vehicles').addEventListener('click', openVehicleAdmin);

// ---------------------------------------------------------------------------
// Trips and replay
//
// A trip is a run of moving points with no gap longer than five minutes; the
// database works that out (vehicle_trips) so a parked phone's GPS wobble is
// never counted as distance. Replay then plays one trip back on the map with
// its violations pinned where they happened.
// ---------------------------------------------------------------------------

/** One request's worth. PostgREST caps responses at 1000 rows by default. */
const HISTORY_PAGE = 1000;
/** About five and a half hours at one point a second. Enough for any shift. */
const MAX_REPLAY_POINTS = 20_000;
const REPLAY_RATES = [1, 10, 60];

state.replay = null;

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Every point of one trip, oldest first, fetched a page at a time. */
async function fetchTripPoints(vehicleId, from, to) {
  const points = [];
  for (let offset = 0; offset < MAX_REPLAY_POINTS; offset += HISTORY_PAGE) {
    const { data, error } = await supabase
      .from('position_history')
      .select('lat, lng, speed, heading, recorded_at')
      .eq('vehicle_id', vehicleId)
      .gte('recorded_at', from)
      .lte('recorded_at', to)
      .order('recorded_at', { ascending: true })
      .range(offset, offset + HISTORY_PAGE - 1);
    if (error) throw new Error(error.message);
    points.push(...(data ?? []));
    if (!data || data.length < HISTORY_PAGE) break;
  }
  return points.map((p) => ({ ...p, t: new Date(p.recorded_at).getTime() }));
}

function stopReplay() {
  const r = state.replay;
  if (!r) return;
  cancelAnimationFrame(r.frame);
  r.marker?.remove();
  r.pins.forEach((pin) => pin.remove());
  state.replay = null;
  const bar = $('replay');
  bar.hidden = true;
  clear(bar);
  drawTrack([]);
}

function renderReplayFrame() {
  const r = state.replay;
  if (!r) return;
  const here = positionAt(r.points, r.t);
  r.marker.setLngLat([here.lng, here.lat]);
  r.clock.textContent = formatClock(new Date(r.t));
  r.speed.textContent = `${Math.round(here.speed)} km/h`;
  r.speed.classList.toggle('over', here.speed > state.speedLimit);
  r.slider.value = String(Math.round(r.t - r.points[0].t));
}

function tick(now) {
  const r = state.replay;
  if (!r || !r.playing) return;
  const elapsed = r.lastFrame ? now - r.lastFrame : 0;
  r.lastFrame = now;
  r.t = Math.min(r.t + elapsed * r.rate, r.points[r.points.length - 1].t);
  renderReplayFrame();

  if (r.t >= r.points[r.points.length - 1].t) {
    r.playing = false;
    r.play.textContent = '▶';
    return;
  }
  r.frame = requestAnimationFrame(tick);
}

function setPlaying(playing) {
  const r = state.replay;
  if (!r) return;
  // Pressing play at the end starts again rather than doing nothing.
  if (playing && r.t >= r.points[r.points.length - 1].t) r.t = r.points[0].t;
  r.playing = playing;
  r.lastFrame = 0;
  r.play.textContent = playing ? '❚❚' : '▶';
  cancelAnimationFrame(r.frame);
  if (playing) r.frame = requestAnimationFrame(tick);
}

async function startReplay(vehicleId, trip) {
  stopReplay();
  closeDrawer();
  const bar = $('replay');
  bar.hidden = false;
  clear(bar);
  bar.appendChild(el('span', { className: 'muted', text: 'Loading trip…' }));

  let points;
  let violations;
  try {
    [points, violations] = await Promise.all([
      fetchTripPoints(vehicleId, trip.started_at, trip.ended_at),
      supabase
        .from('violations')
        .select('kind, speed, speed_limit, lat, lng, occurred_at, cleared_at, detail')
        .eq('vehicle_id', vehicleId)
        .gte('occurred_at', trip.started_at)
        .lte('occurred_at', trip.ended_at)
        .then(({ data, error }) => {
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
    ]);
  } catch (e) {
    clear(bar);
    bar.appendChild(el('span', { className: 'error', text: e.message }));
    return;
  }

  if (points.length < 2) {
    clear(bar);
    bar.appendChild(el('span', { className: 'muted', text: 'Not enough recorded points to replay.' }));
    return;
  }

  drawTrack(points);

  // Where each rule was broken, so the replay can be read at a glance.
  const pins = violations.map((v) => {
    const pin = el('div', { className: 'violation-pin', title: describeViolation(v).why });
    return new maplibregl.Marker({ element: pin }).setLngLat([v.lng, v.lat]).addTo(state.map);
  });

  const dot = el('div', { className: 'replay-dot' });
  const marker = new maplibregl.Marker({ element: dot })
    .setLngLat([points[0].lng, points[0].lat])
    .addTo(state.map);

  clear(bar);
  const play = el('button', { className: 'icon-btn', text: '▶', title: 'Play or pause' });
  const slider = el('input', { className: 'replay-slider' });
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(points[points.length - 1].t - points[0].t);
  slider.value = '0';
  const clock = el('span', { className: 'replay-clock' });
  const speed = el('span', { className: 'replay-speed' });
  const rate = el('select', { className: 'field-sm' });
  REPLAY_RATES.forEach((n) => {
    const option = el('option', { text: `${n}×` });
    option.value = String(n);
    rate.appendChild(option);
  });
  rate.value = '10';
  const close = el('button', { className: 'icon-btn', text: '✕', title: 'Close replay' });

  state.replay = {
    points,
    pins,
    marker,
    t: points[0].t,
    rate: 10,
    playing: false,
    frame: 0,
    lastFrame: 0,
    play,
    slider,
    clock,
    speed,
  };

  play.addEventListener('click', () => setPlaying(!state.replay.playing));
  slider.addEventListener('input', () => {
    state.replay.t = points[0].t + Number(slider.value);
    renderReplayFrame();
  });
  rate.addEventListener('change', () => {
    state.replay.rate = Number(rate.value);
  });
  close.addEventListener('click', stopReplay);

  bar.appendChild(play);
  bar.appendChild(slider);
  bar.appendChild(el('div', { className: 'replay-readout' }, [clock, speed]));
  bar.appendChild(rate);
  bar.appendChild(close);
  bar.appendChild(
    el('small', {
      className: 'muted replay-caption',
      text: `${new Date(trip.started_at).toLocaleString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })} · ${(trip.distance_m / 1000).toFixed(1)} km · ${violations.length} violation${violations.length === 1 ? '' : 's'}`,
    }),
  );

  renderReplayFrame();
  setPlaying(true);
}

// ---------------------------------------------------------------------------
// Speeding heatmap
//
// Where rules are broken across the fleet, weighted by how far over the limit.
// Row-level security scopes it: an operator sees the fleet, a driver their own.
// ---------------------------------------------------------------------------

const HEATMAP_DAYS = 30;

async function toggleHeatmap() {
  const button = $('toggle-heatmap');
  const map = state.map;
  if (!map) return;

  if (map.getLayer('violation-heat')) {
    map.removeLayer('violation-heat');
    map.removeSource('violation-heat');
    button.classList.remove('accent');
    return;
  }

  button.disabled = true;
  const since = new Date(Date.now() - HEATMAP_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('violations')
    .select('lat, lng, speed, speed_limit, kind')
    .gte('occurred_at', since)
    .limit(5000);
  button.disabled = false;

  if (error) {
    logEvent('violation', 'Could not load the speeding map', error.message);
    return;
  }

  map.addSource('violation-heat', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: (data ?? []).map((v) => ({
        type: 'Feature',
        properties: {
          // How far over, so one 140 km/h run outweighs ten at 82.
          weight: Math.min(Math.max((Number(v.speed) - Number(v.speed_limit)) / 40, 0.15), 1),
        },
        geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
      })),
    },
  });
  map.addLayer({
    id: 'violation-heat',
    type: 'heatmap',
    source: 'violation-heat',
    paint: {
      'heatmap-weight': ['get', 'weight'],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 12, 15, 30],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 15, 2],
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0, 'rgba(0,0,0,0)',
        0.2, 'rgba(245,182,59,0.45)',
        0.6, 'rgba(255,107,90,0.75)',
        1, 'rgba(255,60,40,0.95)',
      ],
      'heatmap-opacity': 0.85,
    },
  });
  button.classList.add('accent');
  logEvent(
    'violation',
    'Speeding map',
    `${data?.length ?? 0} rule break${data?.length === 1 ? '' : 's'} in the last ${HEATMAP_DAYS} days`,
  );
}

$('toggle-heatmap').addEventListener('click', toggleHeatmap);

async function startConsole() {
  // The map is the most fragile part of the console: MapLibre needs WebGL, and
  // throws if the browser or GPU cannot provide it. Losing the map should not
  // cost the operator the fleet list, events and alerts, so this is contained.
  try {
    initMap();
  } catch (e) {
    console.error('[sutra] map unavailable', e);
    const container = $('map');
    clear(container);
    container.appendChild(
      el('div', { className: 'map-fallback' }, [
        el('strong', { text: 'Map unavailable' }),
        el('span', {
          className: 'muted',
          text: `${e?.message ?? e}. The fleet list and events below still work.`,
        }),
      ]),
    );
  }

  await reconcile();
  loadCorridors();
  subscribeToFleet();

  // Realtime is the fast path, not the only one. A laptop that slept, a tunnel,
  // or an expired token all leave a socket that looks connected and delivers
  // nothing, and the operator cannot tell the difference. Re-reading the live
  // positions on a timer means the map is correct within seconds either way,
  // instead of needing the page reloaded.
  setInterval(() => {
    if (document.visibilityState === 'visible') reconcile();
  }, RECONCILE_MS);

  // Coming back to the tab is the moment an operator most needs it to be right.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    reconcile();
    if (state.channelState !== 'joined') subscribeToFleet();
  });

  // A vehicle that stops streaming leaves its last row behind, so staleness is
  // re-rendered on a timer rather than waiting for an event that never arrives.
  setInterval(() => {
    renderFleet();
    state.fleet.forEach(refreshMarker);
    if (state.selectedId) renderDetail();
  }, 5_000);
}

/**
 * Re-read what the console should be showing. Cheap: one row per vehicle.
 *
 * Also run after every successful (re)subscribe, because anything that changed
 * while the socket was down produced no event and would otherwise be missed
 * until that vehicle happened to move again.
 */
async function reconcile() {
  const { data, error } = await supabase.from('vehicle_positions').select('*');
  if (error) {
    setConnection('cannot reach the server', false);
    return;
  }

  const live = new Set();
  (data ?? []).forEach((position) => {
    live.add(position.vehicle_id);
    applyPosition(position);
  });

  // A vehicle whose row was deleted while we were not listening.
  state.fleet.forEach((entry, id) => {
    if (live.has(id)) return;
    entry.marker?.remove();
    state.fleet.delete(id);
    if (state.selectedId === id) state.selectedId = null;
  });

  state.lastReconcileAt = Date.now();
  renderFleet();
  renderDetail();
  loadViolationCount();
}

/** Rejoin after a drop, backing off so a server having a bad minute is not hammered. */
function scheduleRejoin() {
  if (state.rejoinTimer) return;
  state.rejoinAttempt = Math.min(state.rejoinAttempt + 1, 6);
  const delay = backoffDelayMs(state.rejoinAttempt);
  setConnection(`reconnecting in ${Math.round(delay / 1000)}s`, false);

  state.rejoinTimer = setTimeout(() => {
    state.rejoinTimer = null;
    subscribeToFleet();
  }, delay);
}

/** 2s, 4s, 8s … 30s, plus jitter so many consoles do not retry in lockstep. */
function backoffDelayMs(attempt, random = Math.random) {
  const base = Math.min(REJOIN_BASE_MS * 2 ** (attempt - 1), REJOIN_MAX_MS);
  return Math.round(base * (0.8 + random() * 0.4));
}

function subscribeToFleet() {
  if (state.rejoinTimer) {
    clearTimeout(state.rejoinTimer);
    state.rejoinTimer = null;
  }
  // One channel at a time; a stale one keeps its own retry loop otherwise.
  supabase.getChannels().forEach((channel) => supabase.removeChannel(channel));
  state.channelState = 'joining';
  setConnection('connecting', false);

  state.channel = supabase
    .channel('sutra-fleet')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vehicle_positions' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.vehicle_id;
        const entry = state.fleet.get(id);
        entry?.marker?.remove();
        state.fleet.delete(id);
        if (state.selectedId === id) state.selectedId = null;
        renderFleet();
        renderDetail();
        return;
      }
      applyPosition(payload.new);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'violations' }, (payload) => {
      state.violations += 1;
      $('violation-count').textContent = `${state.violations} speeding`;
      const entry = state.fleet.get(payload.new.vehicle_id);
      const d = describeViolation(payload.new);
      logEvent('violation', d.headline, `${entry ? plate(entry) : 'Vehicle'} · ${d.why}`);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (payload) => {
      const entry = payload.new.vehicle_id ? state.fleet.get(payload.new.vehicle_id) : null;
      logEvent(
        'alert',
        `${payload.new.category} alert`,
        `${entry ? plate(entry) : 'Fleet'} — ${payload.new.message}`,
      );
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'corridors' }, onCorridorChange)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'corridor_signals' }, onSignalChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'corridor_warnings' }, onWarning)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        state.channelState = 'joined';
        state.rejoinAttempt = 0;
        setConnection('live', true);
        // Anything that changed while we were away produced no event.
        reconcile();
        return;
      }

      state.channelState = 'dropped';
      // CLOSED and TIMED_OUT are ordinary on a laptop that slept or a phone
      // that changed network. Previously nothing rejoined, so the only cure
      // was reloading the page.
      if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
        scheduleRejoin();
      } else {
        setConnection(status.toLowerCase(), false);
      }
    });
}

// Resume an existing session so a refresh does not force another sign-in.
supabase.auth.getSession().then(({ data }) => {
  if (data.session) {
    enterConsole().catch((e) => {
      consoleStarted = false;
      console.error('[sutra] console failed to start', e);
      $('gate').hidden = false;
      $('console').hidden = true;
      gateError(`Console failed to start: ${e?.message ?? e}`);
    });
  }
});
