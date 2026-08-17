// SUTRA operator dashboard.
//
// Rendering rule for this file: telemetry arrives from the network and is
// therefore untrusted. Nothing from a payload is ever concatenated into an HTML
// string or an inline attribute. Use el(), text nodes, and addEventListener.

const CONFIG = window.SUTRA_CONFIG || {};

let map;
const vehicleMarkers = new Map();
const routePolylines = new Map();
const bypassPolylines = new Map();
const congestionCircles = new Map();

let wsConnection;          // dashboard subscriber socket
let simSocket = null;      // simulator's own vehicle socket
let reconnectTimer = null;

// State management
let activeVehicles = new Map();
let selectedVehicleId = null;
let speedingViolationsCount = 0;

// Speeding is logged once per episode, not once per frame. Telemetry arrives at
// 1 Hz, so counting every frame turned a single vehicle speeding for a minute
// into 60 "tickets" and made the counter meaningless.
const SPEED_LIMIT_KMH = 80;
// A vehicle must drop this far below the limit before a new episode can start,
// so hovering at 80 km/h does not flap the counter.
const SPEED_CLEAR_KMH = 75;
const speedingVehicles = new Set();

// Cap on rendered log entries. The feed previously grew without bound.
const MAX_LOG_ITEMS = 200;
let simulationInterval = null;
let simIndex = 0;
let isSimulating = false;
let isGlobalOptimizerActive = false;

// Predefined Dark Theme Styles for Google Maps
const darkMapStyle = [
    { elementType: "geometry", stylers: [{ color: "#0b0f19" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#0b0f19" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#7b8a9b" }] },
    {
        featureType: "administrative",
        elementType: "geometry.stroke",
        stylers: [{ color: "#1f293d" }]
    },
    {
        featureType: "landscape.natural",
        elementType: "geometry",
        stylers: [{ color: "#0d1324" }]
    },
    {
        featureType: "poi",
        elementType: "geometry",
        stylers: [{ color: "#0d1324" }]
    },
    {
        featureType: "poi",
        elementType: "labels.text.fill",
        stylers: [{ color: "#4b5b75" }]
    },
    {
        featureType: "road",
        elementType: "geometry",
        stylers: [{ color: "#161d30" }]
    },
    {
        featureType: "road",
        elementType: "geometry.stroke",
        stylers: [{ color: "#0d1324" }]
    },
    {
        featureType: "road",
        elementType: "labels.text.fill",
        stylers: [{ color: "#8a9ab0" }]
    },
    {
        featureType: "road.highway",
        elementType: "geometry",
        stylers: [{ color: "#1f2d47" }]
    },
    {
        featureType: "road.highway",
        elementType: "geometry.stroke",
        stylers: [{ color: "#0f1826" }]
    },
    {
        featureType: "transit",
        elementType: "geometry",
        stylers: [{ color: "#0e1526" }]
    },
    {
        featureType: "water",
        elementType: "geometry",
        stylers: [{ color: "#05070d" }]
    }
];

// ---------------------------------------------------------------------------
// Safe DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create an element. `props.text` is set via textContent, never innerHTML, so
 * any value passed here is inert regardless of what it contains.
 */
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    if (props.className) node.className = props.className;
    if (props.id) node.id = props.id;
    if (props.text !== undefined) node.textContent = String(props.text);
    if (props.style) Object.assign(node.style, props.style);
    for (const child of children) {
        if (child) node.appendChild(child);
    }
    return node;
}

function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

// A labelled value pair, e.g. "Driver: Amit Sharma" with the value in bold.
function labelled(label, value, valueClass) {
    return el("span", {}, [
        document.createTextNode(label + " "),
        el("strong", { text: value, className: valueClass || "" })
    ]);
}

function numberOr(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// The Maps library is injected at runtime so the API key lives in config.js
// (gitignored) rather than in the committed HTML.
function loadGoogleMaps() {
    if (!CONFIG.MAPS_API_KEY || CONFIG.MAPS_API_KEY.startsWith("REPLACE_")) {
        showBootError(
            "Google Maps API key missing. Copy admin-dashboard/config.example.js " +
            "to config.js and set MAPS_API_KEY."
        );
        return;
    }
    const script = document.createElement("script");
    script.src =
        "https://maps.googleapis.com/maps/api/js?key=" +
        encodeURIComponent(CONFIG.MAPS_API_KEY) +
        "&libraries=geometry&callback=initMap";
    script.async = true;
    script.defer = true;
    script.onerror = () => showBootError("Failed to load the Google Maps library.");
    document.head.appendChild(script);
}

function showBootError(message) {
    const mapEl = document.getElementById("map");
    if (mapEl) {
        clear(mapEl);
        mapEl.appendChild(
            el("div", {
                text: message,
                style: {
                    padding: "24px",
                    color: "#ff4d5a",
                    fontFamily: "monospace",
                    fontSize: "13px",
                    lineHeight: "1.6"
                }
            })
        );
    }
    logSystemMessage(message, "error");
}

// Initialize Google Maps
function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 12.9716, lng: 77.5946 }, // Bangalore
        zoom: 14,
        styles: darkMapStyle,
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false
    });

    logSystemMessage("Google Map initialized with cyber-dark control theme.");
    connectWebSocket();
}

