import { router } from 'expo-router';
import { useState } from 'react';
import { Image, View } from 'react-native';
import { Button, Card, ErrorText, Input, KeyboardScroll, T } from '../components/ui';
import { useAuth } from '../lib/auth';
import { ApiError, get } from '../lib/api';
import { getApiUrl, reachableServerUrl, setApiUrl } from '../lib/config';
import { useTheme } from '../lib/theme';

export default function LoginScreen() {
  const t = useTheme();
  const { login, verifyMfa } = useAuth();
  const [server, setServer] = useState(() => (getApiUrl().includes('localhost') ? '' : getApiUrl().replace(/^https?:\/\//, '')));
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // After repeated failed sign-ins the server asks for the number in an image (a CAPTCHA).
  const [captcha, setCaptcha] = useState<{ id: string; image: string } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const loadCaptcha = async () => {
    setCaptchaAnswer('');
    setCaptcha(await get('/auth/captcha').catch(() => null));
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await verifyMfa(mfaToken, code);
        router.replace('/');
      } else {
        if (!server.trim()) throw new Error('آدرس سرور را وارد کنید');
        const base = await reachableServerUrl(server);
        if (!base) throw new Error(`سرور ${server.trim()} در دسترس نیست؛ آدرس، اتصال اینترنت و نصب گواهی امنیتی سامانه را بررسی کنید`);
        await setApiUrl(base);
        const r = await login(identifier.trim(), password, captcha ? { captchaId: captcha.id, captchaAnswer } : undefined);
        if (r.mfaToken) setMfaToken(r.mfaToken);
        else router.replace('/');
      }
    } catch (e) {
      setError(e as Error);
      // Each image is good for one attempt: a new one while the server still wants it.
      const wants = e instanceof ApiError && (e.code === 'captcha_required' || (e.details as any)?.captchaRequired);
      if (wants) await loadCaptcha();
      else setCaptcha(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: t.primary }}>
      <KeyboardScroll contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 20, paddingTop: 48, paddingBottom: 32 }}>
      <View style={{ alignItems: 'center', marginBottom: 24, gap: 8 }}>
        <Image source={require('../../assets/iran-chamber-logo.png')} style={{ width: 96, height: 96 }} accessibilityLabel="لوگوی اتاق ایران" />
        <T bold size={18} color="#fff" style={{ textAlign: 'center' }}>
          اتاق بازرگانی، صنایع، معادن و کشاورزی ایران
        </T>
        <T color="#d6e6ea" style={{ textAlign: 'center' }}>
          سامانه کمیسیون‌های تخصصی
        </T>
      </View>
      <Card>
        <ErrorText error={error} />
        {!mfaToken ? (
          <>
            <Input
              label="آدرس سرور"
              placeholder="مثال: 185.10.20.30:5000"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={server}
              onChangeText={setServer}
              style={{ textAlign: 'left' }}
            />
            <Input label="ایمیل یا شماره موبایل" autoCapitalize="none" keyboardType="email-address" value={identifier} onChangeText={setIdentifier} style={{ textAlign: 'left' }} />
            <Input label="رمز عبور" secureTextEntry value={password} onChangeText={setPassword} style={{ textAlign: 'left' }} />
            {captcha && (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 12 }}>
                  <Image source={{ uri: captcha.image }} style={{ width: 180, height: 60, borderRadius: 8, backgroundColor: '#fff' }} accessibilityLabel="کد امنیتی" />
                  <Button title="تصویر دیگر" variant="ghost" onPress={() => void loadCaptcha()} />
                </View>
                <Input label="عدد داخل تصویر" keyboardType="number-pad" maxLength={5} value={captchaAnswer} onChangeText={setCaptchaAnswer} style={{ textAlign: 'center', letterSpacing: 6 }} />
              </View>
            )}
          </>
        ) : (
          <Input label="کد تأیید دومرحله‌ای" keyboardType="number-pad" maxLength={6} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} style={{ textAlign: 'center', letterSpacing: 6 }} />
        )}
        <Button title={mfaToken ? 'تأیید' : 'ورود'} onPress={submit} busy={busy} big />
      </Card>
      </KeyboardScroll>
    </View>
  );
}
