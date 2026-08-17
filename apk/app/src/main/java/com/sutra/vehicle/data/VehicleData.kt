package com.sutra.vehicle.data

data class VehicleAuthPayload(
    val name: String,
    val phoneNumber: String,
    val vehicleId: String,
    val vehicleType: String,
    val isEmergency: Boolean,
    val emergencyCode: String? = null
)

data class VehicleUpdatePayload(
    val vehicleId: String,
    val driverName: String,
    val type: String,
    val lat: Double,
    val lng: Double,
    val speed: Float,
    val direction: Float,
    val timestamp: Long,
    val isEmergency: Boolean,
    val destinationLat: Double? = null,
    val destinationLng: Double? = null,
    val destinationName: String? = null,
    val alertMessage: String? = null
)

data class AuthResponse(
    val success: Boolean,
    val token: String?,
    val message: String?,
    // Emergency status is decided by the server, not requested by the client.
    // Whatever comes back here is what the vehicle actually holds.
    val isEmergency: Boolean = false,
    val vehicleType: String? = null
)

/**
 * The outcome of a successful login. [isEmergency] and [vehicleType] mirror what
 * the server granted, which may be narrower than what the driver asked for.
 */
data class LoginResult(
    val token: String,
    val driverName: String,
    val vehicleId: String,
    val vehicleType: String,
    val isEmergency: Boolean
)

enum class VehicleType {
    NORMAL, AMBULANCE, POLICE, FIRE
}
