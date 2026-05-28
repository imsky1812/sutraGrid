package com.sutra.vehicle.network

import com.google.gson.Gson
import com.sutra.vehicle.data.AuthResponse
import com.sutra.vehicle.data.VehicleAuthPayload
import com.sutra.vehicle.data.VehicleUpdatePayload
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.POST
import java.util.concurrent.TimeUnit

interface SutraApiService {
    @POST("/api/auth/login")
    suspend fun loginVehicle(@Body payload: VehicleAuthPayload): AuthResponse
}

object ApiClient {
    // Local IP address of your machine for physical device testing
    private const val BASE_URL = "http://172.16.14.189:3000" 
    const val WS_URL = "ws://172.16.14.189:3000/vehicle/stream"

    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    val retrofit: Retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val apiService: SutraApiService = retrofit.create(SutraApiService::class.java)

    // WebSocket singleton helper
    fun createWebSocket(listener: WebSocketListener): WebSocket {
        val request = Request.Builder().url(WS_URL).build()
        return okHttpClient.newWebSocket(request, listener)
    }
}