// ---------------------------------------------------------------------------
// WebSocket Connection Management
// ---------------------------------------------------------------------------

function backendHost() {
    return CONFIG.BACKEND_HOST || "localhost:3000";
}

// The dashboard is a subscriber. It authenticates with the operator key and
// connects to /dashboard/stream, which is a separate endpoint from the one
// vehicles publish on — so the dashboard can never register itself as a vehicle.
function connectWebSocket() {
    if (!CONFIG.OPERATOR_KEY) {
        showBootError("OPERATOR_KEY missing from config.js. Cannot subscribe to telemetry.");
        return;
    }

    const wsUrl =
        "ws://" + backendHost() + "/dashboard/stream?key=" + encodeURIComponent(CONFIG.OPERATOR_KEY);
    updateConnectionUI(false, "CONNECTING...");

    wsConnection = new WebSocket(wsUrl);

    wsConnection.onopen = () => {
        updateConnectionUI(true, "CONNECTED");
        logSystemMessage("Telemetry WebSocket stream connected successfully.");
    };

    wsConnection.onclose = (event) => {
        updateConnectionUI(false, "DISCONNECTED");
        // 1006 with no prior open is the browser's report of a rejected upgrade,
        // which for this endpoint means the operator key was refused.
        if (event.code === 1006) {
            logSystemMessage(
                "Stream closed. If this repeats, check that OPERATOR_KEY in config.js " +
                "matches backend-mock/.env. Retrying in 3s...",
                "error"
            );
        } else {
            logSystemMessage("WebSocket stream disconnected. Retrying in 3s...", "error");
        }
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 3000);
    };

    wsConnection.onerror = () => {
        logSystemMessage("WebSocket connection error. Checking server status...", "error");
    };

    wsConnection.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            handleTelemetryMessage(payload);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    };
}

// Handle incoming WebSocket messages
function handleTelemetryMessage(payload) {
    if (!payload || typeof payload !== "object") return;

    if (payload.type === "UPDATE") {
        const vehicle = payload.data;
        // The server validates before broadcasting, but the dashboard does not
        // assume that: a shape check here keeps one bad frame from taking the
        // whole render path down.
        if (!vehicle || typeof vehicle.vehicleId !== "string") return;
        if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lng)) return;
        vehicle.speed = numberOr(vehicle.speed, 0);

        activeVehicles.set(vehicle.vehicleId, vehicle);

        updateVehicleOnMap(vehicle);
        updateVehicleList();
        updateSystemAnalytics();

        // Rules check: log the transition into a speeding episode, not each
        // frame spent in one.
        if (vehicle.speed > SPEED_LIMIT_KMH) {
            if (!speedingVehicles.has(vehicle.vehicleId)) {
                speedingVehicles.add(vehicle.vehicleId);
                logSpeedViolation(vehicle);
            }
        } else if (vehicle.speed < SPEED_CLEAR_KMH) {
            speedingVehicles.delete(vehicle.vehicleId);
        }

        // Alerts check: Emergency message
        if (vehicle.isEmergency && vehicle.alertMessage) {
            triggerEmergencyBanner(vehicle);
            logEmergencyAlert(vehicle);
        }
    } else if (payload.type === "DISCONNECT") {
        const vehicleId = payload.vehicleId;
        if (typeof vehicleId !== "string") return;
        removeVehicleFromMap(vehicleId);
        activeVehicles.delete(vehicleId);
        speedingVehicles.delete(vehicleId);
        if (selectedVehicleId === vehicleId) selectedVehicleId = null;
        updateVehicleList();
        updateSystemAnalytics();
        logSystemMessage("Vehicle " + vehicleId + " disconnected from network.");
    }
}

