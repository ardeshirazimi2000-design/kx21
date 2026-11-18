# داده زبان فارسی Tesseract

`tessdata/fas.traineddata` مدل فارسی [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) (پروژه Tesseract، مجوز Apache-2.0) است.
Alpine (پایه ایمیج `office-api`) بسته فارسی Tesseract ندارد، برای همین این فایل داخل مخزن است و هنگام ساخت ایمیج در `/usr/share/tessdata` کپی می‌شود.
این روش به اینترنت برای دریافت مدل نیاز ندارد. در نصب مستقیم روی Ubuntu به‌جای این فایل از بسته `tesseract-ocr-fas` استفاده می‌شود.
