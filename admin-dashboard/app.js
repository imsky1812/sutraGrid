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

const CONFIG = window.SUTRA_CONFIG || {};
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const STALE_AFTER_MS = 30_000;
const MAX_LOG_ITEMS = 150;
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
supabase.auth.onAuthStateChange(async (event) => {
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
  const over = Number(v.speed) - Number(v.speed_limit);
  const ended = v.cleared_at ? new Date(v.cleared_at) : null;
  const started = new Date(v.occurred_at);
  const seconds = ended ? Math.max(1, Math.round((ended - started) / 1000)) : null;

  return {
    when: started.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
    // "Why" in the only sense the data supports: by how much, and for how long.
    why: `${over.toFixed(0)} km/h over the ${Number(v.speed_limit).toFixed(0)} limit` +
      (seconds ? ` for ${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`}` : ', still open'),
    where: `${Number(v.lat).toFixed(4)}, ${Number(v.lng).toFixed(4)}`,
    peak: `${Number(v.speed).toFixed(0)} km/h`,
  };
}

async function openInsights(vehicleId) {
  const entry = state.fleet.get(vehicleId);
  drawerShell(entry ? `${plate(entry)} · last ${HISTORY_DAYS} days` : `Last ${HISTORY_DAYS} days`);
  drawer.appendChild(el('p', { className: 'muted', text: 'Loading…' }));

  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();

  const [historyRes, violationRes] = await Promise.all([
    supabase
      .from('position_history')
      .select('lat, lng, speed, recorded_at')
      .eq('vehicle_id', vehicleId)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true })
      .limit(5000),
    supabase
      .from('violations')
      .select('speed, speed_limit, lat, lng, occurred_at, cleared_at')
      .eq('vehicle_id', vehicleId)
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false }),
  ]);

  drawerShell(entry ? `${plate(entry)} · last ${HISTORY_DAYS} days` : `Last ${HISTORY_DAYS} days`);

  if (historyRes.error) {
    drawer.appendChild(el('p', { className: 'error', text: historyRes.error.message }));
    return;
  }

  const points = historyRes.data ?? [];
  const violations = violationRes.data ?? [];

  // Distance from the track itself rather than a stored odometer, so it stays
  // honest about what was actually recorded.
  let metres = 0;
  for (let i = 1; i < points.length; i++) metres += haversine(points[i - 1], points[i]);
  const topSpeed = points.reduce((m, p) => Math.max(m, Number(p.speed) || 0), 0);

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

  if (points.length > 1) {
    const showBtn = el('button', { className: 'btn accent', text: 'Show track on map' });
    showBtn.addEventListener('click', () => {
      drawTrack(points);
      closeDrawer();
    });
    drawer.appendChild(showBtn);
  } else {
    drawer.appendChild(
      el('p', { className: 'muted', text: 'No recorded positions in this window yet.' }),
    );
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
          el('span', { className: 'peak', text: `Peak ${d.peak}` }),
          el('span', { className: 'why', text: d.why }),
          el('span', { className: 'why', text: `at ${d.where}` }),
        ]),
      );
    });
  }
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
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

  // Backfill so a console opened mid-shift is not blank until the next frame.
  const { data, error } = await supabase.from('vehicle_positions').select('*');
  if (error) logEvent('violation', 'Could not load fleet', error.message);
  else (data ?? []).forEach(applyPosition);

  renderFleet();
  loadViolationCount();

  supabase.getChannels().forEach((channel) => supabase.removeChannel(channel));

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
      logEvent(
        'violation',
        'Speed violation',
        `${entry ? plate(entry) : payload.new.vehicle_id} peaked at ${Number(payload.new.speed).toFixed(0)} km/h`,
      );
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (payload) => {
      const entry = payload.new.vehicle_id ? state.fleet.get(payload.new.vehicle_id) : null;
      logEvent(
        'alert',
        `${payload.new.category} alert`,
        `${entry ? plate(entry) : 'Fleet'} — ${payload.new.message}`,
      );
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setConnection('live', true);
      else if (status === 'CHANNEL_ERROR') setConnection('connection error', false);
      else if (status === 'CLOSED') setConnection('disconnected', false);
      else setConnection(status.toLowerCase(), false);
    });

  // A vehicle that stops streaming leaves its last row behind, so staleness is
  // re-rendered on a timer rather than waiting for an event that never arrives.
  setInterval(() => {
    renderFleet();
    state.fleet.forEach(refreshMarker);
    if (state.selectedId) renderDetail();
  }, 5_000);
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
