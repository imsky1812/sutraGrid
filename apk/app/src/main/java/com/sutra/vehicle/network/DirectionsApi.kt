package com.sutra.vehicle.network

import com.google.android.gms.maps.model.LatLng
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.GET
import retrofit2.http.Query

data class DirectionsResponse(
    val routes: List<DirectionsRoute>,
    val status: String
)

data class DirectionsRoute(
    val overview_polyline: OverviewPolyline
)

data class OverviewPolyline(
    val points: String
)

interface DirectionsService {
    @GET("maps/api/directions/json")
    suspend fun getDirections(
        @Query("origin") origin: String,
        @Query("destination") destination: String,
        @Query("key") apiKey: String,
        @Query("mode") mode: String = "driving"
    ): DirectionsResponse
}

object DirectionsApiClient {
    private const val MAPS_BASE_URL = "https://maps.googleapis.com/"

    private val retrofit = Retrofit.Builder()
        .baseUrl(MAPS_BASE_URL)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val directionsService: DirectionsService = retrofit.create(DirectionsService::class.java)
}

object PolylineDecoder {
    fun decode(encoded: String): List<LatLng> {
        val poly = ArrayList<LatLng>()
        var index = 0
        val len = encoded.length
        var lat = 0
        var lng = 0

        while (index < len) {
            var b: Int
            var shift = 0
            var result = 0
            do {
                b = encoded[index++].code - 63
                result = result or (b and 0x1f shl shift)
                shift += 5
            } while (b >= 0x20)
            val dlat = if (result and 1 != 0) (result ushr 1).inv() else result ushr 1
            lat += dlat

            shift = 0
            result = 0
            do {
                b = encoded[index++].code - 63
                result = result or (b and 0x1f shl shift)
                shift += 5
            } while (b >= 0x20)
            val dlng = if (result and 1 != 0) (result ushr 1).inv() else result ushr 1
            lng += dlng

            val p = LatLng(lat.toDouble() / 1E5, lng.toDouble() / 1E5)
            poly.add(p)
        }
        return poly
    }
}
