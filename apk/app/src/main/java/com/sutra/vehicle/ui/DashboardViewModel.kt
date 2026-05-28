package com.sutra.vehicle.ui

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.maps.model.LatLng
import com.sutra.vehicle.BuildConfig
import com.sutra.vehicle.data.VehicleUpdatePayload
import com.sutra.vehicle.network.DirectionsApiClient
import com.sutra.vehicle.network.PolylineDecoder
import com.sutra.vehicle.service.TelemetryService
import kotlinx.coroutines.launch

data class ServiceMarker(
    val name: String,
    val location: LatLng,
    val type: String // "HOSPITAL", "POLICE", "FIRE"
)

class DashboardViewModel : ViewModel() {
    var vehicleLocation by mutableStateOf<VehicleUpdatePayload?>(null)
        private set

    var directionsRoute by mutableStateOf<List<LatLng>>(emptyList())
    var destinationCoordinates by mutableStateOf<LatLng?>(null)
    var destinationName by mutableStateOf<String?>(null)
    
    var nearestServices by mutableStateOf<List<ServiceMarker>>(emptyList())
        private set

    var isRecordingHistory by mutableStateOf(false)
    var isSimulatingActive by mutableStateOf(false)
    var activeSimulationMode by mutableStateOf("PRESET") // "PRESET", "HISTORY", "ROUTE"

    fun updateLocation(payload: VehicleUpdatePayload) {
        vehicleLocation = payload
        updateNearestServices(LatLng(payload.lat, payload.lng))
    }

    fun fetchDirections(origin: LatLng, dest: LatLng, name: String) {
        viewModelScope.launch {
            try {
                val originStr = "${origin.latitude},${origin.longitude}"
                val destStr = "${dest.latitude},${dest.longitude}"
                val response = DirectionsApiClient.directionsService.getDirections(
                    origin = originStr,
                    destination = destStr,
                    apiKey = BuildConfig.MAPS_API_KEY
                )
                if (response.status == "OK" && response.routes.isNotEmpty()) {
                    val points = PolylineDecoder.decode(response.routes[0].overview_polyline.points)
                    directionsRoute = points
                    destinationCoordinates = dest
                    destinationName = name
                    
                    // Sync with TelemetryService static variables
                    TelemetryService.destinationLat = dest.latitude
                    TelemetryService.destinationLng = dest.longitude
                    TelemetryService.destinationName = name
                    
                    Log.d("DashboardViewModel", "Successfully loaded Google Directions: ${points.size} points")
                } else {
                    Log.e("DashboardViewModel", "Directions API error: ${response.status}")
                }
            } catch (e: Exception) {
                Log.e("DashboardViewModel", "Error fetching directions", e)
            }
        }
    }

    private fun updateNearestServices(location: LatLng) {
        nearestServices = listOf(
            ServiceMarker("City General Hospital", LatLng(location.latitude + 0.005, location.longitude + 0.005), "HOSPITAL"),
            ServiceMarker("Metro Police Station", LatLng(location.latitude - 0.003, location.longitude - 0.004), "POLICE"),
            ServiceMarker("Central Fire Station", LatLng(location.latitude + 0.007, location.longitude - 0.002), "FIRE")
        )
    }

    fun clearActiveRoute() {
        directionsRoute = emptyList()
        destinationCoordinates = null
        destinationName = null
        TelemetryService.destinationLat = null
        TelemetryService.destinationLng = null
        TelemetryService.destinationName = null
    }

    fun setRecording(enabled: Boolean) {
        isRecordingHistory = enabled
        TelemetryService.isRecording = enabled
    }

    fun setEmergencyAlert(message: String?) {
        TelemetryService.alertMessage = message
    }
}
