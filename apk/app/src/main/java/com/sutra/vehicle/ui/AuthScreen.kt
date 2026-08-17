package com.sutra.vehicle.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sutra.vehicle.data.LoginResult
import com.sutra.vehicle.data.VehicleAuthPayload
import com.sutra.vehicle.data.VehicleType
import com.sutra.vehicle.network.ApiClient
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuthScreen(onLoginSuccess: (LoginResult) -> Unit) {
    var name by remember { mutableStateOf("") }
    var phoneNumber by remember { mutableStateOf("") }
    var vehicleId by remember { mutableStateOf("") }

    var isEmergency by remember { mutableStateOf(false) }
    var emergencyCode by remember { mutableStateOf("") }
    var selectedVehicleType by remember { mutableStateOf(VehicleType.NORMAL) }

    var isSubmitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()

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
            enabled = !isSubmitting,
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = phoneNumber,
            onValueChange = { phoneNumber = it },
            label = { Text("Phone Number (Optional)") },
            enabled = !isSubmitting,
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = vehicleId,
            onValueChange = { vehicleId = it },
            label = { Text("Vehicle Number (Unique ID)") },
            enabled = !isSubmitting,
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(24.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Checkbox(
                checked = isEmergency,
                enabled = !isSubmitting,
                onCheckedChange = {
                    isEmergency = it
                    if (!it) {
                        selectedVehicleType = VehicleType.NORMAL
                        emergencyCode = ""
                    }
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
                supportingText = { Text("Verified by the server. Priority is not granted without it.") },
                visualTransformation = PasswordVisualTransformation(),
                enabled = !isSubmitting,
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(16.dp))

            Text("Select Emergency Type:")
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                FilterChip(
                    selected = selectedVehicleType == VehicleType.AMBULANCE,
                    onClick = { selectedVehicleType = VehicleType.AMBULANCE },
                    enabled = !isSubmitting,
                    label = { Text("Ambulance") }
                )
                FilterChip(
                    selected = selectedVehicleType == VehicleType.POLICE,
                    onClick = { selectedVehicleType = VehicleType.POLICE },
                    enabled = !isSubmitting,
                    label = { Text("Police") }
                )
                FilterChip(
                    selected = selectedVehicleType == VehicleType.FIRE,
                    onClick = { selectedVehicleType = VehicleType.FIRE },
                    enabled = !isSubmitting,
                    label = { Text("Fire") }
                )
            }
        }

        errorMessage?.let { message ->
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = message,
                color = MaterialTheme.colorScheme.error,
                fontSize = 13.sp
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        Button(
            enabled = !isSubmitting,
            onClick = {
                errorMessage = null

                val trimmedName = name.trim()
                val trimmedVehicleId = vehicleId.trim()

                // Local checks are for immediate feedback only. The server
                // re-validates everything, including the emergency code.
                when {
                    trimmedName.isEmpty() -> {
                        errorMessage = "Driver name is required."
                        return@Button
                    }
                    trimmedVehicleId.isEmpty() -> {
                        errorMessage = "Vehicle number is required."
                        return@Button
                    }
                    isEmergency && emergencyCode.isBlank() -> {
                        errorMessage = "An authorization code is required for emergency vehicles."
                        return@Button
                    }
                    isEmergency && selectedVehicleType == VehicleType.NORMAL -> {
                        errorMessage = "Select an emergency vehicle type."
                        return@Button
                    }
                }

                isSubmitting = true
                scope.launch {
                    try {
                        val response = ApiClient.apiService.loginVehicle(
                            VehicleAuthPayload(
                                name = trimmedName,
                                phoneNumber = phoneNumber.trim(),
                                vehicleId = trimmedVehicleId,
                                vehicleType = selectedVehicleType.name,
                                isEmergency = isEmergency,
                                emergencyCode = if (isEmergency) emergencyCode else null
                            )
                        )

                        val body = response.body()
                        if (!response.isSuccessful || body == null || !body.success || body.token == null) {
                            errorMessage = ApiClient.parseErrorMessage(response)
                        } else {
                            // Trust the server's answer about privileges, not the
                            // checkbox, so the dashboard and the driver's own UI
                            // agree on whether priority was actually granted.
                            onLoginSuccess(
                                LoginResult(
                                    token = body.token,
                                    driverName = trimmedName,
                                    vehicleId = trimmedVehicleId,
                                    vehicleType = body.vehicleType ?: selectedVehicleType.name,
                                    isEmergency = body.isEmergency
                                )
                            )
                        }
                    } catch (e: Exception) {
                        errorMessage = "Cannot reach the SUTRA server at ${ApiClient.BASE_URL}. " +
                            "Check that the backend is running and BACKEND_HOST is correct."
                    } finally {
                        isSubmitting = false
                    }
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp)
        ) {
            if (isSubmitting) {
                CircularProgressIndicator(
                    modifier = Modifier.height(20.dp).width(20.dp),
                    strokeWidth = 2.dp,
                    color = Color.White
                )
                Spacer(modifier = Modifier.width(12.dp))
                Text("Authenticating...")
            } else {
                Text("Login & Connect")
            }
        }
    }
}
