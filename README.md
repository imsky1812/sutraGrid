# SUTRA Vehicle Client

This is the Android data telemetry app for the **SUTRA Real-Time Smart Traffic System**. It collects live GPS coordinates, speed, and heading from the driver's phone and streams it directly to the SUTRA Central Dashboard.

## Features
* 🔐 **Secure Auth**: Registers drivers and provides specialized toggle tools for Emergency vehicles (Ambulance, Fire, Police).
* 🔄 **Live Streaming WebSockets**: Pushes coordinates at rapid intervals (every 1 second normal, every 500ms for emergencies).
* 🔋 **Foreground Services**: Survives navigation switches and screen-locks, maintaining a continuous green-corridor link with the backend.
* 📱 **Jetpack Compose Native UI**: Modern Android declarative graphics architecture.

---

## Technical Stack
* Language: Kotlin
* UI Framework: Jetpack Compose
* Network: Retrofit (REST), OkHttp (WebSockets)
* Geolocation: Google Play Services Fused Location Client

---

## How to Build the APK
Due to environmental constraints, this raw code needs to be compiled via an IDE or local Gradle.

1. Install **Android Studio** (if you haven't already).
2. Click **Open Project** and select this `sutraGrid` folder (`d:\PROjects\sutraGrid`).
3. Let Gradle Sync run. It will automatically download SDK version 34 and Compose BOM.
4. From the top menu strip, select **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
5. The IDE will inform you when the `app-debug.apk` is generated, which you can load onto your phone!

---

## How Data Flows to the Backend
1. **Login State**: Standard REST POST (`/api/auth/login`) sends initial metadata (`VehicleAuthPayload` in `com.sutra.vehicle.data.VehicleData.kt`).
2. **WebSocket Activation**: 
   * Upon successful login, the app transitions to `DashboardScreen` and spins up the Android `ForegroundService` (`TelemetryService.kt`).
   * A persistent OkHttp `WebSocket` tunnel opens to `ws://server_ip:3000/vehicle/stream`.
3. **Telemetry Push**: 
   * The `FusedLocationProviderClient` grabs device coordinates every `1000ms`. 
   * A `VehicleUpdatePayload` JSON string is instantly packaged and written to the active socket hook in `sendTelemetry()`.

> **Note**: To configure this for production, edit the `BASE_URL` and `WS_URL` variables in `app/src/main/java/com/sutra/vehicle/network/ApiClient.kt` to match your cloud dashboard server IP.
