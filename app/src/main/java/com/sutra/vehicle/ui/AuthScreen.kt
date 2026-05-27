package com.sutra.vehicle.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sutra.vehicle.data.VehicleType

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuthScreen(onLoginSuccess: (String, String, String, Boolean) -> Unit) {
    var name by remember { mutableStateOf("") }
    var phoneNumber by remember { mutableStateOf("") }
    var vehicleId by remember { mutableStateOf("") }
    
    var isEmergency by remember { mutableStateOf(false) }
    var emergencyCode by remember { mutableStateOf("") }
    var selectedVehicleType by remember { mutableStateOf(VehicleType.NORMAL) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text("SUTRA Vehicle Client", fontSize = 28.sp, color = MaterialTheme.colorScheme.primary)
        Spacer(modifier = Modifier.height(32.dp))

        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Driver Name") },
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(16.dp))
        
        OutlinedTextField(
            value = phoneNumber,
            onValueChange = { phoneNumber = it },
            label = { Text("Phone Number (Optional)") },
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = vehicleId,
            onValueChange = { vehicleId = it },
            label = { Text("Vehicle Number (Unique ID)") },
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(24.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Checkbox(
                checked = isEmergency,
                onCheckedChange = { 
                    isEmergency = it
                    if (!it) selectedVehicleType = VehicleType.NORMAL 
                }
            )
            Text("Emergency Vehicle")
        }

        if (isEmergency) {
            Spacer(modifier = Modifier.height(16.dp))
            OutlinedTextField(
                value = emergencyCode,
                onValueChange = { emergencyCode = it },
                label = { Text("Emergency Authorization Code") },
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(16.dp))
            
            // Basic dropdown/selector alternative
            Text("Select Emergency Type:")
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                FilterChip(
                    selected = selectedVehicleType == VehicleType.AMBULANCE,
                    onClick = { selectedVehicleType = VehicleType.AMBULANCE },
                    label = { Text("Ambulance") }
                )
                FilterChip(
                    selected = selectedVehicleType == VehicleType.POLICE,
                    onClick = { selectedVehicleType = VehicleType.POLICE },
                    label = { Text("Police") }
                )
                FilterChip(
                    selected = selectedVehicleType == VehicleType.FIRE,
                    onClick = { selectedVehicleType = VehicleType.FIRE },
                    label = { Text("Fire") }
                )
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        Button(
            onClick = {
                println("DEBUG: Login clicked for $name, $vehicleId")
                if (isEmergency && emergencyCode.isEmpty()) {
                    return@Button
                }
                onLoginSuccess(name, vehicleId, selectedVehicleType.name, isEmergency)
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp)
        ) {
            Text("Login & Connect")
        }
    }
}