// ---------------------------------------------------------------------------
// Map rendering
// ---------------------------------------------------------------------------

function updateVehicleOnMap(vehicle) {
    if (!map) return;
    const position = { lat: vehicle.lat, lng: vehicle.lng };

    const markerColor = vehicle.isEmergency ? "red" : "green";
    const iconUrl = `https://maps.google.com/mapfiles/ms/icons/${markerColor}-dot.png`;

    // 1. Vehicle Marker
    if (vehicleMarkers.has(vehicle.vehicleId)) {
        const marker = vehicleMarkers.get(vehicle.vehicleId);
        marker.setPosition(position);

        if (selectedVehicleId === vehicle.vehicleId) {
            map.panTo(position);
        }
    } else {
        const marker = new google.maps.Marker({
            position: position,
            map: map,
            title: `${vehicle.driverName} (${vehicle.vehicleId})`,
            icon: iconUrl
        });

        // InfoWindow content is built as a DOM node rather than an HTML string,
        // so a driver name containing markup renders as literal text.
        const infoContent = el("div", {
            style: { color: "#0b0f19", fontFamily: "sans-serif", fontSize: "13px" }
        });
        const infoSpeed = el("div");
        infoContent.appendChild(labelled("Driver:", vehicle.driverName));
        infoContent.appendChild(el("br"));
        infoContent.appendChild(labelled("ID:", vehicle.vehicleId));
        infoContent.appendChild(el("br"));
        infoContent.appendChild(infoSpeed);
        infoContent.appendChild(
            labelled("Status:", vehicle.isEmergency ? "EMERGENCY" : "NORMAL")
        );

        const infoWindow = new google.maps.InfoWindow({ content: infoContent });

        marker.addListener("click", () => {
            // Refresh the speed line from current state each time it opens.
            const current = activeVehicles.get(vehicle.vehicleId) || vehicle;
            clear(infoSpeed);
            infoSpeed.appendChild(labelled("Speed:", current.speed.toFixed(1) + " km/h"));
            infoWindow.open(map, marker);
            selectVehicleCard(vehicle.vehicleId);
        });

        vehicleMarkers.set(vehicle.vehicleId, marker);
        logSystemMessage(
            "New vehicle connected: " + vehicle.vehicleId + " [" + vehicle.type + "]"
        );
    }

    // 2. Active Routing Polyline (if destination set)
    // NOTE (mock): a straight line to the destination, not a road-following
    // route. The road geometry lives in the Android client's Directions call.
    if (Number.isFinite(vehicle.destinationLat) && Number.isFinite(vehicle.destinationLng)) {
        const pathCoordinates = [
            position,
            { lat: vehicle.destinationLat, lng: vehicle.destinationLng }
        ];

        if (routePolylines.has(vehicle.vehicleId)) {
            routePolylines.get(vehicle.vehicleId).setPath(pathCoordinates);
        } else {
            const polyline = new google.maps.Polyline({
                path: pathCoordinates,
                geodesic: true,
                strokeColor: vehicle.isEmergency ? "#ff4d5a" : "#00f2fe",
                strokeOpacity: 0.8,
                strokeWeight: 6,
                map: map
            });
            routePolylines.set(vehicle.vehicleId, polyline);
        }
    } else {
        if (routePolylines.has(vehicle.vehicleId)) {
            routePolylines.get(vehicle.vehicleId).setMap(null);
            routePolylines.delete(vehicle.vehicleId);
        }
    }

    // 3. Congestion zone.
    // NOTE (mock): this is a single-vehicle speed threshold, not congestion
    // detection. One vehicle stopped at a red light will trigger it.
    if (!vehicle.isEmergency && vehicle.speed < 15 && vehicle.speed > 0) {
        if (congestionCircles.has(vehicle.vehicleId)) {
            congestionCircles.get(vehicle.vehicleId).setCenter(position);
        } else {
            const circle = new google.maps.Circle({
                strokeColor: "#ff4d5a",
                strokeOpacity: 0.5,
                strokeWeight: 1,
                fillColor: "#ff4d5a",
                fillOpacity: 0.25,
                map: map,
                center: position,
                radius: 200 // 200 meters
            });
            congestionCircles.set(vehicle.vehicleId, circle);
            logSystemMessage(
                "[MOCK] Low-speed flag (single-vehicle threshold) at " +
                position.lat.toFixed(5) + ", " + position.lng.toFixed(5) +
                " (Speed: " + vehicle.speed.toFixed(1) + " km/h)"
            );
        }
    } else {
        if (congestionCircles.has(vehicle.vehicleId)) {
            congestionCircles.get(vehicle.vehicleId).setMap(null);
            congestionCircles.delete(vehicle.vehicleId);
        }
    }

    // 4. Bypass overlay.
    // NOTE (mock): a fixed ~200 m offset from the midpoint. There is no routing
    // engine, no traffic data and no optimisation behind this line.
    if (
        isGlobalOptimizerActive &&
        Number.isFinite(vehicle.destinationLat) &&
        Number.isFinite(vehicle.destinationLng)
    ) {
        const bypassCoordinates = [
            position,
            {
                lat: (position.lat + vehicle.destinationLat) / 2 + 0.002,
                lng: (position.lng + vehicle.destinationLng) / 2 - 0.002
            },
            { lat: vehicle.destinationLat, lng: vehicle.destinationLng }
        ];

        if (bypassPolylines.has(vehicle.vehicleId)) {
            bypassPolylines.get(vehicle.vehicleId).setPath(bypassCoordinates);
        } else {
            const polyline = new google.maps.Polyline({
                path: bypassCoordinates,
                geodesic: true,
                strokeColor: "#ffa502",
                strokeOpacity: 0.7,
                strokeWeight: 4,
                icons: [{
                    icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
                    offset: '0',
                    repeat: '20px'
                }],
                map: map
            });
            bypassPolylines.set(vehicle.vehicleId, polyline);
        }
    } else {
        if (bypassPolylines.has(vehicle.vehicleId)) {
            bypassPolylines.get(vehicle.vehicleId).setMap(null);
            bypassPolylines.delete(vehicle.vehicleId);
        }
    }
}

