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
import com.google.gson.Gson
import com.sutra.vehicle.data.VehicleUpdatePayload
import com.sutra.vehicle.network.ApiClient
import com.sutra.vehicle.ui.DashboardViewModel
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response

class TelemetryService : Service() {

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private var webSocket: WebSocket? = null
    private val gson = Gson()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var vehicleId: String = ""
    private var driverName: String = ""
    private var vehicleType: String = ""
    private var isEmergency: Boolean = false

    companion object {
        var viewModel: DashboardViewModel? = null
    }

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
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
                webSocket?.close(1000, "User logged out")
                stopSelf()
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
                // Handle commands from server if needed (like forcing emergency mode from dash)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("TelemetryService", "WebSocket Error", t)
                // Implement auto-reconnect logic here
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
        
        if (isEmergency) {
             // If emergency, we update faster. (e.g. 500ms)
        }

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(locationResult: LocationResult) {
                for (location in locationResult.locations) {
                    sendTelemetry(location)
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
            // Missing permissions handled by UI layer
        }
    }

    private fun sendTelemetry(location: Location) {
        val payload = VehicleUpdatePayload(
            vehicleId = vehicleId,
            driverName = driverName,
            type = vehicleType,
            lat = location.latitude,
            lng = location.longitude,
            speed = location.speed * 3.6f, // Convert m/s to km/h
            direction = location.bearing,
            timestamp = System.currentTimeMillis() / 1000,
            isEmergency = isEmergency
        )
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

    override fun onBind(intent: Intent?): IBinder? = null
}
