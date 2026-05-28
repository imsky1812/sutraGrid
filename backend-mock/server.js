const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/vehicle/stream' });

app.use(express.json());

// Status page for browser
app.get('/', (req, res) => {
    res.send('<h1>SUTRA Mock Backend is LIVE</h1><p>Waiting for vehicle data...</p>');
});

// Mock Login Endpoint
app.post('/api/auth/login', (req, res) => {
    console.log('\n--- NEW LOGIN ATTEMPT ---');
    console.log('Driver:', req.body.name);
    console.log('Vehicle ID:', req.body.vehicleId);
    console.log('Type:', req.body.vehicleType);
    console.log('-------------------------\n');

    res.json({
        success: true,
        token: 'mock-jwt-token-' + Date.now(),
        message: 'Login successful'
    });
});

// Active vehicles tracking map
const activeVehicles = new Map();

function printDashboard() {
    console.clear();
    console.log('============================= SUTRA LIVE TELEMETRY DASHBOARD =============================');
    console.log(`Active Connections: ${activeVehicles.size}`);
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
}

// WebSocket for Live Telemetry
wss.on('connection', (ws) => {
    console.log('New Client Connected to Stream');
    let clientVehicleId = null;

    // Immediately push existing active vehicles to new dashboard connections
    if (activeVehicles.size > 0) {
        activeVehicles.forEach((vehicleData) => {
            try {
                ws.send(JSON.stringify({ type: 'UPDATE', data: vehicleData }));
            } catch (e) {
                // Ignore
            }
        });
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            clientVehicleId = data.vehicleId;
            ws.vehicleId = data.vehicleId;
            
            activeVehicles.set(data.vehicleId, data);
            printDashboard();

            // Broadcast updates to all other clients (dashboards)
            const broadcastPayload = JSON.stringify({ type: 'UPDATE', data: data });
            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(broadcastPayload);
                }
            });
        } catch (e) {
            console.log('Received raw message:', message.toString());
        }
    });

    ws.on('close', () => {
        console.log(`Vehicle ${clientVehicleId || ''} Disconnected`);
        if (clientVehicleId) {
            activeVehicles.delete(clientVehicleId);
            printDashboard();

            // Broadcast disconnect event to all other clients
            const broadcastPayload = JSON.stringify({ type: 'DISCONNECT', vehicleId: clientVehicleId });
            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(broadcastPayload);
                }
            });
        }
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mock Backend running on http://localhost:${PORT}`);
    console.log(`WebSocket path: ws://localhost:${PORT}/vehicle/stream`);
    console.log('\nWaiting for vehicle connection...');
});
