import { ROLE_LABELS, type Position } from '@kx/shared';
import { router } from 'expo-router';
import { Badge, Button, Card, Row, Screen, T } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { getApiUrl } from '../../lib/config';

export default function ProfileScreen() {
  const { me, logout } = useAuth();
  if (!me) return null;
  return (
    <Screen>
      <Card>
        <T bold size={18}>{me.full_name}</T>
        <T muted>{me.organization ?? ''}</T>
        <T muted>{me.email ?? me.mobile ?? ''}</T>
      </Card>
      <Card title="عضویت‌ها">
        {me.memberships.map((m) => (
          <Row key={m.id}>
            <T>{m.commission_name}</T>
            <Badge tone="info" label={ROLE_LABELS[m.position as Position]} />
          </Row>
        ))}
      </Card>
      <Card title="تنظیمات">
        <T muted size={13}>سرور: {getApiUrl()}</T>
        <T muted size={13}>اعلان‌ها از طریق Push و داخل برنامه دریافت می‌شوند. تغییر رمز و فعال‌سازی ورود دومرحله‌ای از نسخه وب انجام می‌شود.</T>
      </Card>
      <Button
        title="خروج از حساب"
        variant="danger"
        onPress={async () => {
          await logout();
          router.replace('/login');
        }}
      />
    </Screen>
  );
}
