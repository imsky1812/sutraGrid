import { supabase } from './supabase';

export type Vehicle = {
  id: string;
  vehicle_number: string;
  driver_name: string;
  vehicle_type: string;
  is_emergency_authorized: boolean;
};

// Mirrors the character set the database accepts. The vehicle number is
// rendered in the operator dashboard, so the set is deliberately narrow rather
// than merely length-capped.
const VEHICLE_NUMBER_PATTERN = /^[A-Za-z0-9 _-]+$/;
const MAX_VEHICLE_NUMBER = 32;

export function validateVehicleNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Vehicle number is required.';
  if (trimmed.length > MAX_VEHICLE_NUMBER) {
    return `Vehicle number must be at most ${MAX_VEHICLE_NUMBER} characters.`;
  }
  if (!VEHICLE_NUMBER_PATTERN.test(trimmed)) {
    return 'Use only letters, digits, spaces, hyphens and underscores.';
  }
  return null;
}

/** RLS restricts this to vehicles owned by the signed-in user. */
export async function listMyVehicles(): Promise<Vehicle[]> {
  const { data, error } = await supabase
    .from('vehicles')
    .select('id, vehicle_number, driver_name, vehicle_type, is_emergency_authorized')
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function registerVehicle(input: {
  vehicleNumber: string;
  driverName: string;
  vehicleType?: string;
}): Promise<Vehicle> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error('Not signed in.');

  const { data, error } = await supabase
    .from('vehicles')
    .insert({
      owner: userData.user.id,
      vehicle_number: input.vehicleNumber.trim(),
      driver_name: input.driverName.trim(),
      vehicle_type: input.vehicleType ?? 'NORMAL',
      // is_emergency_authorized is deliberately not sent. The database trigger
      // rejects any attempt to set it; an administrator grants it out of band.
    })
    .select('id, vehicle_number, driver_name, vehicle_type, is_emergency_authorized')
    .single();

  if (error) throw new Error(error.message);
  return data;
}
