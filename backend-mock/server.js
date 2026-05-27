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

// WebSocket for Live Telemetry
wss.on('connection', (ws) => {
    console.log('Vehicle Connected to Stream');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.clear();
            console.log('=== SUTRA LIVE TELEMETRY DASHBOARD ===');
            console.log(`Driver:    ${data.driverName}`);
            console.log(`Vehicle:   ${data.vehicleId} [${data.type}]`);
            console.log(`Status:    ${data.isEmergency ? '!! EMERGENCY !!' : 'NORMAL'}`);
            console.log(`Location:  ${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}`);
            console.log(`Speed:     ${data.speed.toFixed(2)} km/h`);
            console.log(`Time:      ${new Date(data.timestamp * 1000).toLocaleTimeString()}`);
            console.log('=======================================');
        } catch (e) {
            console.log('Received raw message:', message.toString());
        }
    });

    ws.on('close', () => {
        console.log('Vehicle Disconnected');
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mock Backend running on http://localhost:${PORT}`);
    console.log(`WebSocket path: ws://localhost:${PORT}/vehicle/stream`);
    console.log('\nWaiting for vehicle connection...');
});
