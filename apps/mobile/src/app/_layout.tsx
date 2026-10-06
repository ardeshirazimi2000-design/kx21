import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../lib/auth';
import { useTheme } from '../lib/theme';

export default function RootLayout() {
  const t = useTheme();
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerTitleAlign: 'center',
            headerStyle: { backgroundColor: t.surface },
            headerTintColor: t.primary,
            headerTitleStyle: { color: t.text },
            contentStyle: { backgroundColor: t.bg },
            headerBackTitle: 'بازگشت',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="meeting/[id]" options={{ title: 'اتاق جلسه' }} />
          <Stack.Screen name="resolution/[id]" options={{ title: 'مصوبه' }} />
        </Stack>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
