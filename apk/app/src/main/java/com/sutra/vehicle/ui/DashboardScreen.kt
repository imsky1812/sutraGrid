package com.sutra.vehicle.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.android.gms.maps.CameraUpdateFactory
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

private val SHEET_PEEK_HEIGHT = 190.dp

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

    val cameraPositionState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(LatLng(12.9716, 77.5946), 14f)
    }

    // The camera used to be reset to a fixed zoom on every telemetry update,
    // which at a 1-3 second cadence meant the driver could never pan or zoom
    // without it snapping back. Following is now a mode the driver controls,
    // and any map gesture turns it off.
    var isFollowing by remember { mutableStateOf(true) }

    LaunchedEffect(cameraPositionState.isMoving) {
        if (cameraPositionState.isMoving &&
            cameraPositionState.cameraMoveStartedReason == CameraMoveStartedReason.GESTURE
        ) {
            isFollowing = false
        }
    }

    LaunchedEffect(vehicleLocation, isFollowing) {
        if (isFollowing) {
            vehicleLocation?.let {
                // Recentre without forcing a zoom level, so the driver's chosen
                // zoom survives following.
                cameraPositionState.animate(
                    CameraUpdateFactory.newLatLng(LatLng(it.lat, it.lng))
                )
            }
        }
    }

    val scaffoldState = rememberBottomSheetScaffoldState()

    BottomSheetScaffold(
        scaffoldState = scaffoldState,
        sheetPeekHeight = SHEET_PEEK_HEIGHT,
        sheetContainerColor = MaterialTheme.colorScheme.surface,
        sheetContent = {
            // The map is the primary surface; controls live one swipe away
            // instead of permanently taking half the screen.
            DashboardControls(
                context = context,
                vehicleId = vehicleId,
                isEmergencyFlag = isEmergencyFlag,
                viewModel = viewModel
            )
        }
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            GoogleMap(
                modifier = Modifier.fillMaxSize(),
                cameraPositionState = cameraPositionState,
                properties = MapProperties(isMyLocationEnabled = true),
                uiSettings = MapUiSettings(
                    zoomControlsEnabled = false,
                    myLocationButtonEnabled = false
                ),
                // Keeps Google's attribution and controls clear of the sheet.
                contentPadding = PaddingValues(
                    top = 72.dp,
                    bottom = SHEET_PEEK_HEIGHT
                ),
                onMapLongClick = { latLng ->
                    val currentLoc = vehicleLocation?.let { LatLng(it.lat, it.lng) }
                        ?: LatLng(12.9716, 77.5946)
                    viewModel.fetchDirections(currentLoc, latLng, "Pinned Destination")
                }
            ) {
                vehicleLocation?.let {
                    Marker(
                        state = MarkerState(position = LatLng(it.lat, it.lng)),
                        title = "$vehicleId (You)",
                        snippet = "Speed: ${it.speed.toInt()} km/h",
                        icon = BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_CYAN)
                    )
                }

                // Only drawn when a real Directions result is loaded. There is
                // deliberately no placeholder line here: a stray polyline is
                // indistinguishable from a real route on the map.
                if (viewModel.directionsRoute.isNotEmpty()) {
                    Polyline(
                        points = viewModel.directionsRoute,
                        color = if (viewModel.isRouteCongested) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.primary
                        },
                        width = 16f,
                        jointType = JointType.ROUND,
                        startCap = RoundCap(),
                        endCap = RoundCap()
                    )
                }

                viewModel.destinationCoordinates?.let {
                    Marker(
                        state = MarkerState(position = it),
                        title = viewModel.destinationName ?: "Destination",
                        icon = BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED)
                    )
                }

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

            // Floating header over the map.
            Surface(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .padding(12.dp),
                shape = RoundedCornerShape(12.dp),
                tonalElevation = 3.dp,
                shadowElevation = 6.dp
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("SUTRA Live View", fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        Text(
                            "$vehicleId · $vehicleType",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 12.sp
                        )
                    }

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
            }

            // Only offered when it would do something, so it does not sit on the
            // map as a permanently inert control.
            if (!isFollowing) {
                ExtendedFloatingActionButton(
                    onClick = { isFollowing = true },
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 16.dp, bottom = SHEET_PEEK_HEIGHT + 16.dp),
                    containerColor = MaterialTheme.colorScheme.primaryContainer
                ) {
                    Icon(Icons.Default.LocationOn, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Recenter")
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DashboardControls(
    context: Context,
    vehicleId: String,
    isEmergencyFlag: Boolean,
    viewModel: DashboardViewModel
) {
    val vehicleLocation = viewModel.vehicleLocation

    var showDestMenu by remember { mutableStateOf(false) }
    var selectedDest by remember { mutableStateOf<PredefinedDestination?>(null) }
    var alertActive by remember { mutableStateOf(false) }
    var customLat by remember { mutableStateOf("") }
    var customLng by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            // The sheet clips content taller than its expanded height, so the
            // control stack has to scroll inside it.
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // --- Live stats: the peek-height content, so the numbers a driver
        // glances at are visible without opening the sheet. ---
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Bottom
        ) {
            Column {
                Text(
                    "SPEED",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    if (vehicleLocation != null) "${vehicleLocation.speed.toInt()} km/h" else "--",
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
            }

            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "POSITION",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                // An explicit waiting state: the old screen showed "0.0, 0.0"
                // before the first fix, which reads as a fault.
                Text(
                    if (vehicleLocation != null) {
                        "%.5f, %.5f".format(vehicleLocation.lat, vehicleLocation.lng)
                    } else {
                        "Acquiring GPS…"
                    },
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium
                )
            }
        }

        if (viewModel.destinationName != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text("Destination:", fontSize = 13.sp)
                Text(
                    viewModel.destinationName ?: "",
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp
                )
            }
            if (viewModel.directionsRoute.isEmpty()) {
                Text(
                    "No route found. Check API key and network.",
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 11.sp
                )
            } else {
                Text(
                    "Route loaded (${viewModel.directionsRoute.size} points)",
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = 11.sp
                )
            }
        }

        Divider()

        // --- Destination ---
        Text("Set Destination", fontWeight = FontWeight.Bold, fontSize = 15.sp)

        Box(modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(
                onClick = { showDestMenu = true },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(selectedDest?.name ?: "Select Predefined Destination")
            }

            DropdownMenu(
                expanded = showDestMenu,
                onDismissRequest = { showDestMenu = false }
            ) {
                PREDEFINED_DESTINATIONS.forEach { dest ->
                    DropdownMenuItem(
                        text = { Text(dest.name + if (dest.isEmergency) " (Emergency)" else "") },
                        onClick = {
                            selectedDest = dest
                            showDestMenu = false
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

        Text(
            "Or enter coordinates, or long-press the map",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

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
            Button(
                onClick = {
                    selectedDest = null
                    customLat = ""
                    customLng = ""
                    viewModel.clearActiveRoute()
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Clear Routing")
            }
        }

        // --- Emergency ---
        if (isEmergencyFlag) {
            Divider()
            Text(
                "Emergency Corridor Controls",
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
                color = MaterialTheme.colorScheme.error
            )

            Button(
                onClick = {
                    alertActive = !alertActive
                    viewModel.setEmergencyAlert(
                        if (alertActive) {
                            "ALERT: Emergency vehicle ($vehicleId) approaching! Yield lane."
                        } else {
                            null
                        }
                    )
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (alertActive) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.secondary
                    }
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(Icons.Default.Warning, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    if (alertActive) {
                        "Cancel Clear-Path Broadcast"
                    } else {
                        "Broadcast Emergency Clear-Path"
                    }
                )
            }
        }

        // --- Simulation ---
        Divider()
        Text("Presentation & Simulation Tools", fontWeight = FontWeight.Bold, fontSize = 15.sp)

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Record travel history")
            Switch(
                checked = viewModel.isRecordingHistory,
                onCheckedChange = { viewModel.setRecording(it) }
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Simulate route congestion")
            Switch(
                checked = viewModel.isRouteCongested,
                onCheckedChange = { viewModel.isRouteCongested = it }
            )
        }
        Text(
            "Mock: recolours the route line only. No live traffic data is used.",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        if (!viewModel.isSimulatingActive) {
            OutlinedButton(
                onClick = {
                    viewModel.isSimulatingActive = true
                    viewModel.activeSimulationMode = "PRESET"
                    toggleSimulation(context, "PRESET", true)
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Simulate Preset Demo Loop")
            }

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
            }

            OutlinedButton(
                onClick = {
                    viewModel.isSimulatingActive = true
                    viewModel.activeSimulationMode = "HISTORY"
                    toggleSimulation(context, "HISTORY", true)
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Replay Recorded History")
            }
        } else {
            Button(
                onClick = {
                    viewModel.isSimulatingActive = false
                    toggleSimulation(context, "", false)
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.secondary
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Stop Simulation & Resume Live GPS")
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