// Remove Vehicle from Map
function removeVehicleFromMap(vehicleId) {
    for (const store of [vehicleMarkers, routePolylines, congestionCircles, bypassPolylines]) {
        if (store.has(vehicleId)) {
            store.get(vehicleId).setMap(null);
            store.delete(vehicleId);
        }
    }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function updateVehicleList() {
    const listEl = document.getElementById("vehicle-list");
    const countEl = document.getElementById("vehicle-count");

    countEl.textContent = `${activeVehicles.size} Active`;
    clear(listEl);

    if (activeVehicles.size === 0) {
        listEl.appendChild(
            el("p", {
                className: "text-secondary",
                text: "No vehicles online. Start the APK client to stream telemetry.",
                style: { textAlign: "center", padding: "20px", fontSize: "12px" }
            })
        );
        return;
    }

    activeVehicles.forEach((vehicle) => {
        const isEmergency = Boolean(vehicle.isEmergency);
        const classes = [
            "vehicle-card",
            "glass-panel",
            isEmergency ? "emergency" : "normal",
            selectedVehicleId === vehicle.vehicleId ? "active-selected" : ""
        ].filter(Boolean).join(" ");

        const card = el("div", { className: classes });
        // Identity is carried on a dataset attribute and read by a delegated
        // listener, replacing the old inline onclick that interpolated the ID
        // straight into an attribute.
        card.dataset.vehicleId = vehicle.vehicleId;

        const top = el("div", { className: "card-top" }, [
            el("span", { className: "vehicle-title", text: vehicle.vehicleId }),
            el("span", {
                className: "vehicle-type-tag" + (isEmergency ? " emergency-tag" : ""),
                text: vehicle.type || "NORMAL"
            })
        ]);

        const details = el("div", { className: "card-details" }, [
            labelled("Driver:", vehicle.driverName || "-"),
            labelled(
                "Speed:",
                vehicle.speed.toFixed(0) + " km/h",
                "stat-value" + (vehicle.speed > SPEED_LIMIT_KMH ? " speeding" : "")
            )
        ]);

        card.appendChild(top);
        card.appendChild(details);
        listEl.appendChild(card);
    });
}

function focusVehicle(vehicleId) {
    selectVehicleCard(vehicleId);

    const vehicle = activeVehicles.get(vehicleId);
    if (vehicle && map) {
        map.setZoom(16);
        map.panTo({ lat: vehicle.lat, lng: vehicle.lng });
    }
}

function selectVehicleCard(vehicleId) {
    selectedVehicleId = vehicleId;
    document.querySelectorAll(".vehicle-card").forEach((card) => {
        card.classList.toggle("active-selected", card.dataset.vehicleId === vehicleId);
    });
}

// Connection State UI Helper
function updateConnectionUI(connected, text) {
    const dot = document.getElementById("status-dot");
    const textEl = document.getElementById("status-text");

    dot.classList.toggle("connected", connected);
    textEl.textContent = text;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

function updateSystemAnalytics() {
    if (activeVehicles.size === 0) {
        document.getElementById("avg-speed-value").textContent = "0 km/h";
        document.getElementById("avg-speed-bar").style.width = "0%";
        return;
    }

    let totalSpeed = 0;
    activeVehicles.forEach((v) => {
        totalSpeed += v.speed;
    });
    const avgSpeed = totalSpeed / activeVehicles.size;

    document.getElementById("avg-speed-value").textContent = `${avgSpeed.toFixed(1)} km/h`;

    // Cap average speed display bar at 120 km/h for gauge logic
    const pct = Math.min((avgSpeed / 120) * 100, 100);
    document.getElementById("avg-speed-bar").style.width = `${pct}%`;

    // NOTE (mock): this gauge is a placeholder driven by vehicle count. No
    // latency is measured anywhere in the system.
    const latencyBar = document.getElementById("latency-bar");
    const latencyValue = document.getElementById("latency-value");
    if (activeVehicles.size > 3) {
        latencyBar.style.backgroundColor = "var(--orange-neon)";
        latencyBar.style.width = "75%";
        latencyValue.textContent = "78% (placeholder)";
    } else {
        latencyBar.style.backgroundColor = "var(--green-neon)";
        latencyBar.style.width = "98%";
        latencyValue.textContent = "98% (placeholder)";
    }
}

// Toggle the bypass overlay. Draws alternative lines; does not reroute anything.
function toggleGlobalOptimizer() {
    const btn = document.getElementById("optimizer-btn");
    isGlobalOptimizerActive = !isGlobalOptimizerActive;

    if (isGlobalOptimizerActive) {
        btn.textContent = "Hide Bypass Overlay";
        btn.classList.add("btn-active");
        logSystemMessage("[MOCK] Bypass overlay shown. No vehicle is actually rerouted.");
    } else {
        btn.textContent = "Show Bypass Overlay (Mock)";
        btn.classList.remove("btn-active");
        logSystemMessage("[MOCK] Bypass overlay hidden.");
    }

    activeVehicles.forEach((vehicle) => {
        updateVehicleOnMap(vehicle);
    });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function logsContainer() {
    return document.getElementById("violation-logs");
}

function pushLogItem(node) {
    const logsEl = logsContainer();
    if (!logsEl) return;
    const placeholder = logsEl.querySelector(".text-secondary");
    if (placeholder) clear(logsEl);
    logsEl.insertBefore(node, logsEl.firstChild);

    // Newest first, so trimming from the end drops the oldest entries.
    while (logsEl.childElementCount > MAX_LOG_ITEMS) {
        logsEl.removeChild(logsEl.lastElementChild);
    }
}

function logSpeedViolation(vehicle) {
    speedingViolationsCount++;
    document.getElementById("speeding-count-stat").textContent = speedingViolationsCount;

    const timeStr = new Date().toLocaleTimeString();

    const body = el("div", {}, [
        el("strong", { text: "🚨 CRITICAL SPEED VIOLATION" }),
        el("br"),
        document.createTextNode("Vehicle "),
        el("strong", { text: vehicle.vehicleId }),
        document.createTextNode(" (Driver: " + (vehicle.driverName || "-") + ") clocked at "),
        el("span", {
            text: vehicle.speed.toFixed(0) + " km/h",
            style: { color: "var(--red-neon)", fontWeight: "bold" }
        }),
        document.createTextNode(
            ` (Limit: ${SPEED_LIMIT_KMH} km/h) at location: ` +
            vehicle.lat.toFixed(5) + ", " + vehicle.lng.toFixed(5) + "."
        )
    ]);

    const meta = el("div", {
        style: {
            textAlign: "right",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            alignItems: "flex-end"
        }
    }, [
        el("span", { className: "log-time", text: timeStr }),
        el("span", { className: "police-dispatch-badge", text: "MOCK DISPATCH" })
    ]);

    pushLogItem(el("div", { className: "log-item speed-violation" }, [body, meta]));

    // NOTE (mock): nothing is transmitted to any police system. The block below
    // is a locally generated illustration of what such a response might look
    // like, with a randomly chosen ticket number and officer name.
    const ticketId = "TK-" + Math.floor(100000 + Math.random() * 900000);
    const officerList = ["Inspector S. Patel", "Sergeant A. Rawat", "Officer K. Rao", "Inspector M. Kumar"];
    const patrolUnits = ["Patrol Unit Sector 4", "Interceptor Vehicle 12", "Highway Patrol Alpha", "City Command Unit 2"];

    const mockResponse = {
        _mock: true,
        _note: "Generated in-browser. No request is sent and no such endpoint is contacted.",
        status: "VIOLATION_RECORDED (SIMULATED)",
        simulated_endpoint: "(none - illustrative only)",
        timestamp: new Date().toISOString(),
        dispatched: false,
        incident_data: {
            ticket_number: ticketId,
            vehicle_number: vehicle.vehicleId,
            driver: vehicle.driverName,
            offense: "SPEED_LIMIT_EXCEEDED",
            speed_recorded: `${vehicle.speed.toFixed(1)} km/h`,
            speed_limit: `${SPEED_LIMIT_KMH}.0 km/h`,
            location: {
                latitude: vehicle.lat,
                longitude: vehicle.lng
            }
        },
        responder_dispatch: {
            unit_name: patrolUnits[Math.floor(Math.random() * patrolUnits.length)],
            assigned_officer: officerList[Math.floor(Math.random() * officerList.length)],
            dispatch_eta: "6-8 mins",
            command: "INTERCEPT_AND_ISSUE_TICKET"
        }
    };

    const feedEl = document.getElementById("police-api-feed");
    if (feedEl) {
        feedEl.textContent = JSON.stringify(mockResponse, null, 2);
    }
}

// Emergency Banner & Alerts
function triggerEmergencyBanner(vehicle) {
    const banner = document.getElementById("emergency-banner");
    document.getElementById("emergency-banner-title").textContent =
        `🚨 EMERGENCY Broadcast - ${vehicle.type} IN TRANSIT`;
    document.getElementById("emergency-banner-text").textContent =
        `Vehicle: ${vehicle.vehicleId} (Driver: ${vehicle.driverName}) has requested ` +
        `clear-path routing. Alert Message: "${vehicle.alertMessage}"`;
    banner.classList.add("show");
}

function dismissEmergencyBanner() {
    document.getElementById("emergency-banner").classList.remove("show");
}

function logEmergencyAlert(vehicle) {
    const dispatchEl = document.getElementById("emergency-dispatch-details");
    const timeStr = new Date().toLocaleTimeString();

    clear(dispatchEl);
    dispatchEl.appendChild(
        el("div", { style: { lineHeight: "1.5" } }, [
            labelled("Vehicle ID:", vehicle.vehicleId), el("br"),
            labelled("Type:", vehicle.type), el("br"),
            labelled("Driver:", vehicle.driverName), el("br"),
            document.createTextNode("Alert: "),
            el("span", {
                text: vehicle.alertMessage,
                style: { color: "var(--red-neon)", fontWeight: "bold" }
            }),
            el("br"),
            labelled("Time:", timeStr)
        ])
    );

    // NOTE (mock): no signal controller is contacted and no corridor is cleared.
    const body = el("div", {}, [
        el("strong", { text: "🏥 [MOCK] CORRIDOR NOTICE" }),
        el("br"),
        document.createTextNode(
            "Illustrative only - no traffic signal is contacted and no corridor is " +
            "cleared for " + vehicle.vehicleId + "."
        )
    ]);

    pushLogItem(
        el("div", { className: "log-item emergency-alert" }, [
            body,
            el("span", { className: "log-time", text: timeStr })
        ])
    );
}

// Logging System Utility
function logSystemMessage(message, type = "info") {
    const logsEl = logsContainer();
    if (!logsEl) return;

    const isError = type === "error";
    const body = el("div", {}, [
        el("strong", { text: isError ? "⚠️ SYSTEM ERROR" : "🤖 SYSTEM CHECK" }),
        el("br"),
        document.createTextNode(String(message))
    ]);

    pushLogItem(
        el("div", { className: "log-item " + (isError ? "speed-violation" : "system-info") }, [
            body,
            el("span", { className: "log-time", text: new Date().toLocaleTimeString() })
        ])
    );
}

// ---------------------------------------------------------------------------
// Browser client simulator
// ---------------------------------------------------------------------------
// The simulator behaves like a real vehicle client: it logs in over REST and
// opens its own socket on /vehicle/stream. Its frames come back through the
// normal dashboard subscription, so there is no local echo to special-case.

function toggleSimType() {
    const typeSelect = document.getElementById("sim-vehicle-type");
    const alertInput = document.getElementById("sim-alert-message");
    const codeInput = document.getElementById("sim-emergency-code");
    const isEmergency = typeSelect.value !== "NORMAL";

    alertInput.disabled = !isEmergency;
    if (codeInput) codeInput.disabled = !isEmergency;
}

const SIM_PATH = [
    { lat: 12.9716, lng: 77.5946 },
    { lat: 12.9723, lng: 77.5950 },
    { lat: 12.9732, lng: 77.5955 },
    { lat: 12.9744, lng: 77.5961 },
    { lat: 12.9750, lng: 77.5969 },
    { lat: 12.9757, lng: 77.5978 },
    { lat: 12.9760, lng: 77.5990 },
    { lat: 12.9758, lng: 77.6002 },
    { lat: 12.9753, lng: 77.6012 },
    { lat: 12.9743, lng: 77.6020 },
    { lat: 12.9732, lng: 77.6018 },
    { lat: 12.9721, lng: 77.6010 },
    { lat: 12.9713, lng: 77.6000 },
    { lat: 12.9706, lng: 77.5989 },
    { lat: 12.9701, lng: 77.5976 },
    { lat: 12.9698, lng: 77.5963 },
    { lat: 12.9702, lng: 77.5951 },
    { lat: 12.9709, lng: 77.5944 }
];

function simLog(line) {
    const coordDisplay = document.getElementById("sim-coordinate-display");
    coordDisplay.textContent += line + "\n";
    coordDisplay.scrollTop = coordDisplay.scrollHeight;
}

async function toggleSimulatorEngine() {
    if (isSimulating) {
        stopSimulator();
        return;
    }

    const startBtn = document.getElementById("sim-start-btn");
    const coordDisplay = document.getElementById("sim-coordinate-display");

    const vehicleId = document.getElementById("sim-vehicle-id").value.trim();
    const driverName = document.getElementById("sim-driver-name").value.trim();
    const type = document.getElementById("sim-vehicle-type").value;
    const isEmergency = type !== "NORMAL";
    const emergencyCode = isEmergency
        ? document.getElementById("sim-emergency-code").value.trim()
        : null;

    startBtn.disabled = true;
    coordDisplay.textContent = "=== Authenticating ===\n";

    let token;
    try {
        const res = await fetch("http://" + backendHost() + "/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: driverName,
                vehicleId: vehicleId,
                vehicleType: type,
                isEmergency: isEmergency,
                emergencyCode: emergencyCode
            })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            simLog("LOGIN FAILED: " + (data.message || res.status));
            logSystemMessage("Simulator login rejected: " + (data.message || res.status), "error");
            startBtn.disabled = false;
            return;
        }
        token = data.token;
        simLog("Login OK. Emergency granted: " + Boolean(data.isEmergency));
    } catch (e) {
        simLog("LOGIN ERROR: backend unreachable.");
        logSystemMessage("Simulator could not reach the backend for login.", "error");
        startBtn.disabled = false;
        return;
    }

    simSocket = new WebSocket(
        "ws://" + backendHost() + "/vehicle/stream?token=" + encodeURIComponent(token)
    );

    simSocket.onopen = () => {
        isSimulating = true;
        simIndex = 0;
        startBtn.disabled = false;
        startBtn.textContent = "Stop Browser Simulation";
        startBtn.style.background = "var(--red-neon)";
        simLog("=== Simulation Started ===");
        logSystemMessage("Browser-side vehicle simulation active as " + vehicleId + ".");

        simulationInterval = setInterval(() => {
            if (!simSocket || simSocket.readyState !== WebSocket.OPEN) return;

            const speed = parseFloat(document.getElementById("sim-speed").value) || 0;
            const alertMessage = isEmergency
                ? document.getElementById("sim-alert-message").value
                : null;
            const point = SIM_PATH[simIndex];

            // Identity fields are ignored by the server, which uses the session
            // bound to this token. They are sent only to match the real client's
            // payload shape.
            simSocket.send(JSON.stringify({
                vehicleId: vehicleId,
                driverName: driverName,
                type: type,
                lat: point.lat,
                lng: point.lng,
                speed: speed,
                direction: 90.0,
                timestamp: Math.floor(Date.now() / 1000),
                isEmergency: isEmergency,
                destinationLat: isEmergency ? 12.9760 : null,
                destinationLng: isEmergency ? 77.6010 : null,
                destinationName: isEmergency ? "City General Hospital" : null,
                alertMessage: alertMessage
            }));

            simLog(
                `[${new Date().toLocaleTimeString()}] Sent: Lat: ${point.lat.toFixed(5)}, ` +
                `Lng: ${point.lng.toFixed(5)}, Speed: ${speed.toFixed(0)} km/h`
            );

            simIndex = (simIndex + 1) % SIM_PATH.length;
        }, 1000);
    };

    simSocket.onclose = () => {
        if (isSimulating) {
            simLog("=== Socket closed by server ===");
            stopSimulator();
        } else {
            startBtn.disabled = false;
        }
    };

    simSocket.onerror = () => {
        simLog("Vehicle socket error - token may have been rejected.");
    };
}

function stopSimulator() {
    const startBtn = document.getElementById("sim-start-btn");
    isSimulating = false;
    clearInterval(simulationInterval);
    simulationInterval = null;

    if (simSocket) {
        const socket = simSocket;
        simSocket = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, "Simulation stopped");
        }
    }

    startBtn.disabled = false;
    startBtn.textContent = "Start Browser Simulation";
    startBtn.style.background = "var(--cyan-neon)";
    simLog("=== Simulation Stopped ===");
    logSystemMessage("Browser-side vehicle simulation stopped.");
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function switchTab(tabId) {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabId);
    });

    const dashboard = document.querySelector(".dashboard-grid");
    if (dashboard) {
        dashboard.classList.remove(
            "focus-all", "focus-map", "focus-emergency", "focus-violations", "focus-simulator"
        );
        dashboard.classList.add("focus-" + tabId.replace("-tab", ""));
    }

    const filterName = tabId
        .replace("-tab", "")
        .toUpperCase()
        .replace("MAP", "TRAFFIC")
        .replace("ALL", "ALL SYSTEMS");
    logSystemMessage(`Command Center switched focus to: ${filterName}`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    // Delegated click handling replaces the inline onclick attributes that
    // previously interpolated vehicle IDs into markup.
    document.getElementById("vehicle-list").addEventListener("click", (event) => {
        const card = event.target.closest(".vehicle-card");
        if (card && card.dataset.vehicleId) {
            focusVehicle(card.dataset.vehicleId);
        }
    });

    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.getElementById("optimizer-btn").addEventListener("click", toggleGlobalOptimizer);
    document.getElementById("sim-start-btn").addEventListener("click", toggleSimulatorEngine);
    document.getElementById("sim-vehicle-type").addEventListener("change", toggleSimType);
    document.querySelector(".alert-close-btn").addEventListener("click", dismissEmergencyBanner);

    loadGoogleMaps();
});

// initMap is referenced by the Maps loader callback, which resolves off window.
window.initMap = initMap;
