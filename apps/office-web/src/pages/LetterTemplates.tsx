import { useRef, useState } from 'react';
import { LetterEditor } from '../components/editor';
import { LetterPaper, type LetterTemplate } from '../components/letterPaper';
import { UnitSelect } from '../components/pickers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, PageHeader } from '../components/ui';
import { api, del, patch, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';

const blank = {
  name: '',
  description: '',
  kinds: ['outgoing', 'internal'],
  unitId: '',
  pageSize: 'A4' as 'A4' | 'A5',
  headerText: 'بسمه تعالی',
  orgName: 'اتاق بازرگانی، صنایع، معادن و کشاورزی ایران',
  orgSubtitle: '',
  footerText: '',
  showLogo: true,
  marginTop: 15,
  marginBottom: 15,
  marginSide: 18,
  fontSize: 13,
  showQr: true,
  bodyHtml: '<p>با سلام و احترام،</p><p></p>',
  isDefault: false,
  isActive: true,
};
type Form = typeof blank;

const toForm = (t: LetterTemplate): Form => ({
  name: t.name,
  description: t.description ?? '',
  kinds: t.kinds,
  unitId: t.unit_id ?? '',
  pageSize: t.page_size,
  headerText: t.header_text ?? '',
  orgName: t.org_name ?? '',
  orgSubtitle: t.org_subtitle ?? '',
  footerText: t.footer_text ?? '',
  showLogo: t.show_logo,
  marginTop: t.margin_top,
  marginBottom: t.margin_bottom,
  marginSide: t.margin_side,
  fontSize: t.font_size,
  showQr: t.show_qr,
  bodyHtml: t.body_html ?? '',
  isDefault: t.is_default,
  isActive: t.is_active,
});

/** «قالب‌های نامه»: letterheads letters are typed into and printed on. */
export function LetterTemplatesPage() {
  const { can } = useAuth();
  const list = useApi<LetterTemplate[]>('/letter-templates?all=1');
  const [editing, setEditing] = useState<LetterTemplate | 'new' | null>(null);
  if (!can('templates.manage')) return <ErrorBox error={new Error('دسترسی به این بخش ندارید')} />;
  if (editing) {
    return (
      <TemplateEditor
        template={editing === 'new' ? null : editing}
        onClose={async () => {
          setEditing(null);
          await list.reload();
        }}
        onSaved={async (t) => {
          setEditing(t);
          await list.reload();
        }}
      />
    );
  }
  return (
    <>
      <PageHeader
        title="قالب‌های نامه"
        subtitle="سربرگ سازمانی، حاشیه‌ها، پاورقی و متن آغازین نامه‌های صادره و داخلی"
        actions={<Button onClick={() => setEditing('new')}>قالب جدید</Button>}
      />
      <Card>
        <ErrorBox error={list.error} />
        {!list.data ? (
          <Loading />
        ) : !list.data.length ? (
          <Empty>قالبی تعریف نشده است.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>نام</th>
                <th>نوع نامه</th>
                <th>واحد</th>
                <th>سربرگ</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setEditing(t)}>
                  <td>
                    {t.name} {t.is_default && <Badge tone="accent">پیش‌فرض</Badge>}
                    {t.description && <div className="small muted">{t.description}</div>}
                  </td>
                  <td>{t.kinds.map((k) => (k === 'outgoing' ? 'صادره' : 'داخلی')).join('، ')}</td>
                  <td>{t.unit_name ?? 'همه واحدها'}</td>
                  <td className="small">
                    {t.has_background ? 'تصویر کامل سربرگ' : t.has_logo ? 'لوگوی اختصاصی' : t.show_logo ? 'لوگوی اتاق' : 'بدون لوگو'} · {t.page_size}
                  </td>
                  <td>{t.is_active ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function TemplateEditor({ template, onClose, onSaved }: { template: LetterTemplate | null; onClose: () => void; onSaved: (t: LetterTemplate) => void }) {
  const [f, setF] = useState<Form>(template ? toForm(template) : blank);
  const [current, setCurrent] = useState<LetterTemplate | null>(template);
  const act = useAction();
  const logoInput = useRef<HTMLInputElement>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const num = (k: 'marginTop' | 'marginBottom' | 'marginSide' | 'fontSize', label: string, min: number, max: number, step = 1) => (
    <Field label={label}>
      <input className="input" type="number" min={min} max={max} step={step} value={f[k]} onChange={(e) => set(k, Number(e.target.value))} />
    </Field>
  );
  const payload = () => ({
    ...f,
    unitId: f.unitId || null,
    description: f.description || null,
    headerText: f.headerText || null,
    orgName: f.orgName || null,
    orgSubtitle: f.orgSubtitle || null,
    footerText: f.footerText || null,
    bodyHtml: f.bodyHtml || null,
  });
  const save = () =>
    act.run(async () => {
      const t = current
        ? await patch<LetterTemplate>(`/letter-templates/${current.id}`, payload())
        : await post<LetterTemplate>('/letter-templates', payload());
      setCurrent(t);
      onSaved(t);
    });
  const refresh = async () => {
    const t = await api<LetterTemplate>(`/letter-templates/${current!.id}`);
    setCurrent(t);
  };
  const image = (kind: 'logo' | 'background', file?: File | null) =>
    act.run(async () => {
      if (file) await upload(`/letter-templates/${current!.id}/${kind}`, {}, file);
      else await del(`/letter-templates/${current!.id}/${kind}`);
      await refresh();
    });
  const remove = () =>
    act.run(async () => {
      if (!confirm('قالب حذف شود؟ اگر نامه‌ای از آن استفاده کرده باشد، فقط غیرفعال می‌شود.')) return;
      await del(`/letter-templates/${current!.id}`);
      onClose();
    });

  // The preview reflects unsaved fields; images come from the saved template.
  const preview: LetterTemplate = {
    id: current?.id ?? 'new',
    name: f.name,
    kinds: f.kinds,
    unit_id: f.unitId || null,
    page_size: f.pageSize,
    header_text: f.headerText,
    org_name: f.orgName,
    org_subtitle: f.orgSubtitle,
    footer_text: f.footerText,
    show_logo: f.showLogo,
    has_logo: !!current?.has_logo,
    has_background: !!current?.has_background,
    margin_top: f.marginTop,
    margin_bottom: f.marginBottom,
    margin_side: f.marginSide,
    font_size: f.fontSize,
    show_qr: f.showQr,
    body_html: f.bodyHtml,
    is_default: f.isDefault,
    is_active: f.isActive,
    updated_at: current?.updated_at,
  };

  return (
    <>
      <PageHeader
        title={current ? `قالب «${current.name}»` : 'قالب جدید'}
        actions={
          <>
            <Button busy={act.busy} onClick={() => void save()}>
              ذخیره
            </Button>
            {current && (
              <Button variant="danger" onClick={() => void remove()}>
                حذف
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              بازگشت
            </Button>
          </>
        }
      />
      <ErrorBox error={act.error} />
      <div className="grid grid-2">
        <Card title="مشخصات">
          <Field label="نام قالب">
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={200} />
          </Field>
          <Field label="توضیح">
            <input className="input" value={f.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <div className="row gap wrap">
            {(['outgoing', 'internal'] as const).map((k) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={f.kinds.includes(k)}
                  onChange={(e) => set('kinds', e.target.checked ? [...f.kinds, k] : f.kinds.filter((x) => x !== k))}
                />
                نامه {k === 'outgoing' ? 'صادره' : 'داخلی'}
              </label>
            ))}
          </div>
          <Field label="واحد" hint="خالی: برای همه واحدها">
            <UnitSelect value={f.unitId} onChange={(v) => set('unitId', v)} emptyLabel="همه واحدها" />
          </Field>
          <div className="grid grid-2">
            <Field label="اندازه کاغذ">
              <select className="input" value={f.pageSize} onChange={(e) => set('pageSize', e.target.value as Form['pageSize'])}>
                <option value="A4">A4</option>
                <option value="A5">A5</option>
              </select>
            </Field>
            {num('fontSize', 'اندازه قلم متن (pt)', 8, 24, 0.5)}
          </div>
          <div className="grid grid-3">
            {num('marginTop', 'حاشیه بالا (mm)', 0, 120)}
            {num('marginBottom', 'حاشیه پایین (mm)', 0, 120)}
            {num('marginSide', 'حاشیه کناری (mm)', 0, 60)}
          </div>
          <div className="row gap wrap">
            <label className="check">
              <input type="checkbox" checked={f.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
              قالب پیش‌فرض
            </label>
            <label className="check">
              <input type="checkbox" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
              فعال
            </label>
            <label className="check">
              <input type="checkbox" checked={f.showQr} onChange={(e) => set('showQr', e.target.checked)} />
              کد QR صحت‌سنجی در پاورقی
            </label>
          </div>
        </Card>
        <Card title="سربرگ و پاورقی">
          <Field label="عبارت بالای نامه">
            <input className="input" value={f.headerText} onChange={(e) => set('headerText', e.target.value)} />
          </Field>
          <Field label="نام سازمان">
            <input className="input" value={f.orgName} onChange={(e) => set('orgName', e.target.value)} />
          </Field>
          <Field label="زیرعنوان (واحد، معاونت…)">
            <input className="input" value={f.orgSubtitle} onChange={(e) => set('orgSubtitle', e.target.value)} />
          </Field>
          <Field label="پاورقی (نشانی، تلفن، وب‌سایت)">
            <textarea className="input" rows={2} value={f.footerText} onChange={(e) => set('footerText', e.target.value)} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={f.showLogo} onChange={(e) => set('showLogo', e.target.checked)} />
            نمایش لوگو {current?.has_logo ? '(لوگوی اختصاصی)' : '(لوگوی اتاق)'}
          </label>
          {!current ? (
            <p className="small muted">پس از ذخیره، می‌توانید لوگو یا تصویر کامل سربرگ را بارگذاری کنید.</p>
          ) : (
            <div className="row gap wrap mt">
              <input ref={logoInput} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => void image('logo', e.target.files?.[0])} />
              <input ref={bgInput} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => void image('background', e.target.files?.[0])} />
              <Button size="sm" variant="secondary" onClick={() => logoInput.current?.click()}>
                {current.has_logo ? 'تعویض لوگو' : 'بارگذاری لوگو'}
              </Button>
              {current.has_logo && (
                <Button size="sm" variant="ghost" onClick={() => void image('logo')}>
                  حذف لوگو
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => bgInput.current?.click()}>
                {current.has_background ? 'تعویض تصویر سربرگ' : 'بارگذاری تصویر کامل سربرگ'}
              </Button>
              {current.has_background && (
                <Button size="sm" variant="ghost" onClick={() => void image('background')}>
                  حذف تصویر سربرگ
                </Button>
              )}
            </div>
          )}
          <p className="small muted">
            اگر سربرگ چاپی دارید، اسکن کامل صفحه آن (PNG یا JPG، حداکثر ۵ مگابایت) را بارگذاری کنید؛ در این حالت سربرگ رسم‌شده نمایش داده نمی‌شود و حاشیه بالا
            را به اندازه ارتفاع سربرگ بیشتر کنید.
          </p>
        </Card>
      </div>
      <Card title="متن آغازین و پیش‌نمایش" className="mt">
        <LetterEditor
          value={f.bodyHtml}
          onChange={(v) => set('bodyHtml', v)}
          frame={(content) => (
            <div className="paper-wrap">
              <LetterPaper
                editing
                template={preview}
                letter={{
                  kind: 'outgoing',
                  subject: 'نمونه موضوع نامه',
                  to: ['جناب آقای / سرکار خانم …', 'سازمان …'],
                  signatures: [{ key: 's', name: 'نام امضاکننده', position: 'سمت' }],
                  watermark: 'نمونه',
                }}
              >
                {content}
              </LetterPaper>
            </div>
          )}
        />
      </Card>
    </>
  );
}
