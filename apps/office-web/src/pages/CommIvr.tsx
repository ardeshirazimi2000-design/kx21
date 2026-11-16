import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorBox, Field, Loading, PageHeader, dateTimeFa, fa } from '../components/ui';
import { api, blobUrl, del, put } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';
import { canRecord, toPhoneWav } from '../lib/wav';
import '../communications.css';

type Day = 'sat' | 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
type Kind = 'greeting' | 'closed';
interface Option {
  digit: string;
  label: string;
  targets: string[];
}
interface Settings {
  enabled: boolean;
  options: Option[];
  directDial: boolean;
  waitSeconds: number;
  ringSeconds: number;
  workHours: { days: Day[]; start: string; end: string };
  afterHoursEnabled: boolean;
}
interface Loaded extends Settings {
  sounds: Partial<Record<Kind, { updatedAt: string; seconds: number }>>;
  extensions: { number: string; name: string }[];
  operatorTargets: string[];
}

const DAYS: [Day, string][] = [
  ['sat', 'شنبه'],
  ['sun', 'یکشنبه'],
  ['mon', 'دوشنبه'],
  ['tue', 'سه‌شنبه'],
  ['wed', 'چهارشنبه'],
  ['thu', 'پنجشنبه'],
  ['fri', 'جمعه'],
];

const SOUND_TEXT: Record<Kind, { title: string; hint: string }> = {
  greeting: {
    title: 'پیام خوشامد',
    hint: 'مثلاً: «با اتاق ... تماس گرفته‌اید. برای دبیرخانه ۱، برای امور مالی ۲ را بفرمایید. اگر شماره داخلی را می‌دانید، آن را بگیرید.»',
  },
  closed: { title: 'پیام بیرون از ساعت کاری', hint: 'مثلاً: «ساعت کاری ما شنبه تا چهارشنبه، ۸ تا ۱۶ است. لطفاً در این ساعت تماس بگیرید.»' },
};

