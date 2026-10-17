import { useEffect, useRef, useState } from "react";
import { ApiError, blobUrl, del, upload } from "../lib/api";
import { Button, ErrorBox } from "./ui";

/** An authenticated image (specimen signature); renders nothing when the file is missing. */
export function AuthImage({
  path,
  alt,
  height = 70,
}: {
  path: string | null;
  alt: string;
  height?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let made: string | null = null;
    blobUrl(path)
      .then((u) => {
        made = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [path]);
  return url ? (
    <img
      src={url}
      alt={alt}
      style={{ height, maxWidth: 240, objectFit: "contain" }}
    />
  ) : null;
}

/** Preview, upload (PNG/JPG, up to 1 MB) and removal of a person's specimen signature. */
export function SignatureEditor({
  userId,
  hasSignature,
  onChange,
}: {
  userId: string;
  hasSignature: boolean;
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setVersion((v) => v + 1);
      onChange();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <ErrorBox error={error} />
      <div className="signature-box">
        {hasSignature ? (
          <AuthImage
            key={version}
            path={`/users/${userId}/signature?v=${version}`}
            alt="نمونه امضا"
          />
        ) : (
          <span className="muted small">نمونه امضا ثبت نشده است</span>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(() => upload(`/users/${userId}/signature`, {}, f));
        }}
      />
      <div className="row gap-sm mt">
        <Button size="sm" busy={busy} onClick={() => input.current?.click()}>
          {hasSignature ? "جایگزینی تصویر" : "بارگذاری تصویر امضا"}
        </Button>
        {hasSignature && (
          <Button
            size="sm"
            variant="ghost"
            busy={busy}
            onClick={() => void run(() => del(`/users/${userId}/signature`))}
          >
            حذف
          </Button>
        )}
      </div>
      <p className="small muted mt">
        تصویر PNG یا JPG امضا روی زمینه سفید، حداکثر ۱ مگابایت. امضاهای قبلی
        نامه‌ها با تصویر زمان امضا باقی می‌مانند.
      </p>
    </div>
  );
}
