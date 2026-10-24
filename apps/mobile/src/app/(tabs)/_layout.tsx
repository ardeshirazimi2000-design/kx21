import { Redirect, Tabs } from 'expo-router';
import { toPersianDigits } from '@kx/shared';
import { useEffect } from 'react';
import { AppState, Text, type ColorValue } from 'react-native';
import { Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { onUnreadChanged } from '../../lib/push';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/useApi';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const { me, ready } = useAuth();
  const t = useTheme();
  const unread = useApi<{ total: number }>(me ? '/notifications?unread=true&pageSize=1' : null);
  useEffect(() => onUnreadChanged(() => void unread.reload()), [unread.reload]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => st === 'active' && void unread.reload());
    return () => sub.remove();
  }, [unread.reload]);
  if (!ready) return <Loading />;
  if (!me) return <Redirect href="/login" />;
  // Tabs are declared left-to-right; listed in reverse so «خانه» sits at the right edge (RTL).
  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerTitleAlign: 'center',
        headerStyle: { backgroundColor: t.surface },
        headerTitleStyle: { color: t.text },
        tabBarActiveTintColor: t.primary,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="profile" options={{ title: 'پروفایل', tabBarIcon: icon('☺') }} />
      <Tabs.Screen
        name="notifications"
        options={{ title: 'اعلان‌ها', tabBarIcon: icon('🔔'), tabBarBadge: unread.data?.total ? toPersianDigits(Math.min(unread.data.total, 99)) : undefined }}
      />
      <Tabs.Screen name="resolutions" options={{ title: 'مصوبات من', tabBarIcon: icon('✓') }} />
      <Tabs.Screen name="meetings" options={{ title: 'جلسات', tabBarIcon: icon('▦') }} />
      <Tabs.Screen name="index" options={{ title: 'خانه من', tabBarIcon: icon('⌂') }} />
    </Tabs>
  );
}
