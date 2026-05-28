let map;
const vehicleMarkers = new Map();
const routePolylines = new Map();
const bypassPolylines = new Map();
const congestionCircles = new Map();
const serviceMarkers = [];
let wsConnection;

// State management
let activeVehicles = new Map();
let speedingViolationsCount = 0;
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

// WebSocket Connection Management
function connectWebSocket() {
    const wsUrl = "ws://localhost:3000/vehicle/stream";
    updateConnectionUI(false, "CONNECTING...");
    
    wsConnection = new WebSocket(wsUrl);
    
    wsConnection.onopen = () => {
        updateConnectionUI(true, "CONNECTED");
        logSystemMessage("Telemetry WebSocket stream connected successfully.");
    };
    
    wsConnection.onclose = () => {
        updateConnectionUI(false, "DISCONNECTED");
        logSystemMessage("WebSocket stream disconnected. Retrying in 3s...", "error");
        setTimeout(connectWebSocket, 3000);
    };
    
    wsConnection.onerror = (err) => {
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
    if (payload.type === "UPDATE") {
        const vehicle = payload.data;
        activeVehicles.set(vehicle.vehicleId, vehicle);
        
        updateVehicleOnMap(vehicle);
        updateVehicleList();
        updateSystemAnalytics();
        
        // Rules Check: Speeding limit = 80 km/h
        if (vehicle.speed > 80) {
            logSpeedViolation(vehicle);
        }
        
        // Alerts check: Emergency message
        if (vehicle.isEmergency && vehicle.alertMessage) {
            triggerEmergencyBanner(vehicle);
            logEmergencyAlert(vehicle);
        }
    } else if (payload.type === "DISCONNECT") {
        const vehicleId = payload.vehicleId;
        removeVehicleFromMap(vehicleId);
        activeVehicles.delete(vehicleId);
        updateVehicleList();
        updateSystemAnalytics();
        logSystemMessage(`Vehicle ${vehicleId} disconnected from network.`);
    }
}

// Update or draw markers & polylines
function updateVehicleOnMap(vehicle) {
    const position = { lat: vehicle.lat, lng: vehicle.lng };
    
    // Icon Configuration
    let markerColor = "green";
    if (vehicle.isEmergency) {
        markerColor = "red";
    }
    
    const iconUrl = `https://maps.google.com/mapfiles/ms/icons/${markerColor}-dot.png`;

    // 1. Vehicle Marker
    if (vehicleMarkers.has(vehicle.vehicleId)) {
        const marker = vehicleMarkers.get(vehicle.vehicleId);
        marker.setPosition(position);
        
        // Smoothly pan map if selected
        if (document.getElementById(`card-${vehicle.vehicleId}`)?.classList.contains("active-selected")) {
            map.panTo(position);
        }
    } else {
        const marker = new google.maps.Marker({
            position: position,
            map: map,
            title: `${vehicle.driverName} (${vehicle.vehicleId})`,
            icon: iconUrl
        });
        
        const infoWindow = new google.maps.InfoWindow({
            content: `
                <div style="color: #0b0f19; font-family: sans-serif; font-size: 13px;">
                    <strong>Driver:</strong> ${vehicle.driverName}<br>
                    <strong>ID:</strong> ${vehicle.vehicleId}<br>
                    <strong>Speed:</strong> ${vehicle.speed.toFixed(1)} km/h<br>
                    <strong>Status:</strong> ${vehicle.isEmergency ? 'EMERGENCY' : 'NORMAL'}
                </div>
            `
        });
        
        marker.addListener("click", () => {
            infoWindow.open(map, marker);
            selectVehicleCard(vehicle.vehicleId);
        });
        
        vehicleMarkers.set(vehicle.vehicleId, marker);
        logSystemMessage(`New vehicle connected: ${vehicle.vehicleId} [${vehicle.type}]`);
    }

    // 2. Active Routing Polyline (if destination set)
    if (vehicle.destinationLat && vehicle.destinationLng) {
        // Build mock polyline from vehicle position to destination for visual display
        const pathCoordinates = [
            position,
            { lat: vehicle.destinationLat, lng: vehicle.destinationLng }
        ];

        if (routePolylines.has(vehicle.vehicleId)) {
            const polyline = routePolylines.get(vehicle.vehicleId);
            polyline.setPath(pathCoordinates);
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
        // Clear polyline if no destination
        if (routePolylines.has(vehicle.vehicleId)) {
            routePolylines.get(vehicle.vehicleId).setMap(null);
            routePolylines.delete(vehicle.vehicleId);
        }
    }

    // 3. Dynamic Congestion Zone Circle (Speed < 15 km/h for normal vehicles)
    if (!vehicle.isEmergency && vehicle.speed < 15 && vehicle.speed > 0) {
        if (congestionCircles.has(vehicle.vehicleId)) {
            const circle = congestionCircles.get(vehicle.vehicleId);
            circle.setCenter(position);
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
            logSystemMessage(`⚠️ Traffic Bottleneck detected at ${position.lat.toFixed(5)}, ${position.lng.toFixed(5)} (Speed: ${vehicle.speed.toFixed(1)} km/h)`);
        }
    } else {
        // Clear congestion zone if speed increases or vehicle is emergency
        if (congestionCircles.has(vehicle.vehicleId)) {
            congestionCircles.get(vehicle.vehicleId).setMap(null);
            congestionCircles.delete(vehicle.vehicleId);
        }
    }

    // 4. Global bypass polyline route (if Global Traffic Flow Optimizer is active)
    if (isGlobalOptimizerActive && vehicle.destinationLat && vehicle.destinationLng) {
        // Create an alternative route offset from the direct path to mock congestion bypass
        const bypassCoordinates = [
            position,
            { lat: (position.lat + vehicle.destinationLat) / 2 + 0.002, lng: (position.lng + vehicle.destinationLng) / 2 - 0.002 },
            { lat: vehicle.destinationLat, lng: vehicle.destinationLng }
        ];

        if (bypassPolylines.has(vehicle.vehicleId)) {
            const polyline = bypassPolylines.get(vehicle.vehicleId);
            polyline.setPath(bypassCoordinates);
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
    if (vehicleMarkers.has(vehicleId)) {
        vehicleMarkers.get(vehicleId).setMap(null);
        vehicleMarkers.delete(vehicleId);
    }
    if (routePolylines.has(vehicleId)) {
        routePolylines.get(vehicleId).setMap(null);
        routePolylines.delete(vehicleId);
    }
    if (congestionCircles.has(vehicleId)) {
        congestionCircles.get(vehicleId).setMap(null);
        congestionCircles.delete(vehicleId);
    }
    if (bypassPolylines.has(vehicleId)) {
        bypassPolylines.get(vehicleId).setMap(null);
        bypassPolylines.delete(vehicleId);
    }
}

// Update Active Vehicles list on Sidebar
function updateVehicleList() {
    const listEl = document.getElementById("vehicle-list");
    const countEl = document.getElementById("vehicle-count");
    
    countEl.innerText = `${activeVehicles.size} Active`;
    
    if (activeVehicles.size === 0) {
        listEl.innerHTML = `
            <p class="text-secondary" style="text-align: center; padding: 20px;">No vehicles online. Start the APK client to stream telemetry.</p>
        `;
        return;
    }
    
    let html = "";
    activeVehicles.forEach((vehicle) => {
        const isEmergency = vehicle.isEmergency;
        const speedClass = vehicle.speed > 80 ? "speeding" : "";
        const isSelected = document.getElementById(`card-${vehicle.vehicleId}`)?.classList.contains("active-selected") ? "active-selected" : "";
        
        html += `
            <div id="card-${vehicle.vehicleId}" class="vehicle-card glass-panel ${isEmergency ? 'emergency' : 'normal'} ${isSelected}" onclick="focusVehicle('${vehicle.vehicleId}')">
                <div class="card-top">
                    <span class="vehicle-title">${vehicle.vehicleId}</span>
                    <span class="vehicle-type-tag ${isEmergency ? 'emergency-tag' : ''}">${vehicle.type}</span>
                </div>
                <div class="card-details">
                    <span>Driver: <strong>${vehicle.driverName}</strong></span>
                    <span>Speed: <strong class="stat-value ${speedClass}">${vehicle.speed.toFixed(0)} km/h</strong></span>
                </div>
            </div>
        `;
    });
    
    listEl.innerHTML = html;
}

// Focus camera and UI card on a specific vehicle
function focusVehicle(vehicleId) {
    selectVehicleCard(vehicleId);
    
    const vehicle = activeVehicles.get(vehicleId);
    if (vehicle) {
        const position = { lat: vehicle.lat, lng: vehicle.lng };
        map.setZoom(16);
        map.panTo(position);
    }
}

function selectVehicleCard(vehicleId) {
    document.querySelectorAll(".vehicle-card").forEach((card) => {
        card.classList.remove("active-selected");
    });
    const card = document.getElementById(`card-${vehicleId}`);
    if (card) {
        card.classList.add("active-selected");
    }
}

// Connection State UI Helper
function updateConnectionUI(connected, text) {
    const dot = document.getElementById("status-dot");
    const textEl = document.getElementById("status-text");
    
    if (connected) {
        dot.classList.add("connected");
    } else {
        dot.classList.remove("connected");
    }
    textEl.innerText = text;
}

// System analytics custom HTML/CSS gauge updater
function updateSystemAnalytics() {
    if (activeVehicles.size === 0) {
        document.getElementById("avg-speed-value").innerText = "0 km/h";
        document.getElementById("avg-speed-bar").style.width = "0%";
        return;
    }
    
    let totalSpeed = 0;
    activeVehicles.forEach((v) => {
        totalSpeed += v.speed;
    });
    const avgSpeed = totalSpeed / activeVehicles.size;
    
    document.getElementById("avg-speed-value").innerText = `${avgSpeed.toFixed(1)} km/h`;
    
    // Cap average speed display bar at 120 km/h for gauge logic
    const pct = Math.min((avgSpeed / 120) * 100, 100);
    document.getElementById("avg-speed-bar").style.width = `${pct}%`;
    
    // Dynamic connection latency based on vehicle count
    const latencyBar = document.getElementById("latency-bar");
    const latencyValue = document.getElementById("latency-value");
    if (activeVehicles.size > 3) {
        latencyBar.style.backgroundColor = "var(--orange-neon)";
        latencyBar.style.width = "75%";
        latencyValue.innerText = "78% Loaded (Heavy Flow)";
    } else {
        latencyBar.style.backgroundColor = "var(--green-neon)";
        latencyBar.style.width = "98%";
        latencyValue.innerText = "98% Optimal (Normal Load)";
    }
}

// Toggle Global Traffic Flow Optimizer
function toggleGlobalOptimizer() {
    const btn = document.getElementById("optimizer-btn");
    isGlobalOptimizerActive = !isGlobalOptimizerActive;
    
    if (isGlobalOptimizerActive) {
        btn.innerText = "Disable Global Flow Optimization";
        btn.classList.add("btn-active");
        logSystemMessage("Global Traffic Routing Optimizer activated. Rerouting active fleets.");
    } else {
        btn.innerText = "Optimize Global Flow";
        btn.classList.remove("btn-active");
        logSystemMessage("Global Routing Optimizer disabled. Restoring default routes.");
    }
    
    // Force redraw on map
    activeVehicles.forEach((vehicle) => {
        updateVehicleOnMap(vehicle);
    });
}

// Rules Log Engine & Police Dispatch API Log
function logSpeedViolation(vehicle) {
    const logsEl = document.getElementById("violation-logs");
    
    if (logsEl.querySelector(".text-secondary")) {
        logsEl.innerHTML = "";
    }
    
    speedingViolationsCount++;
    document.getElementById("speeding-count-stat").innerText = speedingViolationsCount;
    
    const timeStr = new Date().toLocaleTimeString();
    
    const logHTML = `
        <div class="log-item speed-violation">
            <div>
                <strong>🚨 CRITICAL SPEED VIOLATION</strong><br>
                Vehicle <strong>${vehicle.vehicleId}</strong> (Driver: ${vehicle.driverName}) clocked at 
                <span style="color: var(--red-neon); font-weight: bold;">${vehicle.speed.toFixed(0)} km/h</span> (Limit: 80 km/h) at location: ${vehicle.lat.toFixed(5)}, ${vehicle.lng.toFixed(5)}.
            </div>
            <div style="text-align: right; display: flex; flex-direction: column; gap: 4px; align-items: flex-end;">
                <span class="log-time">${timeStr}</span>
                <span class="police-dispatch-badge">DISPATCHED TO POLICE</span>
            </div>
        </div>
    `;
    
    logsEl.insertAdjacentHTML("afterbegin", logHTML);

    // Generate detailed mock JSON payload response from Police Department dispatch API
    const ticketId = "TK-" + Math.floor(100000 + Math.random() * 900000);
    const officerList = ["Inspector S. Patel", "Sergeant A. Rawat", "Officer K. Rao", "Inspector M. Kumar"];
    const patrolUnits = ["Patrol Unit Sector 4", "Interceptor Vehicle 12", "Highway Patrol Alpha", "City Command Unit 2"];
    
    const apiResponse = {
        status: "VIOLATION_RECORDED",
        api_endpoint: "https://api.trafficpolice.gov.in/v1/violations/dispatch",
        timestamp: new Date().toISOString(),
        dispatched: true,
        incident_data: {
            ticket_number: ticketId,
            vehicle_number: vehicle.vehicleId,
            driver: vehicle.driverName,
            offense: "SPEED_LIMIT_EXCEEDED",
            speed_recorded: `${vehicle.speed.toFixed(1)} km/h`,
            speed_limit: "80.0 km/h",
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
        feedEl.innerText = JSON.stringify(apiResponse, null, 2);
    }
}

// Emergency Banner & Alerts
function triggerEmergencyBanner(vehicle) {
    const banner = document.getElementById("emergency-banner");
    const bannerTitle = document.getElementById("emergency-banner-title");
    const bannerText = document.getElementById("emergency-banner-text");
    
    bannerTitle.innerText = `🚨 EMERGENCY Broadcast - ${vehicle.type} IN TRANSIT`;
    bannerText.innerText = `Vehicle: ${vehicle.vehicleId} (Driver: ${vehicle.driverName}) has requested clear-path routing. Alert Message: "${vehicle.alertMessage}"`;
    banner.classList.add("show");
}

// Dismiss alert banner
function dismissEmergencyBanner() {
    document.getElementById("emergency-banner").classList.remove("show");
}

function logEmergencyAlert(vehicle) {
    const dispatchEl = document.getElementById("emergency-dispatch-details");
    const hubsContainer = document.getElementById("emergency-hubs-list");
    
    const timeStr = new Date().toLocaleTimeString();
    
    dispatchEl.innerHTML = `
        <div style="line-height: 1.5;">
            <strong>Vehicle ID:</strong> ${vehicle.vehicleId}<br>
            <strong>Type:</strong> ${vehicle.type}<br>
            <strong>Driver:</strong> ${vehicle.driverName}<br>
            <strong>Alert:</strong> <span style="color: var(--red-neon); font-weight: bold;">${vehicle.alertMessage}</span><br>
            <strong>Time:</strong> ${timeStr}
        </div>
    `;
    
    if (hubsContainer.querySelector(".text-secondary")) {
        hubsContainer.innerHTML = "";
    }
    
    const hubHTML = `
        <div class="log-item emergency-alert">
            <div>
                <strong>🏥 NEAREST SERVICE ALERTS DISPATCHED</strong><br>
                Clear corridor active to nearest hospital. Red Light priority overridden at all grid checkpoints for ${vehicle.vehicleId}.
            </div>
            <span class="log-time">${timeStr}</span>
        </div>
    `;
    hubsContainer.insertAdjacentHTML("afterbegin", hubHTML);
}

// Logging System Utility
function logSystemMessage(message, type = "info") {
    const logsEl = document.getElementById("violation-logs");
    if (!logsEl) return;
    
    if (logsEl.querySelector(".text-secondary")) {
        logsEl.innerHTML = "";
    }
    
    const timeStr = new Date().toLocaleTimeString();
    let classType = "system-info";
    let title = "🤖 SYSTEM CHECK";
    
    if (type === "error") {
        classType = "speed-violation";
        title = "⚠️ SYSTEM ERROR";
    }
    
    const logHTML = `
        <div class="log-item ${classType}">
            <div>
                <strong>${title}</strong><br>
                ${message}
            </div>
            <span class="log-time">${timeStr}</span>
        </div>
    `;
    
    logsEl.insertAdjacentHTML("afterbegin", logHTML);
}

// Simulator Panel Helper
function toggleSimType() {
    const typeSelect = document.getElementById("sim-vehicle-type");
    const alertInput = document.getElementById("sim-alert-message");
    
    if (typeSelect.value !== "NORMAL") {
        alertInput.removeAttribute("disabled");
    } else {
        alertInput.setAttribute("disabled", "true");
    }
}

// Browser Mock Simulation Engine
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

function toggleSimulatorEngine() {
    const startBtn = document.getElementById("sim-start-btn");
    const coordDisplay = document.getElementById("sim-coordinate-display");
    
    if (!isSimulating) {
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
            isSimulating = true;
            simIndex = 0;
            startBtn.innerText = "Stop Browser Simulation";
            startBtn.style.background = "var(--red-neon)";
            coordDisplay.innerHTML = "=== Simulation Started ===\n";
            
            simulationInterval = setInterval(() => {
                const vehicleId = document.getElementById("sim-vehicle-id").value;
                const driverName = document.getElementById("sim-driver-name").value;
                const type = document.getElementById("sim-vehicle-type").value;
                const speed = parseFloat(document.getElementById("sim-speed").value);
                const isEmergency = type !== "NORMAL";
                const alertMessage = isEmergency ? document.getElementById("sim-alert-message").value : null;
                
                const point = SIM_PATH[simIndex];
                
                const payload = {
                    vehicleId: vehicleId,
                    driverName: driverName,
                    type: type,
                    lat: point.lat,
                    lng: point.lng,
                    speed: speed,
                    direction: 90.0, // mock bearing
                    timestamp: Math.floor(Date.now() / 1000),
                    isEmergency: isEmergency,
                    destinationLat: isEmergency ? 12.9760 : null,
                    destinationLng: isEmergency ? 77.6010 : null,
                    destinationName: isEmergency ? "City General Hospital" : null,
                    alertMessage: alertMessage
                };
                
                // Transmit simulated coordinates to the WebSocket server
                wsConnection.send(JSON.stringify(payload));
                
                coordDisplay.innerHTML += `[${new Date().toLocaleTimeString()}] Sent: Lat: ${point.lat.toFixed(5)}, Lng: ${point.lng.toFixed(5)}, Speed: ${speed.toFixed(0)} km/h\n`;
                coordDisplay.scrollTop = coordDisplay.scrollHeight;
                
                simIndex = (simIndex + 1) % SIM_PATH.length;
            }, 1000);
            
            logSystemMessage("Browser-side vehicle simulation runner active.");
        } else {
            alert("Cannot start simulation. WebSocket is disconnected.");
        }
    } else {
        isSimulating = false;
        clearInterval(simulationInterval);
        startBtn.innerText = "Start Browser Simulation";
        startBtn.style.background = "var(--cyan-neon)";
        coordDisplay.innerHTML += "=== Simulation Stopped ===";
        logSystemMessage("Browser-side vehicle simulation stopped.");
    }
}

// Tabs UI Handler
function switchTab(tabId) {
    document.querySelectorAll(".tab-content").forEach((content) => {
        content.classList.remove("active");
    });
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.remove("active");
    });
    
    document.getElementById(tabId).classList.add("active");
    
    // Mark target button active
    const btn = Array.from(document.querySelectorAll(".tab-btn")).find(
        (b) => b.innerText.toLowerCase() === tabId.replace("-tab", "").replace("violations", "rule violations").replace("simulator", "control simulator")
    );
    if (btn) btn.classList.add("active");
}
