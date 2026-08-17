package com.sutra.vehicle.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.JointType
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.RoundCap
import com.google.maps.android.compose.*
import com.sutra.vehicle.service.TelemetryService

data class PredefinedDestination(
    val name: String,
    val location: LatLng,
    val isEmergency: Boolean
)

val PREDEFINED_DESTINATIONS = listOf(
    PredefinedDestination("City General Hospital", LatLng(12.9760, 77.6010), true),
    PredefinedDestination("Central Fire Station", LatLng(12.9750, 77.5890), true),
    PredefinedDestination("Metro Police Headquarters", LatLng(12.9690, 77.5910), true),
    PredefinedDestination("Lalbagh Botanical Garden", LatLng(12.9507, 77.5844), false),
    PredefinedDestination("Commercial Street Mall", LatLng(12.9820, 77.6080), false)
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    vehicleId: String,
    vehicleType: String,
    isEmergencyFlag: Boolean,
    onStopStreaming: () -> Unit,
    viewModel: DashboardViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
) {
    val context = LocalContext.current
    val vehicleLocation = viewModel.vehicleLocation
    var isEmergencyActive by remember { mutableStateOf(isEmergencyFlag) }

    val cameraPositionState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(LatLng(12.9716, 77.5946), 14f)
    }

    // Auto-center camera on vehicle location
    LaunchedEffect(vehicleLocation) {
        vehicleLocation?.let {
            cameraPositionState.position = CameraPosition.fromLatLngZoom(
                LatLng(it.lat, it.lng), 15f
            )
        }
    }

    var showDestMenu by remember { mutableStateOf(false) }
    var selectedDest by remember { mutableStateOf<PredefinedDestination?>(null) }
    var alertActive by remember { mutableStateOf(false) }

    var customLat by remember { mutableStateOf("") }
    var customLng by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text("SUTRA Live View", fontSize = 24.sp, fontWeight = FontWeight.Bold)
                Text("Vehicle: $vehicleId | Type: $vehicleType", color = Color.Gray, fontSize = 14.sp)
            }
            
            // Log Out Button
            OutlinedButton(
                onClick = {
                    toggleSimulation(context, "PRESET", false)
                    onStopStreaming()
                },
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                shape = RoundedCornerShape(8.dp)
            ) {
                Text("Logout", fontSize = 12.sp)
            }
        }
        
        Spacer(modifier = Modifier.height(12.dp))

        // Main Live Map View
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(Color.LightGray, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center
        ) {
            GoogleMap(
                modifier = Modifier.fillMaxSize(),
                cameraPositionState = cameraPositionState,
                properties = MapProperties(isMyLocationEnabled = true),
                uiSettings = MapUiSettings(zoomControlsEnabled = true),
                onMapLongClick = { latLng ->
                    // Set custom destination from map
                    val currentLoc = vehicleLocation?.let { LatLng(it.lat, it.lng) }
                        ?: LatLng(12.9716, 77.5946)
                    viewModel.fetchDirections(currentLoc, latLng, "Pinned Destination")
                    selectedDest = PredefinedDestination("Pinned Destination", latLng, false)
                    customLat = latLng.latitude.toString()
                    customLng = latLng.longitude.toString()
                }
            ) {
                // 1. Vehicle Marker
                vehicleLocation?.let {
                    Marker(
                        state = MarkerState(position = LatLng(it.lat, it.lng)),
                        title = "$vehicleId (You)",
                        snippet = "Speed: ${it.speed.toInt()} km/h",
                        icon = BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_CYAN)
                    )
                }

                // 2. Active Route Polyline
                // Only drawn when a real Directions result is loaded. There is
                // deliberately no placeholder line here: a stray polyline is
                // indistinguishable from a real route on the map.
                if (viewModel.directionsRoute.isNotEmpty()) {
                    Polyline(
                        points = viewModel.directionsRoute,
                        color = if (viewModel.isRouteCongested) Color.Red else Color(0xFF2E7D32), // Green
                        width = 16f,
                        jointType = JointType.ROUND,
                        startCap = RoundCap(),
                        endCap = RoundCap()
                    )
                }

                // 3. Destination Marker
                viewModel.destinationCoordinates?.let {
                    Marker(
                        state = MarkerState(position = it),
                        title = viewModel.destinationName ?: "Destination",
                        icon = BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED)
                    )
                }

                // 4. Nearest Emergency Services Markers
                viewModel.nearestServices.forEach { service ->
                    Marker(
                        state = MarkerState(position = service.location),
                        title = service.name,
                        icon = BitmapDescriptorFactory.defaultMarker(
                            when (service.type) {
                                "HOSPITAL" -> BitmapDescriptorFactory.HUE_RED
                                "FIRE" -> BitmapDescriptorFactory.HUE_ORANGE
                                else -> BitmapDescriptorFactory.HUE_BLUE
                            }
                        )
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Bottom Controls in a Scrollable Box to handle smaller screens
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
        ) {
            // Live Stats Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Current Coordinates:", fontSize = 13.sp)
                        Text(
                            "${vehicleLocation?.lat?.let { "%.5f".format(it) } ?: 0.0}, ${vehicleLocation?.lng?.let { "%.5f".format(it) } ?: 0.0}",
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp
                        )
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Live Transmission Speed:", fontSize = 13.sp)
                        Text(
                            "${vehicleLocation?.speed?.toInt() ?: 0} km/h",
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                            fontSize = 13.sp
                        )
                    }
                    if (viewModel.destinationName != null) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Active Destination:", fontSize = 13.sp)
                            Text(viewModel.destinationName ?: "", fontWeight = FontWeight.Bold, color = Color.Red, fontSize = 13.sp)
                        }
                        if (viewModel.directionsRoute.isEmpty()) {
                            Text("No route found. Check API Key/Network.", color = Color.Red, fontSize = 11.sp)
                        } else {
                            Text("Route loaded (${viewModel.directionsRoute.size} points)", color = Color(0xFF2E7D32), fontSize = 11.sp)
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Navigation / Destination Card
            ElevatedCard(
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text("Set Destination", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                    Spacer(modifier = Modifier.height(8.dp))

                    Box(modifier = Modifier.fillMaxWidth()) {
                        OutlinedButton(
                            onClick = { showDestMenu = true },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(selectedDest?.name ?: "Select Predefined Destination")
                        }

                        DropdownMenu(
                            expanded = showDestMenu,
                            onDismissRequest = { showDestMenu = false },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            PREDEFINED_DESTINATIONS.forEach { dest ->
                                DropdownMenuItem(
                                    text = { Text(dest.name + if (dest.isEmergency) " (Emergency)" else "") },
                                    onClick = {
                                        selectedDest = dest
                                        showDestMenu = false
                                        
                                        // Request directions from current location
                                        val currentLoc = vehicleLocation?.let { LatLng(it.lat, it.lng) }
                                            ?: LatLng(12.9716, 77.5946)
                                        viewModel.fetchDirections(currentLoc, dest.location, dest.name)
                                        customLat = dest.location.latitude.toString()
                                        customLng = dest.location.longitude.toString()
                                    }
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))
                    Text("Or enter coordinates / Long-press on map", fontSize = 12.sp, color = Color.Gray)
                    Spacer(modifier = Modifier.height(4.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        OutlinedTextField(
                            value = customLat,
                            onValueChange = { customLat = it },
                            label = { Text("Lat", fontSize = 11.sp) },
                            modifier = Modifier.weight(1f),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = customLng,
                            onValueChange = { customLng = it },
                            label = { Text("Lng", fontSize = 11.sp) },
                            modifier = Modifier.weight(1f),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            singleLine = true
                        )
                        Button(
                            onClick = {
                                val lat = customLat.toDoubleOrNull()
                                val lng = customLng.toDoubleOrNull()
                                if (lat != null && lng != null) {
                                    val target = LatLng(lat, lng)
                                    val currentLoc = vehicleLocation?.let { LatLng(it.lat, it.lng) }
                                        ?: LatLng(12.9716, 77.5946)
                                    viewModel.fetchDirections(currentLoc, target, "Custom Destination")
                                    selectedDest = PredefinedDestination("Custom Destination", target, false)
                                }
                            },
                            contentPadding = PaddingValues(horizontal = 12.dp)
                        ) {
                            Text("Set")
                        }
                    }

                    if (viewModel.destinationCoordinates != null) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Button(
                            onClick = {
                                selectedDest = null
                                customLat = ""
                                customLng = ""
                                viewModel.clearActiveRoute()
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Clear Routing")
                        }
                    }
                }
            }

            // Emergency Specific Options
            if (isEmergencyFlag) {
                Spacer(modifier = Modifier.height(12.dp))
                ElevatedCard(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = if (alertActive) Color(0xFFFFEBEE) else MaterialTheme.colorScheme.surface)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("Emergency Corridor Controls", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = Color.Red)
                        Spacer(modifier = Modifier.height(8.dp))

                        Button(
                            onClick = {
                                alertActive = !alertActive
                                if (alertActive) {
                                    viewModel.setEmergencyAlert("ALERT: Emergency vehicle ($vehicleId) approaching! Yield lane.")
                                } else {
                                    viewModel.setEmergencyAlert(null)
                                }
                            },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (alertActive) Color.Red else MaterialTheme.colorScheme.secondary
                            ),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Icon(Icons.Default.Warning, contentDescription = "Emergency Alert")
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(if (alertActive) "Cancel Emergency Clear-Path Broadcast" else "Broadcast Emergency Clear-Path")
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Presentation / Simulation Card
            ElevatedCard(
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text("Presentation & Simulation Tools", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                    Spacer(modifier = Modifier.height(8.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Record Travel (24h Log):")
                        Switch(
                            checked = viewModel.isRecordingHistory,
                            onCheckedChange = { viewModel.setRecording(it) }
                        )
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Simulate Route Traffic/Congestion:")
                        Switch(
                            checked = viewModel.isRouteCongested,
                            onCheckedChange = { viewModel.isRouteCongested = it }
                        )
                    }
                    Text(
                        "Mock: recolours the route line only. No live traffic data is used.",
                        fontSize = 11.sp,
                        color = Color.Gray
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    if (!viewModel.isSimulatingActive) {
                        Column {
                            // Preset Loop Drive
                            OutlinedButton(
                                onClick = {
                                    viewModel.isSimulatingActive = true
                                    viewModel.activeSimulationMode = "PRESET"
                                    toggleSimulation(context, "PRESET", true)
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Simulate 24h Preset Demo (Loop)")
                            }
                            
                            Spacer(modifier = Modifier.height(6.dp))

                            // Route simulation if destination set
                            if (viewModel.destinationCoordinates != null) {
                                OutlinedButton(
                                    onClick = {
                                        viewModel.isSimulatingActive = true
                                        viewModel.activeSimulationMode = "ROUTE"
                                        toggleSimulation(context, "ROUTE", true)
                                    },
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Text("Simulate Driving to Destination")
                                }
                                Spacer(modifier = Modifier.height(6.dp))
                            }

                            // Replay Saved history
                            OutlinedButton(
                                onClick = {
                                    viewModel.isSimulatingActive = true
                                    viewModel.activeSimulationMode = "HISTORY"
                                    toggleSimulation(context, "HISTORY", true)
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Replay Recorded Telemetry History")
                            }
                        }
                    } else {
                        Button(
                            onClick = {
                                viewModel.isSimulatingActive = false
                                toggleSimulation(context, "", false)
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Stop Simulation & Resume Live GPS")
                        }
                    }
                }
            }
        }
    }
}

private fun toggleSimulation(context: Context, mode: String, start: Boolean) {
    val intent = Intent(context, TelemetryService::class.java).apply {
        if (start) {
            action = "START_SIMULATION"
            putExtra("SIMULATION_MODE", mode)
        } else {
            action = "STOP_SIMULATION"
        }
    }
    context.startService(intent)
}
