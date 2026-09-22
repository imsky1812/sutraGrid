import { supabase } from './supabase';

export type Alert = {
  id: number;
  vehicle_id: string | null;
  category: 'CONGESTION' | 'RULE' | 'HAZARD' | 'MESSAGE' | 'EMERGENCY';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  created_at: string;
  expires_at: string;
};

export const CATEGORY_GLYPH: Record<Alert['category'], string> = {
  CONGESTION: '🚧',
  RULE: '⚠️',
  HAZARD: '⛔',
  MESSAGE: '💬',
  EMERGENCY: '🚑',
};

/**
 * An alert applies to this vehicle if it is addressed to it or is a broadcast.
 *
 * Row-level security already guarantees the client only receives alerts it is
 * entitled to, so this is about relevance rather than access: a driver running
 * one vehicle should not see an alert aimed at another of their own vehicles.
 */
export function appliesTo(alert: Alert, vehicleId: string): boolean {
  return alert.vehicle_id === null || alert.vehicle_id === vehicleId;
}

export function isLive(alert: Alert, now: number = Date.now()): boolean {
  return new Date(alert.expires_at).getTime() > now;
}

/** Alerts still in force for this vehicle, newest first. */
export async function fetchActiveAlerts(vehicleId: string): Promise<Alert[]> {
  const { data, error } = await supabase
    .from('alerts')
    .select('id, vehicle_id, category, severity, message, created_at, expires_at')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(error.message);
  return (data ?? []).filter((a) => appliesTo(a as Alert, vehicleId)) as Alert[];
}

/**
 * Subscribe to alerts for one vehicle. Returns an unsubscribe function.
 */
export function subscribeToAlerts(vehicleId: string, onAlert: (alert: Alert) => void): () => void {
  const channel = supabase
    .channel(`alerts-${vehicleId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'alerts' },
      (payload) => {
        const alert = payload.new as Alert;
        if (appliesTo(alert, vehicleId) && isLive(alert)) onAlert(alert);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/** Tell the operator the alert landed. Failure is not worth surfacing. */
export async function acknowledgeAlert(alertId: number, vehicleId: string): Promise<void> {
  await supabase.from('alert_receipts').insert({ alert_id: alertId, vehicle_id: vehicleId });
}
