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
