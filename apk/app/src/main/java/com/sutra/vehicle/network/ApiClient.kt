package com.sutra.vehicle.network

import com.google.gson.Gson
import com.sutra.vehicle.BuildConfig
import com.sutra.vehicle.data.AuthResponse
import com.sutra.vehicle.data.VehicleAuthPayload
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.POST
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

interface SutraApiService {
    // Returns Response<> rather than the bare body so a 400/403 can be read and
    // shown to the driver instead of surfacing as a generic exception.
    @POST("/api/auth/login")
    suspend fun loginVehicle(@Body payload: VehicleAuthPayload): Response<AuthResponse>
}

object ApiClient {
    // Backend host, supplied at build time from the .env file (see
    // app/build.gradle.kts). Defaults to the Android emulator's host loopback.
    private val HOST: String = BuildConfig.BACKEND_HOST

    private const val CONNECT_TIMEOUT_SECONDS = 30L

    val BASE_URL: String = "http://$HOST"

    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    val retrofit: Retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val apiService: SutraApiService = retrofit.create(SutraApiService::class.java)

    private val gson = Gson()

    /**
     * Parse the JSON error body of a failed login so the driver sees the
     * server's reason ("Invalid emergency authorization code") rather than a
     * status code.
     */
    fun parseErrorMessage(response: Response<AuthResponse>): String {
        return try {
            val body = response.errorBody()?.string()
            if (body.isNullOrBlank()) {
                "Login failed (HTTP ${response.code()})"
            } else {
                gson.fromJson(body, AuthResponse::class.java)?.message
                    ?: "Login failed (HTTP ${response.code()})"
            }
        } catch (e: Exception) {
            "Login failed (HTTP ${response.code()})"
        }
    }

    /**
     * Open the telemetry stream for an authenticated session. The server binds
     * the socket to the session behind [token] and ignores any identity fields
     * in the frames themselves, so this token is what makes the stream trusted.
     */
    fun createWebSocket(token: String, listener: WebSocketListener): WebSocket {
        val encoded = URLEncoder.encode(token, "UTF-8")
        val request = Request.Builder()
            .url("ws://$HOST/vehicle/stream?token=$encoded")
            .build()
        return okHttpClient.newWebSocket(request, listener)
    }
}
