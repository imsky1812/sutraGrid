package com.sutra.vehicle.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.maps.android.compose.*

@Composable
fun DashboardScreen(
    vehicleId: String,
    vehicleType: String,
    isEmergencyFlag: Boolean,
    onStopStreaming: () -> Unit,
    viewModel: DashboardViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
) {
    val vehicleLocation = viewModel.vehicleLocation
    var isEmergencyActive by remember { mutableStateOf(isEmergencyFlag) }

    val cameraPositionState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(LatLng(0.0, 0.0), 15f)
    }

    LaunchedEffect(vehicleLocation) {
        vehicleLocation?.let {
            cameraPositionState.position = CameraPosition.fromLatLngZoom(
                LatLng(it.lat, it.lng), 17f
            )
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(modifier = Modifier.height(24.dp))
        Text("SUTRA Live View", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text("Vehicle: $vehicleId | Type: $vehicleType", color = Color.Gray)
        
        Spacer(modifier = Modifier.height(32.dp))

        // Stats Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Live Telemetry", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(16.dp))
                
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Speed:")
                    Text("${vehicleLocation?.speed ?: 0f} km/h", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                }
                Spacer(modifier = Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Location:")
                    Text("${vehicleLocation?.lat ?: 0.0}, ${vehicleLocation?.lng ?: 0.0}", fontWeight = FontWeight.Bold)
                }
                Spacer(modifier = Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Status:")
                    Text(if (isEmergencyActive) "EMERGENCY" else "NORMAL", 
                        fontWeight = FontWeight.Bold, 
                        color = if (isEmergencyActive) Color.Red else Color.Green)
                }
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        if (isEmergencyFlag) {
            Button(
                onClick = { isEmergencyActive = !isEmergencyActive },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isEmergencyActive) Color.DarkGray else Color.Red
                ),
                modifier = Modifier.fillMaxWidth().height(50.dp)
            ) {
                Text(if (isEmergencyActive) "Deactivate Emergency Mode" else "Activate Emergency Mode")
            }
            Spacer(modifier = Modifier.height(16.dp))
        }

        OutlinedButton(
            onClick = onStopStreaming,
            modifier = Modifier.fillMaxWidth().height(50.dp)
        ) {
            Text("Stop Transmitting & Logout")
        }
        
        Spacer(modifier = Modifier.height(32.dp))
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
                uiSettings = MapUiSettings(zoomControlsEnabled = true)
            ) {
                vehicleLocation?.let {
                    Marker(
                        state = MarkerState(position = LatLng(it.lat, it.lng)),
                        title = vehicleId,
                        snippet = "Speed: ${it.speed} km/h"
                    )
                }
            }
        }
    }
}
