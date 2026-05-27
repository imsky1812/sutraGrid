package com.sutra.vehicle.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import com.sutra.vehicle.data.VehicleUpdatePayload

class DashboardViewModel : ViewModel() {
    var vehicleLocation by mutableStateOf<VehicleUpdatePayload?>(null)
        private set

    fun updateLocation(payload: VehicleUpdatePayload) {
        vehicleLocation = payload
    }
}
