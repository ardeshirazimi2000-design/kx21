import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

/** Adds a meeting to the device calendar. Returns false if permission was denied or no writable calendar exists. */
export async function addMeetingToCalendar(m: { title: string; start: Date; durationMinutes: number; location?: string | null; notes?: string }) {
  const perm = await Calendar.requestCalendarPermissions();
  if (!perm.granted) return false;
  const endDate = new Date(m.start.getTime() + m.durationMinutes * 60000);
  let calendar: Calendar.ExpoCalendar | undefined;
  if (Platform.OS === 'ios') {
    calendar = Calendar.getDefaultCalendarSync();
  } else {
    const all = await Calendar.getCalendars();
    calendar = all.find((c) => c.isPrimary && c.allowsModifications) ?? all.find((c) => c.allowsModifications);
  }
  if (!calendar) return false;
  await calendar.createEvent({
    title: m.title,
    startDate: m.start,
    endDate,
    location: m.location ?? undefined,
    notes: m.notes,
    alarms: [{ relativeOffset: -60 }],
  });
  return true;
}
