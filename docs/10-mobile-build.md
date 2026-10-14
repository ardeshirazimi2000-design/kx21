# ۱۰. ساخت فایل نصبی اپ موبایل (APK)

اپ یک فایل نصبی برای همه سرورهاست. کاربر در صفحه ورود «آدرس سرور» را وارد می‌کند، مثلاً `185.10.20.30:8000`. این آدرس روی گوشی ذخیره می‌شود.

## ساخت محلی (بدون سرویس ابری Expo)

پیش‌نیاز: Node 22، JDK 17، Android SDK (`ANDROID_HOME`).

```bash
npm ci && npm run build -w @kx/shared          # در ریشه مخزن
cd apps/mobile && npm ci
npx expo prebuild --platform android           # پوشه android را می‌سازد (در git نیست)
cd android
# فقط گوشی‌های ۶۴ بیتی (حجم کمتر). برای پوشش گوشی‌های قدیمی: armeabi-v7a,arm64-v8a
sed -i 's/^reactNativeArchitectures=.*/reactNativeArchitectures=arm64-v8a/' gradle.properties
./gradlew assembleRelease
# خروجی: app/build/outputs/apk/release/app-release.apk
```

## نکات انتشار

- نسخه آزمایشی با کلید debug امضا شده است. برای انتشار در بازار یا مایکت باید کلید امضای سازمان (keystore) ساخته و در `android/app/build.gradle` تنظیم شود.
- به‌دلیل HTTP ساده سرور آزمایشی، `usesCleartextTraffic` فعال است. پس از راه‌اندازی HTTPS آن را از `app.json` حذف کنید.
- Push روی گوشی به پروژه EAS و `projectId` نیاز دارد. بدون آن، اعلان‌ها داخل اپ و به‌صورت زنده نمایش داده می‌شوند.

## اعلان روی گوشی

- **وقتی اپ باز یا در پس‌زمینه است:** هر اعلان جدید (دعوت، شروع رأی‌گیری، مصوبه …) از طریق اتصال زنده در نوار اعلان گوشی نمایش داده می‌شود. با زدن روی آن، صفحه همان جلسه یا مصوبه باز می‌شود. این حالت به هیچ سرویس خارجی نیاز ندارد.
- **وقتی اپ کاملاً بسته است:** اندروید فقط از طریق سرویس Firebase Cloud Messaging (FCM) اعلان می‌دهد. برای فعال‌سازی:
  1. یک پروژه رایگان در Firebase بسازید.
  2. فایل `google-services.json` را در `apps/mobile` قرار دهید.
  3. یک حساب Expo بسازید و `projectId` آن را در `app.json` (بخش `extra.eas.projectId`) وارد کنید.
  4. کلید FCM را در Expo ثبت کنید و اپ را دوباره بسازید.

  سرور این اعلان‌ها را از طریق سرویس Expo ارسال می‌کند (`PUSH_PROVIDER=expo`).
