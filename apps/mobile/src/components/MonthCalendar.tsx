import { formatTime, JALALI_MONTHS, jalaliMonthLength, toGregorian, toJalali } from '@kx/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { useApi } from '../lib/useApi';
import { Button, Card, fa, Row, T } from './ui';

/**
 * Month view of the Jalali calendar (Saturday on the right): holidays — Fridays, official and the chamber's own —
 * in red with their occasion, and the user's meetings; tapping a day lists its meetings.
 */

type Holiday = { date: string; title: string; source: 'friday' | 'national' | 'chamber' };
const WEEK = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
const pad = (n: number) => String(n).padStart(2, '0');
const gDay = (jy: number, jm: number, jd: number) => {
  const [y, m, d] = toGregorian(jy, jm, jd);
  return `${y}-${pad(m)}-${pad(d)}`;
};
const jOf = (d: Date) => toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());

export function MonthCalendar() {
  const t = useTheme();
  const { me } = useAuth();
  const today = jOf(new Date());
  const [[jy, jm], setMonth] = useState<[number, number]>([today[0], today[1]]);
  const [picked, setPicked] = useState<number | null>(today[2]);
  const days = jalaliMonthLength(jy, jm);
  const chamberId = me?.memberships[0]?.chamber_id ?? me?.chamber_id ?? null;

  const [gy, gm, gd] = toGregorian(jy, jm, 1);
  const from = new Date(gy, gm - 1, gd);
  const to = new Date(from.getTime() + days * 86400000);
  const meetings = useApi<{ items: any[] }>(`/meetings?mine=true&from=${from.toISOString()}&to=${to.toISOString()}&pageSize=100`);
  const holidays = useApi<Holiday[]>(`/holidays?${chamberId ? `chamberId=${chamberId}&` : ''}from=${gDay(jy, jm, 1)}&to=${gDay(jy, jm, days)}`);
  const holidayOf = new Map((holidays.data ?? []).map((h) => [h.date, h]));
  const byDay = new Map<number, any[]>();
  for (const m of meetings.data?.items ?? []) {
    const [y, mo, d] = jOf(new Date(m.scheduled_at));
    if (y === jy && mo === jm) byDay.set(d, [...(byDay.get(d) ?? []), m]);
  }

  const shift = (delta: number) => {
    const n = jy * 12 + (jm - 1) + delta;
    setMonth([Math.floor(n / 12), (n % 12) + 1]);
    setPicked(null);
  };
  // Column of day 1: Saturday = 0 … Friday = 6.
  const lead = (from.getDay() + 1) % 7;
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));

  const pickedHoliday = picked ? holidayOf.get(gDay(jy, jm, picked)) : undefined;
  const pickedMeetings = picked ? (byDay.get(picked) ?? []) : [];
  const isToday = (d: number) => today[0] === jy && today[1] === jm && today[2] === d;

  return (
    <>
      <Card>
        <Row>
          <Button title="ماه قبل" variant="ghost" onPress={() => shift(-1)} />
          <T bold size={16}>
            {JALALI_MONTHS[jm - 1]} {fa(jy)}
          </T>
          <Button title="ماه بعد" variant="ghost" onPress={() => shift(1)} />
        </Row>
        {(jy !== today[0] || jm !== today[1]) && (
          <Button
            title="برگشت به امروز"
            variant="secondary"
            onPress={() => {
              setMonth([today[0], today[1]]);
              setPicked(today[2]);
            }}
          />
        )}
        <View style={{ flexDirection: 'row-reverse' }}>
          {WEEK.map((w, i) => (
            <Text key={w} style={{ flex: 1, textAlign: 'center', color: i === 6 ? t.danger : t.muted, fontSize: 12, paddingVertical: 4 }}>
              {w}
            </Text>
          ))}
        </View>
        {weeks.map((week, wi) => (
          <View key={wi} style={{ flexDirection: 'row-reverse' }}>
            {week.map((d, i) => {
              if (d === null) return <View key={`e${i}`} style={{ flex: 1, minHeight: 58 }} />;
              const h = holidayOf.get(gDay(jy, jm, d));
              const items = byDay.get(d) ?? [];
              const red = !!h || i === 6;
              const selected = picked === d;
              return (
                <Pressable
                  key={d}
                  onPress={() => setPicked(d)}
                  accessibilityLabel={`${fa(d)} ${JALALI_MONTHS[jm - 1]}${h ? `، تعطیل: ${h.title}` : ''}${items.length ? `، ${fa(items.length)} جلسه` : ''}`}
                  style={{
                    flex: 1,
                    minHeight: 58,
                    margin: 1,
                    borderRadius: 8,
                    padding: 3,
                    alignItems: 'center',
                    backgroundColor: selected ? t.primarySoft : h && h.source !== 'friday' ? t.dangerSoft : 'transparent',
                    borderWidth: isToday(d) ? 2 : 0,
                    borderColor: t.primary,
                  }}
                >
                  <Text style={{ color: red ? t.danger : t.text, fontWeight: isToday(d) ? '700' : '500', fontSize: 15 }}>{fa(d)}</Text>
                  {h && h.source !== 'friday' && (
                    <Text numberOfLines={2} style={{ color: t.danger, fontSize: 8, textAlign: 'center', lineHeight: 11 }}>
                      {h.title.replace(/،? ?جمعه$/, '')}
                    </Text>
                  )}
                  {items.length > 0 && (
                    <View style={{ flexDirection: 'row', gap: 2, marginTop: 2 }}>
                      {items.slice(0, 3).map((m) => (
                        <View key={m.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: m.status === 'cancelled' ? t.muted : t.primary }} />
                      ))}
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}
        <T muted size={12}>
          روزهای قرمز تعطیل‌اند؛ نقطه یعنی جلسه دارید. روی هر روز بزنید تا جزئیاتش را ببینید.
        </T>
      </Card>
      {picked !== null && (
        <Card title={`${fa(picked)} ${JALALI_MONTHS[jm - 1]} ${fa(jy)}`}>
          {pickedHoliday && <T color={t.danger}>تعطیل: {pickedHoliday.title}</T>}
          {pickedMeetings.length === 0 && <T muted>جلسه‌ای در این روز ندارید.</T>}
          {pickedMeetings.map((m) => (
            <Pressable key={m.id} onPress={() => router.push(`/meeting/${m.id}`)} style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: 8 }}>
              <T bold>
                {fa(formatTime(m.scheduled_at))} — {m.title}
              </T>
              <T muted size={13}>
                {m.commission_name}
                {m.location ? ` — ${m.location}` : ''}
              </T>
            </Pressable>
          ))}
        </Card>
      )}
    </>
  );
}