/** «تلفن گویا»: what a caller from the city line hears and which key rings whom. */
export function CommIvrPage() {
  const r = useApi<Loaded>('/communications/settings/ivr');
  const [draft, setDraft] = useState<Settings | null>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  if (!r.data) return r.error ? <ErrorBox error={r.error} /> : <Loading />;
  const d = r.data;
  const s: Settings = draft ?? d;
  const change = (p: Partial<Settings>) => (setSaved(false), setDraft({ ...s, ...p }));
  const setOption = (i: number, p: Partial<Option>) => change({ options: s.options.map((o, j) => (j === i ? { ...o, ...p } : o)) });
  const used = new Set(s.options.map((o) => o.digit));
  const freeDigit = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].find((x) => !used.has(x));
  const name = (n: string) => d.extensions.find((e) => e.number === n)?.name ?? '';
  const save = () =>
    act.run(async () => {
      const v = await put<Settings>('/communications/settings/ivr', s);
      r.setData({ ...d, ...v });
      setDraft(null);
      setSaved(true);
    });

  return (
    <div className="ivr-page">
      <PageHeader title="تلفن گویا" subtitle="وقتی کسی با شماره سازمان تماس می‌گیرد، چه می‌شنود و با زدن هر کلید به کدام داخلی وصل می‌شود." />
      <ErrorBox error={act.error} />

      <Card title="وضعیت">
        <label className="row gap-sm ivr-switch">
          <input type="checkbox" checked={s.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
          <strong>تلفن گویا روشن باشد</strong>
        </label>
        <p className="small muted">
          {s.enabled
            ? 'تماس‌های خط شهری پیام خوشامد را می‌شنوند و کلید می‌زنند.'
            : 'خاموش است: تماس‌های خط شهری مستقیم به مقصدهای کارت «تماس‌های خط شهری» در صفحه مدیریت داخلی‌ها می‌روند.'}
        </p>
        {!d.sounds.greeting && <div className="alert alert-info mb">برای روشن کردن، اول پیام خوشامد را ضبط یا بارگذاری کنید.</div>}
        <p className="small muted">
          برای آزمودن بدون خط شهری، از هر گوشی داخلی شماره <span className="mono" style={{ direction: 'ltr', unicodeBidi: 'isolate', display: 'inline-block' }}>*99</span> را بگیرید (پس از ذخیره و روشن بودن تلفن گویا).
        </p>
      </Card>

      <div className="ivr-sounds">
        {(['greeting', 'closed'] as Kind[]).map((k) => (
          <SoundSlot
            key={k}
            kind={k}
            info={d.sounds[k]}
            locked={k === 'greeting' && d.enabled}
            onChange={(info) => r.setData({ ...d, sounds: { ...d.sounds, [k]: info ?? undefined } })}
          />
        ))}
      </div>

      <Card title="کلیدهای منو">
        {!d.extensions.length ? (
          <div className="alert alert-info">هنوز داخلی فعالی نیست.</div>
        ) : (
          <>
            {s.options.map((o, i) => (
              <div key={i} className="ivr-option">
                <div className="row gap-sm ivr-option-head">
                  <Field label="کلید">
                    <select className="input mono" value={o.digit} onChange={(e) => setOption(i, { digit: e.target.value })}>
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
                        .filter((x) => x === o.digit || !used.has(x))
                        .map((x) => (
                          <option key={x} value={x}>
                            {fa(x)}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="عنوان (برای خودتان)">
                    <input
                      className="input"
                      value={o.label}
                      maxLength={60}
                      placeholder="مثلاً دبیرخانه"
                      onChange={(e) => setOption(i, { label: e.target.value })}
                    />
                  </Field>
                  <Button variant="ghost" size="sm" onClick={() => change({ options: s.options.filter((_, j) => j !== i) })}>
                    حذف
                  </Button>
                </div>
                <div className="small muted">این داخلی‌ها با هم زنگ می‌خورند:</div>
                <div className="inbound-targets">
                  {d.extensions.map((e) => (
                    <label key={e.number} className="row gap-sm">
                      <input
                        type="checkbox"
                        checked={o.targets.includes(e.number)}
                        onChange={() =>
                          setOption(i, { targets: o.targets.includes(e.number) ? o.targets.filter((x) => x !== e.number) : [...o.targets, e.number] })
                        }
                      />
                      <span className="mono">{fa(e.number)}</span> {e.name}
                    </label>
                  ))}
                </div>
                {!o.targets.length && <div className="small text-danger">دست‌کم یک داخلی انتخاب کنید.</div>}
              </div>
            ))}
            {freeDigit && s.options.length < 10 && (
              <Button variant="secondary" size="sm" onClick={() => change({ options: [...s.options, { digit: freeDigit, label: '', targets: [] }] })}>
                افزودن کلید
              </Button>
            )}
          </>
        )}
        <hr />
        <label className="row gap-sm mb">
          <input type="checkbox" checked={s.directDial} onChange={(e) => change({ directDial: e.target.checked })} />
          تماس‌گیرنده بتواند شماره داخلی را مستقیم بگیرد
        </label>
        <div className="row gap-sm wrap">
          <Field label="انتظار برای کلید پس از پیام (ثانیه)" hint="۲ تا ۳۰">
            <input
              className="input mono"
              type="number"
              min={2}
              max={30}
              value={s.waitSeconds}
              onChange={(e) => change({ waitSeconds: Number(e.target.value) })}
              style={{ maxWidth: 120 }}
            />
          </Field>
          <Field label="مدت زنگ داخلی (ثانیه)" hint="۱۰ تا ۱۲۰">
            <input
              className="input mono"
              type="number"
              min={10}
              max={120}
              value={s.ringSeconds}
              onChange={(e) => change({ ringSeconds: Number(e.target.value) })}
              style={{ maxWidth: 120 }}
            />
          </Field>
        </div>
        <p className="small muted">
          اگر تماس‌گیرنده کلیدی نزند،{' '}
          {d.operatorTargets.length ? (
            <>به اپراتور وصل می‌شود: {d.operatorTargets.map((n) => `${fa(n)} ${name(n)}`).join('، ')}</>
          ) : (
            <>پیام «سرویس در دسترس نیست» پخش می‌شود</>
          )}
          . اپراتور در <Link to="/communications/extensions">مدیریت داخلی‌ها</Link>، کارت «تماس‌های خط شهری» تعیین می‌شود.
        </p>
      </Card>

      <Card title="ساعت کاری">
        <label className="row gap-sm mb">
          <input type="checkbox" checked={s.afterHoursEnabled} onChange={(e) => change({ afterHoursEnabled: e.target.checked })} />
          بیرون از ساعت کاری، پیام «بیرون از ساعت کاری» پخش شود و تماس قطع شود
        </label>
        <fieldset disabled={!s.afterHoursEnabled} className="ivr-hours">
          <div className="inbound-targets">
            {DAYS.map(([k, label]) => (
              <label key={k} className="row gap-sm">
                <input
                  type="checkbox"
                  checked={s.workHours.days.includes(k)}
                  onChange={() =>
                    change({
                      workHours: { ...s.workHours, days: s.workHours.days.includes(k) ? s.workHours.days.filter((x) => x !== k) : [...s.workHours.days, k] },
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
          <div className="row gap-sm wrap">
            <Field label="از ساعت">
              <input
                className="input mono"
                type="time"
                value={s.workHours.start}
                onChange={(e) => change({ workHours: { ...s.workHours, start: e.target.value } })}
              />
            </Field>
            <Field label="تا ساعت">
              <input
                className="input mono"
                type="time"
                value={s.workHours.end}
                onChange={(e) => change({ workHours: { ...s.workHours, end: e.target.value } })}
              />
            </Field>
          </div>
          {s.afterHoursEnabled && !d.sounds.closed && (
            <div className="alert alert-info">پیام «بیرون از ساعت کاری» هنوز ثبت نشده است؛ تا آن زمان پیام «سرویس در دسترس نیست» پخش می‌شود.</div>
          )}
        </fieldset>
      </Card>

      <div className="row gap-sm ivr-save">
        <Button onClick={save} busy={act.busy} disabled={!draft}>
          ذخیره
        </Button>
        {draft && (
          <Button variant="ghost" onClick={() => setDraft(null)}>
            انصراف
          </Button>
        )}
        {saved && <span className="small text-success">ذخیره شد و به مرکز تلفن اعمال می‌شود.</span>}
      </div>
    </div>
  );
}

function SoundSlot({
  kind,
  info,
  locked,
  onChange,
}: {
  kind: Kind;
  info?: { updatedAt: string; seconds: number };
  locked: boolean;
  onChange: (info: { updatedAt: string; seconds: number } | null) => void;
}) {
  const act = useAction();
  const [url, setUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = SOUND_TEXT[kind];

  useEffect(() => {
    let u: string | null = null;
    if (info)
      void blobUrl(`/communications/ivr/sounds/${kind}`).then(
        (x) => setUrl((u = x)),
        () => setUrl(null),
      );
    else setUrl(null);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [kind, info?.updatedAt]);

  const send = (audio: Blob) =>
    act.run(async () => {
      const wav = await toPhoneWav(audio);
      const r = await api<{ seconds: number }>(`/communications/ivr/sounds/${kind}`, { method: 'PUT', body: wav, headers: { 'content-type': 'audio/wav' } });
      onChange({ updatedAt: new Date().toISOString(), seconds: r.seconds });
    });

  const record = () =>
    act.run(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((x) => x.stop());
        setRecording(null);
        void send(new Blob(parts, { type: rec.mimeType }));
      };
      rec.start();
      setRecording(rec);
    });

  const remove = () =>
    act.run(async () => {
      await del(`/communications/ivr/sounds/${kind}`);
      onChange(null);
    });

  return (
    <Card title={t.title}>
      <p className="small muted">{t.hint}</p>
      <ErrorBox error={act.error} />
      {info ? (
        <div className="ivr-sound-now">
          <div className="small">
            ثبت‌شده، {fa(info.seconds)} ثانیه، {dateTimeFa(info.updatedAt)}
          </div>
          {url && <audio controls src={url} preload="none" />}
        </div>
      ) : (
        <div className="small muted mb">هنوز ثبت نشده است.</div>
      )}
      <div className="row gap-sm wrap">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void send(f);
          }}
        />
        <Button variant="secondary" size="sm" busy={act.busy && !recording} disabled={!!recording} onClick={() => fileRef.current?.click()}>
          بارگذاری فایل صوتی
        </Button>
        {recording ? (
          <Button variant="danger" size="sm" onClick={() => recording.stop()}>
            پایان ضبط
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={!canRecord() || act.busy}
            onClick={record}
            title={canRecord() ? '' : 'ضبط از مرورگر فقط روی HTTPS ممکن است'}
          >
            ضبط با میکروفون
          </Button>
        )}
        {info && (
          <Button
            variant="ghost"
            size="sm"
            disabled={locked || act.busy}
            onClick={remove}
            title={locked ? 'تا تلفن گویا روشن است، پیام خوشامد حذف نمی‌شود' : ''}
          >
            حذف
          </Button>
        )}
      </div>
      {recording && <div className="small text-danger">در حال ضبط… پس از پایان پیام، «پایان ضبط» را بزنید.</div>}
      {!canRecord() && (
        <div className="small muted">ضبط از مرورگر فقط وقتی رسا با HTTPS باز شود ممکن است؛ تا آن زمان فایل صوتی (MP3 یا WAV) بارگذاری کنید.</div>
      )}
    </Card>
  );
}
