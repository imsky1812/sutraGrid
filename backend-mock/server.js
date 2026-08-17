const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Secrets come from the environment. A `.env` file next to this script is read
// as a convenience for local development; it is gitignored and must never be
// committed. See .env.example for the expected keys.
function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;

// Codes that authorise a client to stream as an emergency vehicle. Comma
// separated. Without this set, no client can obtain emergency privileges.
const EMERGENCY_CODES = new Set(
    (process.env.EMERGENCY_CODES || '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
);

// Shared secret the operator dashboard presents to subscribe to the feed.
const OPERATOR_KEY = process.env.OPERATOR_KEY || '';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

if (EMERGENCY_CODES.size === 0) {
    console.warn('[config] EMERGENCY_CODES is unset - emergency privileges cannot be granted.');
}
if (!OPERATOR_KEY) {
    console.warn('[config] OPERATOR_KEY is unset - the dashboard cannot subscribe. Set it in backend-mock/.env');
}

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
// A session is the server's record of who a token belongs to. Every field the
// dashboard displays is read from here, never from the streamed payload, so a
// client cannot claim to be a different vehicle or upgrade itself to emergency
// status by editing its own JSON.
const sessions = new Map(); // token -> session

function createSession(claims) {
    const token = crypto.randomBytes(32).toString('hex');
    const session = { ...claims, token, issuedAt: Date.now() };
    sessions.set(token, session);
    return session;
}

function getSession(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.issuedAt > SESSION_TTL_MS) {
        sessions.delete(token);
        return null;
    }
    return session;
}

