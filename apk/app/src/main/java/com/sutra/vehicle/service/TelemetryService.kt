package com.sutra.vehicle.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.*
import com.google.android.gms.maps.model.LatLng
import com.google.gson.Gson
import com.sutra.vehicle.data.VehicleUpdatePayload
import com.sutra.vehicle.db.LocationDbHelper
import com.sutra.vehicle.network.ApiClient
import com.sutra.vehicle.ui.DashboardViewModel
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response

class TelemetryService : Service() {

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private lateinit var dbHelper: LocationDbHelper
    private var webSocket: WebSocket? = null
    private val gson = Gson()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var vehicleId: String = ""
    private var driverName: String = ""
    private var vehicleType: String = ""
    private var isEmergency: Boolean = false

    private var isSimulating: Boolean = false
    private var simulationIndex = 0
    private var simulationPoints = listOf<LatLng>()

    companion object {
        var viewModel: DashboardViewModel? = null

        var destinationLat: Double? = null
        var destinationLng: Double? = null
        var destinationName: String? = null
        var alertMessage: String? = null
        var isRecording: Boolean = false

        // Bangalore loop preset route for presentation
        val PRESET_ROUTE = listOf(
            LatLng(12.9716, 77.5946),
            LatLng(12.9725, 77.5950),
            LatLng(12.9734, 77.5955),
            LatLng(12.9745, 77.5962),
            LatLng(12.9752, 77.5970),
            LatLng(12.9758, 77.5980),
            LatLng(12.9760, 77.5992),
            LatLng(12.9758, 77.6005),
            LatLng(12.9752, 77.6015),
            LatLng(12.9742, 77.6020),
            LatLng(12.9730, 77.6018),
            LatLng(12.9720, 77.6010),
            LatLng(12.9712, 77.6000),
            LatLng(12.9705, 77.5990),
            LatLng(12.9700, 77.5978),
            LatLng(12.9698, 77.5965),
            LatLng(12.9702, 77.5952),
            LatLng(12.9708, 77.5945)
        )
    }

    private val simulationRunnable = object : Runnable {
        override fun run() {
            if (!isSimulating || simulationPoints.isEmpty()) return

            val point = simulationPoints[simulationIndex]
            val nextPoint = simulationPoints[(simulationIndex + 1) % simulationPoints.size]

            val bearing = calculateBearing(point, nextPoint)
            val speed = 45f // Constant 45 km/h for simulation

            sendTelemetry(point.latitude, point.longitude, speed, bearing)

            simulationIndex = (simulationIndex + 1) % simulationPoints.size
            mainHandler.postDelayed(this, 1000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        dbHelper = LocationDbHelper(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "START_SERVICE" -> {
                vehicleId = intent.getStringExtra("VEHICLE_ID") ?: ""
                driverName = intent.getStringExtra("DRIVER_NAME") ?: ""
                vehicleType = intent.getStringExtra("VEHICLE_TYPE") ?: ""
                isEmergency = intent.getBooleanExtra("IS_EMERGENCY", false)

                startForeground(1, createNotification())
                connectWebSocket()
                startLocationUpdates()
            }
            "STOP_SERVICE" -> {
                stopLocationUpdates()
                stopSimulation()
                webSocket?.close(1000, "User logged out")
                stopSelf()
            }
            "START_SIMULATION" -> {
                val mode = intent.getStringExtra("SIMULATION_MODE") ?: "PRESET"
                startSimulation(mode)
            }
            "STOP_SIMULATION" -> {
                stopSimulation()
                startLocationUpdates()
            }
        }
        return START_STICKY
    }

    private fun connectWebSocket() {
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d("TelemetryService", "WebSocket Connected")
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                // Handle commands from server if needed
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("TelemetryService", "WebSocket Error", t)
            }
        }
        webSocket = ApiClient.createWebSocket(listener)
    }

    private fun startLocationUpdates() {
        val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000)
            .setWaitForAccurateLocation(false)
            .setMinUpdateIntervalMillis(1000)
            .setMaxUpdateDelayMillis(2000)
            .build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(locationResult: LocationResult) {
                if (isSimulating) return // Skip real location when simulating
                for (location in locationResult.locations) {
                    sendTelemetry(
                        location.latitude,
                        location.longitude,
                        location.speed * 3.6f, // Convert m/s to km/h
                        location.bearing
                    )
                }
            }
        }

        try {
            fusedLocationClient.requestLocationUpdates(
                locationRequest,
                locationCallback,
                Looper.getMainLooper()
            )
        } catch (e: SecurityException) {
            // Handled by UI
        }
    }

    private fun startSimulation(mode: String) {
        stopLocationUpdates()
        isSimulating = true
        simulationIndex = 0

        simulationPoints = when (mode) {
            "ROUTE" -> viewModel?.directionsRoute ?: PRESET_ROUTE
            "HISTORY" -> dbHelper.getAllHistory().map { LatLng(it.lat, it.lng) }
            else -> PRESET_ROUTE
        }

        if (simulationPoints.isEmpty()) {
            simulationPoints = PRESET_ROUTE
        }

        mainHandler.post(simulationRunnable)
    }

    private fun stopSimulation() {
        isSimulating = false
        mainHandler.removeCallbacks(simulationRunnable)
    }

    private fun sendTelemetry(lat: Double, lng: Double, speed: Float, direction: Float) {
        val payload = VehicleUpdatePayload(
            vehicleId = vehicleId,
            driverName = driverName,
            type = vehicleType,
            lat = lat,
            lng = lng,
            speed = speed,
            direction = direction,
            timestamp = System.currentTimeMillis() / 1000,
            isEmergency = isEmergency,
            destinationLat = destinationLat,
            destinationLng = destinationLng,
            destinationName = destinationName,
            alertMessage = alertMessage
        )

        if (isRecording) {
            dbHelper.insertLocation(payload)
        }

        val jsonString = gson.toJson(payload)
        webSocket?.send(jsonString)
        Log.d("TelemetryService", "Sent: $jsonString")

        // Update UI if ViewModel is attached
        mainHandler.post {
            viewModel?.updateLocation(payload)
        }
    }

    private fun stopLocationUpdates() {
        if (::locationCallback.isInitialized) {
            fusedLocationClient.removeLocationUpdates(locationCallback)
        }
    }

    private fun calculateBearing(start: LatLng, end: LatLng): Float {
        val lat1 = Math.toRadians(start.latitude)
        val lon1 = Math.toRadians(start.longitude)
        val lat2 = Math.toRadians(end.latitude)
        val lon2 = Math.toRadians(end.longitude)

        val dLon = lon2 - lon1
        val y = Math.sin(dLon) * Math.cos(lat2)
        val x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
        val brng = Math.atan2(y, x)

        return ((Math.toDegrees(brng) + 360) % 360).toFloat()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "TelemetryChannel",
                "SUTRA Vehicle Tracking",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        return NotificationCompat.Builder(this, "TelemetryChannel")
            .setContentTitle("SUTRA Vehicle Client")
            .setContentText("Sharing your location with SUTRA dashboard")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopLocationUpdates()
        stopSimulation()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
