package com.sutra.vehicle

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.rememberMultiplePermissionsState
import androidx.lifecycle.viewmodel.compose.viewModel
import com.sutra.vehicle.data.LoginResult
import com.sutra.vehicle.service.TelemetryService
import com.sutra.vehicle.ui.AuthScreen
import com.sutra.vehicle.ui.DashboardScreen
import com.sutra.vehicle.ui.DashboardViewModel

class MainActivity : ComponentActivity() {

    @OptIn(ExperimentalPermissionsApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val permissions = rememberMultiplePermissionsState(
                        permissions = listOfNotNull(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION,
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                Manifest.permission.POST_NOTIFICATIONS
                            } else null
                        )
                    )

                    LaunchedEffect(Unit) {
                        permissions.launchMultiplePermissionRequest()
                    }

                    val navController = rememberNavController()
                    val dashboardViewModel: DashboardViewModel = viewModel()

                    // The session is held here rather than encoded into the nav
                    // route: the token has no business in a back-stack URL, and
                    // route arguments broke on names containing '/'.
                    var session by remember { mutableStateOf<LoginResult?>(null) }

                    // Attach ViewModel to Service for UI updates
                    TelemetryService.viewModel = dashboardViewModel

                    NavHost(navController = navController, startDestination = "auth") {
                        composable("auth") {
                            AuthScreen(onLoginSuccess = { result ->
                                session = result

                                val serviceIntent = Intent(this@MainActivity, TelemetryService::class.java).apply {
                                    action = "START_SERVICE"
                                    putExtra("DRIVER_NAME", result.driverName)
                                    putExtra("VEHICLE_ID", result.vehicleId)
                                    putExtra("VEHICLE_TYPE", result.vehicleType)
                                    putExtra("IS_EMERGENCY", result.isEmergency)
                                    putExtra("AUTH_TOKEN", result.token)
                                }
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                    startForegroundService(serviceIntent)
                                } else {
                                    startService(serviceIntent)
                                }
                                navController.navigate("dashboard") {
                                    popUpTo("auth") { inclusive = true }
                                }
                            })
                        }

                        composable("dashboard") {
                            val active = session
                            if (active == null) {
                                // Process death can restore the dashboard route
                                // without a session; send the driver back to log
                                // in rather than streaming with no token.
                                LaunchedEffect(Unit) {
                                    navController.navigate("auth") { popUpTo(0) }
                                }
                            } else {
                                DashboardScreen(
                                    vehicleId = active.vehicleId,
                                    vehicleType = active.vehicleType,
                                    isEmergencyFlag = active.isEmergency,
                                    viewModel = dashboardViewModel,
                                    onStopStreaming = {
                                        val serviceIntent = Intent(this@MainActivity, TelemetryService::class.java).apply {
                                            action = "STOP_SERVICE"
                                        }
                                        startService(serviceIntent)
                                        session = null
                                        navController.navigate("auth") {
                                            popUpTo(0)
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