// Constant-time compare so an attacker cannot time their way to the key.
function safeEquals(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function isValidEmergencyCode(code) {
    if (typeof code !== 'string' || code.length === 0) return false;
    for (const known of EMERGENCY_CODES) {
        if (safeEquals(code, known)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
const VEHICLE_TYPES = new Set(['NORMAL', 'AMBULANCE', 'POLICE', 'FIRE']);
const MAX_TEXT = 64;
const MAX_ALERT = 200;

// Vehicle IDs are rendered into the operator dashboard, so the character set is
// deliberately narrow rather than merely length-capped.
const VEHICLE_ID_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;
const DRIVER_NAME_PATTERN = /^[^\x00-\x1F\x7F<>&"'`]{1,64}$/;

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function isInRange(value, min, max) {
    return isFiniteNumber(value) && value >= min && value <= max;
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return null;
    // Strip control characters, then bound the length.
    const stripped = value.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (!stripped) return null;
    return stripped.slice(0, maxLength);
}

/**
 * Validate a telemetry frame and return a normalised copy, or null if the frame
 * is unusable. Identity fields are taken from the session, not the payload.
 *
 * Nothing reaches `activeVehicles` without passing through here, which is what
 * keeps the console renderer and the dashboard from being handed a payload that
 * makes them throw.
 */
function validateTelemetry(raw, session) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    if (!isInRange(raw.lat, -90, 90)) return null;
    if (!isInRange(raw.lng, -180, 180)) return null;
    if (!isInRange(raw.speed, 0, 500)) return null;

    const direction = isInRange(raw.direction, 0, 360) ? raw.direction : 0;

    // Client clocks are not trusted; a bad timestamp must not poison rendering.
    const timestamp = isInRange(raw.timestamp, 0, 4102444800) // <= year 2100
        ? Math.floor(raw.timestamp)
        : Math.floor(Date.now() / 1000);

    const hasDestination =
        isInRange(raw.destinationLat, -90, 90) && isInRange(raw.destinationLng, -180, 180);

    return {
        // Identity: authoritative, from the session.
        vehicleId: session.vehicleId,
        driverName: session.driverName,
        type: session.vehicleType,
        isEmergency: session.isEmergency,

        // Telemetry: validated, from the client.
        lat: raw.lat,
        lng: raw.lng,
        speed: raw.speed,
        direction,
        timestamp,
        destinationLat: hasDestination ? raw.destinationLat : null,
        destinationLng: hasDestination ? raw.destinationLng : null,
        destinationName: hasDestination ? cleanText(raw.destinationName, MAX_TEXT) : null,
        // Only an authenticated emergency vehicle can raise a corridor alert.
        alertMessage: session.isEmergency ? cleanText(raw.alertMessage, MAX_ALERT) : null
    };
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
    res.type('html').send('<h1>SUTRA Mock Backend is LIVE</h1><p>Waiting for vehicle data...</p>');
});

app.post('/api/auth/login', (req, res) => {
    const body = req.body || {};

    const driverName = cleanText(body.name, MAX_TEXT);
    const vehicleId = cleanText(body.vehicleId, 32);

    if (!driverName || !DRIVER_NAME_PATTERN.test(driverName)) {
        return res.status(400).json({ success: false, token: null, message: 'Invalid driver name' });
    }
    if (!vehicleId || !VEHICLE_ID_PATTERN.test(vehicleId)) {
        return res.status(400).json({
            success: false,
            token: null,
            message: 'Vehicle ID must be 1-32 characters (letters, digits, space, hyphen, underscore)'
        });
    }

    let vehicleType = typeof body.vehicleType === 'string' ? body.vehicleType.toUpperCase() : 'NORMAL';
    if (!VEHICLE_TYPES.has(vehicleType)) vehicleType = 'NORMAL';

    // Emergency status is granted by the server or not at all. A client asking
    // for it without a valid code is refused rather than silently downgraded,
    // so a driver never believes they have priority when they do not.
    let isEmergency = false;
    if (body.isEmergency === true || vehicleType !== 'NORMAL') {
        if (!isValidEmergencyCode(body.emergencyCode)) {
            logEvent(`AUTH DENIED: ${vehicleId} requested ${vehicleType} with an invalid code`);
            return res.status(403).json({
                success: false,
                token: null,
                message: 'Invalid emergency authorization code'
            });
        }
        isEmergency = true;
    }
    if (!isEmergency) vehicleType = 'NORMAL';

    const session = createSession({ vehicleId, driverName, vehicleType, isEmergency });

    logEvent(`AUTH OK: ${driverName} / ${vehicleId} [${vehicleType}]${isEmergency ? ' EMERGENCY GRANTED' : ''}`);

    res.json({
        success: true,
        token: session.token,
        isEmergency,
        vehicleType,
        message: 'Login successful'
    });
});

// ---------------------------------------------------------------------------
// Console dashboard
// ---------------------------------------------------------------------------
const activeVehicles = new Map(); // vehicleId -> validated telemetry
const dashboardClients = new Set();

const recentEvents = [];
function logEvent(message) {
    recentEvents.push(`[${new Date().toLocaleTimeString()}] ${message}`);
    if (recentEvents.length > 8) recentEvents.shift();
    printDashboard();
}

function printDashboard() {
    console.clear();
    console.log('============================= SUTRA LIVE TELEMETRY DASHBOARD =============================');
    console.log(`Active Vehicles: ${activeVehicles.size} | Dashboards: ${dashboardClients.size}`);
    console.log('-----------------------------------------------------------------------------------------');
    console.log(String('Driver').padEnd(15) + ' | ' +
                String('Vehicle ID').padEnd(15) + ' | ' +
                String('Type').padEnd(10) + ' | ' +
                String('Status').padEnd(15) + ' | ' +
                String('Location').padEnd(25) + ' | ' +
                String('Speed').padEnd(12) + ' | ' +
                String('Last Updated'));
    console.log('-----------------------------------------------------------------------------------------');

    activeVehicles.forEach((data) => {
        const statusStr = data.isEmergency ? '!! EMERGENCY !!' : 'NORMAL';
        const locStr = `${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}`;
        const speedStr = `${data.speed.toFixed(2)} km/h`;
        const timeStr = new Date(data.timestamp * 1000).toLocaleTimeString();

        console.log(String(data.driverName).padEnd(15) + ' | ' +
                    String(data.vehicleId).padEnd(15) + ' | ' +
                    String(data.type).padEnd(10) + ' | ' +
                    String(statusStr).padEnd(15) + ' | ' +
                    String(locStr).padEnd(25) + ' | ' +
                    String(speedStr).padEnd(12) + ' | ' +
                    timeStr);
    });
    console.log('=========================================================================================');

    if (recentEvents.length > 0) {
        console.log('Recent events:');
        recentEvents.forEach((line) => console.log('  ' + line));
    }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
// Two separate endpoints. Vehicles publish, dashboards subscribe; neither can
// do the other's job. This is also what stops the browser dashboard from
// registering itself as a vehicle simply by sending on its own socket.
const vehicleWss = new WebSocket.Server({ noServer: true });
const dashboardWss = new WebSocket.Server({ noServer: true });

function broadcastToDashboards(payload) {
    const message = JSON.stringify(payload);
    dashboardClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

server.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
        requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch (e) {
        socket.destroy();
        return;
    }

    if (requestUrl.pathname === '/vehicle/stream') {
        const session = getSession(requestUrl.searchParams.get('token'));
        if (!session) {
            logEvent('WS REJECTED: vehicle stream presented an invalid or expired token');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        vehicleWss.handleUpgrade(request, socket, head, (ws) => {
            vehicleWss.emit('connection', ws, request, session);
        });
        return;
    }

    if (requestUrl.pathname === '/dashboard/stream') {
        const key = requestUrl.searchParams.get('key');
        if (!OPERATOR_KEY || !key || !safeEquals(key, OPERATOR_KEY)) {
            logEvent('WS REJECTED: dashboard presented an invalid operator key');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        dashboardWss.handleUpgrade(request, socket, head, (ws) => {
            dashboardWss.emit('connection', ws, request);
        });
        return;
    }

    socket.destroy();
});

vehicleWss.on('connection', (ws, request, session) => {
    // One socket is bound to one session for its whole lifetime, so the vehicle
    // it represents cannot change mid-stream and leave a stale entry behind.
    logEvent(`VEHICLE CONNECTED: ${session.vehicleId} (${session.driverName})`);

    ws.on('message', (message) => {
        let raw;
        try {
            raw = JSON.parse(message);
        } catch (e) {
            return; // Unparseable frames are dropped silently.
        }

        const telemetry = validateTelemetry(raw, session);
        if (!telemetry) {
            logEvent(`DROPPED malformed telemetry from ${session.vehicleId}`);
            return;
        }

        activeVehicles.set(session.vehicleId, telemetry);
        printDashboard();
        broadcastToDashboards({ type: 'UPDATE', data: telemetry });
    });

    ws.on('close', () => {
        activeVehicles.delete(session.vehicleId);
        logEvent(`VEHICLE DISCONNECTED: ${session.vehicleId}`);
        broadcastToDashboards({ type: 'DISCONNECT', vehicleId: session.vehicleId });
    });

    ws.on('error', () => {
        // Socket-level errors are followed by 'close'; nothing to do here.
    });
});

dashboardWss.on('connection', (ws) => {
    dashboardClients.add(ws);
    logEvent('DASHBOARD CONNECTED');

    // Replay current state so a dashboard that joins late is not empty.
    activeVehicles.forEach((vehicleData) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'UPDATE', data: vehicleData }));
        }
    });

    // Dashboards are subscribers. Anything they send is ignored.
    ws.on('message', () => {});

    ws.on('close', () => {
        dashboardClients.delete(ws);
        logEvent('DASHBOARD DISCONNECTED');
    });

    ws.on('error', () => {
        dashboardClients.delete(ws);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mock Backend running on http://localhost:${PORT}`);
    console.log(`Vehicle stream:   ws://localhost:${PORT}/vehicle/stream?token=<login token>`);
    console.log(`Dashboard stream: ws://localhost:${PORT}/dashboard/stream?key=<operator key>`);
    console.log('\nWaiting for vehicle connection...');
});
