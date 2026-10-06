import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Button, Card, ErrorText, Input, T } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

export default function LoginScreen() {
  const t = useTheme();
  const { login, verifyMfa } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await verifyMfa(mfaToken, code);
        router.replace('/');
      } else {
        const r = await login(identifier.trim(), password);
        if (r.mfaToken) setMfaToken(r.mfaToken);
        else router.replace('/');
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.primary, justifyContent: 'center', padding: 20 }}>
      <View style={{ alignItems: 'center', marginBottom: 24 }}>
        <T bold size={22} color="#fff">
          سامانه کمیسیون‌های تخصصی
        </T>
        <T color="#d6e6ea">اتاق بازرگانی، صنایع، معادن و کشاورزی</T>
      </View>
      <Card>
        <ErrorText error={error} />
        {!mfaToken ? (
          <>
            <Input label="ایمیل یا شماره موبایل" autoCapitalize="none" keyboardType="email-address" value={identifier} onChangeText={setIdentifier} style={{ textAlign: 'left' }} />
            <Input label="رمز عبور" secureTextEntry value={password} onChangeText={setPassword} style={{ textAlign: 'left' }} />
          </>
        ) : (
          <Input label="کد تأیید دومرحله‌ای" keyboardType="number-pad" maxLength={6} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} style={{ textAlign: 'center', letterSpacing: 6 }} />
        )}
        <Button title={mfaToken ? 'تأیید' : 'ورود'} onPress={submit} busy={busy} big />
      </Card>
    </KeyboardAvoidingView>
  );
}
