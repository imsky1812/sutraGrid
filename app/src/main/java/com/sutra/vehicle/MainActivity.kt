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
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.rememberMultiplePermissionsState
import androidx.lifecycle.viewmodel.compose.viewModel
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
                    
                    // Attach ViewModel to Service for UI updates
                    TelemetryService.viewModel = dashboardViewModel

                    NavHost(navController = navController, startDestination = "auth") {
                        composable("auth") {
                            AuthScreen(onLoginSuccess = { name, vehicleId, type, isEmergency ->
                                // Start Foreground Service
                                val serviceIntent = Intent(this@MainActivity, TelemetryService::class.java).apply {
                                    action = "START_SERVICE"
                                    putExtra("DRIVER_NAME", name)
                                    putExtra("VEHICLE_ID", vehicleId)
                                    putExtra("VEHICLE_TYPE", type)
                                    putExtra("IS_EMERGENCY", isEmergency)
                                }
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                    startForegroundService(serviceIntent)
                                } else {
                                    startService(serviceIntent)
                                }
                                navController.navigate("dashboard/$name/$vehicleId/$type/$isEmergency") {
                                    popUpTo("auth") { inclusive = true }
                                }
                            })
                        }
                        
                        composable("dashboard/{name}/{vehicleId}/{type}/{isEmergency}") { backStackEntry ->
                            val driverName = backStackEntry.arguments?.getString("name") ?: ""
                            val vehicleId = backStackEntry.arguments?.getString("vehicleId") ?: ""
                            val type = backStackEntry.arguments?.getString("type") ?: ""
                            val isEmergency = backStackEntry.arguments?.getString("isEmergency")?.toBoolean() ?: false
                            
                            DashboardScreen(
                                vehicleId = vehicleId, 
                                vehicleType = type, 
                                isEmergencyFlag = isEmergency,
                                viewModel = dashboardViewModel,
                                onStopStreaming = {
                                    val serviceIntent = Intent(this@MainActivity, TelemetryService::class.java).apply {
                                        action = "STOP_SERVICE"
                                    }
                                    startService(serviceIntent)
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
