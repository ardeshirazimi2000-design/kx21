import { useState } from 'react';
import { ASSIGNEE_KIND, KIND, STEP_TYPE } from '../components/labels';
import { PositionSelect, UnitSelect, UserSelect } from '../components/pickers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, PageHeader, dateTimeFa, fa } from '../components/ui';
import { get, post } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

interface Assignee {
  kind: string;
  value?: string;
}
interface Step {
  key: string;
  name: string;
  type: string;
  assignee: Assignee;
  slaHours?: number;
  remindBeforeHours?: number;
  onReject?: string;
  condition?: { field: string; op: string; value: any };
}
interface Draft {
  key: string;
  name: string;
  description: string;
  appliesTo: string[];
  definition: { steps: Step[]; completeStatus?: string };
}

const NEW: Draft = {
  key: '',
  name: '',
  description: '',
  appliesTo: ['incoming', 'outgoing', 'internal'],
  definition: { steps: [{ key: 'review', name: 'بررسی مدیر', type: 'review', assignee: { kind: 'owner_unit_manager' }, slaHours: 48 }] },
};

function AssigneeEditor({ value, onChange, roles }: { value: Assignee; onChange: (a: Assignee) => void; roles: any[] }) {
  return (
    <div className="col gap-sm">
      <select className="input" value={value.kind} onChange={(e) => onChange({ kind: e.target.value })}>
        {Object.entries(ASSIGNEE_KIND).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      {value.kind === 'user' && <UserSelect value={value.value ?? ''} onChange={(v) => onChange({ ...value, value: v })} />}
      {value.kind === 'position' && <PositionSelect value={value.value ?? ''} onChange={(v) => onChange({ ...value, value: v })} />}
      {value.kind === 'unit_manager' && <UnitSelect value={value.value ?? ''} onChange={(v) => onChange({ ...value, value: v })} emptyLabel="انتخاب واحد…" />}
      {value.kind === 'role' && (
        <select className="input" value={value.value ?? ''} onChange={(e) => onChange({ ...value, value: e.target.value })}>
          <option value="">انتخاب نقش…</option>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      {value.kind === 'context_user' && (
        <input className="input ltr" placeholder="ownerUserId" value={value.value ?? ''} onChange={(e) => onChange({ ...value, value: e.target.value })} />
      )}
    </div>
  );
}

export function WorkflowsPage() {
  const list = useApi<any[]>('/workflows');
  const roles = useApi<{ roles: any[] }>('/roles');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [history, setHistory] = useState<any | null>(null);
  const act = useAction();

  const open = async (key: string) => {
    const h = await get(`/workflows/${key}`);
    setHistory(h);
    const d = h.latest;
    setDraft({ key: d.key, name: d.name, description: d.description ?? '', appliesTo: d.applies_to, definition: d.definition });
  };
  const steps = draft?.definition.steps ?? [];
  const setSteps = (s: Step[]) => draft && setDraft({ ...draft, definition: { ...draft.definition, steps: s } });
  const setStep = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const s = [...steps];
    [s[i], s[i + d]] = [s[i + d], s[i]];
    setSteps(s);
  };

  return (
    <>
      <PageHeader
        title="طراحی گردش کار"
        subtitle="فرایندهای تأیید با گام‌های بررسی، تأیید، امضا و بایگانی؛ هر ذخیره نسخه جدیدی می‌سازد و گردش‌های در جریان روی نسخه خود ادامه می‌دهند"
        actions={<Button onClick={() => (setDraft({ ...NEW }), setHistory(null))}>فرایند جدید</Button>}
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(240px, 1fr) 3fr' }}>
        <Card title="فرایندها">
          {list.loading && !list.data ? (
            <Loading />
          ) : (
            <ul className="tree">
              {(list.data ?? []).map((w) => (
                <li key={w.key}>
                  <button className={draft?.key === w.key ? 'active' : ''} onClick={() => void open(w.key)}>
                    {w.name}
                    <div className="small muted">
                      نسخه {fa(w.version)} {w.is_active ? '' : '(غیرفعال)'} · {fa(w.running)} در جریان
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {!draft ? (
          <Card>
            <Empty>یک فرایند را انتخاب کنید یا فرایند جدید بسازید.</Empty>
          </Card>
        ) : (
          <div>
            <Card title={history ? `ویرایش «${draft.name}»` : 'فرایند جدید'}>
              <ErrorBox error={act.error} />
              <div className="grid grid-3">
                <Field label="کلید (لاتین)">
                  <input className="input ltr" value={draft.key} disabled={!!history} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
                </Field>
                <Field label="عنوان">
                  <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
                <Field label="وضعیت نامه پس از پایان">
                  <select className="input" value={draft.definition.completeStatus ?? ''} onChange={(e) => setDraft({ ...draft, definition: { ...draft.definition, completeStatus: e.target.value || undefined } })}>
                    <option value="">پیش‌فرض (تأییدشده/امضاشده)</option>
                    <option value="approved">تأییدشده</option>
                    <option value="signed">امضاشده</option>
                    <option value="archived">بایگانی</option>
                  </select>
                </Field>
              </div>
              <div className="row gap wrap mb">
                <span className="muted">قابل استفاده برای:</span>
                {Object.entries(KIND).map(([k, v]) => (
                  <label key={k} className="check">
                    <input
                      type="checkbox"
                      checked={draft.appliesTo.includes(k)}
                      onChange={(e) => setDraft({ ...draft, appliesTo: e.target.checked ? [...draft.appliesTo, k] : draft.appliesTo.filter((x) => x !== k) })}
                    />
                    {v}
                  </label>
                ))}
              </div>
              {steps.map((s, i) => (
                <div key={i} className="card mb" style={{ background: 'var(--surface-2)' }}>
                  <div className="row between mb">
                    <strong>
                      گام {fa(i + 1)}: {s.name}
                    </strong>
                    <div className="row gap-sm">
                      <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </Button>
                      <Button variant="ghost" size="sm" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                        ↓
                      </Button>
                      <Button variant="ghost" size="sm" disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                        حذف
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-4">
                    <Field label="کلید گام">
                      <input className="input ltr" value={s.key} onChange={(e) => setStep(i, { key: e.target.value })} />
                    </Field>
                    <Field label="عنوان گام">
                      <input className="input" value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} />
                    </Field>
                    <Field label="نوع">
                      <select className="input" value={s.type} onChange={(e) => setStep(i, { type: e.target.value })}>
                        {Object.entries(STEP_TYPE).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="مهلت (ساعت)" hint="پس از مهلت، به مدیر مسئول ارتقا می‌یابد">
                      <input className="input" type="number" min={1} value={s.slaHours ?? ''} onChange={(e) => setStep(i, { slaHours: e.target.value ? Number(e.target.value) : undefined })} />
                    </Field>
                  </div>
                  <div className="grid grid-3">
                    <Field label="مسئول">
                      <AssigneeEditor value={s.assignee} roles={roles.data?.roles ?? []} onChange={(a) => setStep(i, { assignee: a })} />
                    </Field>
                    <Field label="در صورت رد">
                      <select className="input" value={s.onReject ?? 'end'} onChange={(e) => setStep(i, { onReject: e.target.value === 'end' ? undefined : e.target.value })}>
                        <option value="end">پایان گردش (ردشده)</option>
                        {steps.slice(0, i).map((p) => (
                          <option key={p.key} value={p.key}>
                            بازگشت به «{p.name}»
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="شرط اجرا (اختیاری)">
                      <select
                        className="input"
                        value={s.condition ? `${s.condition.field}:${s.condition.value}` : ''}
                        onChange={(e) => {
                          const [field, value] = e.target.value.split(':');
                          setStep(i, { condition: e.target.value ? { field, op: 'eq', value: field === 'confidentiality' ? Number(value) : value } : undefined });
                        }}
                      >
                        <option value="">همیشه</option>
                        <option value="priority:urgent">فقط نامه‌های آنی</option>
                        <option value="priority:high">فقط نامه‌های فوری</option>
                        <option value="confidentiality:1">فقط نامه‌های محرمانه</option>
                        <option value="kind:outgoing">فقط نامه صادره</option>
                        <option value="kind:incoming">فقط نامه وارده</option>
                        <option value="source:meeting">فقط مصوبات سامانه جلسات</option>
                      </select>
                    </Field>
                  </div>
                </div>
              ))}
              <div className="row gap">
                <Button variant="secondary" onClick={() => setSteps([...steps, { key: `step${steps.length + 1}`, name: 'گام جدید', type: 'approve', assignee: { kind: 'initiator_manager' } }])}>
                  افزودن گام
                </Button>
                <div className="grow" />
                <Button
                  busy={act.busy}
                  onClick={() =>
                    act.run(async () => {
                      await post('/workflows', { ...draft, description: draft.description || null });
                      await list.reload();
                      await open(draft.key);
                    })
                  }
                >
                  ذخیره به‌عنوان نسخه جدید
                </Button>
              </div>
            </Card>
            {history && (
              <Card title="نسخه‌ها" className="mt">
                <table className="table">
                  <thead>
                    <tr>
                      <th>نسخه</th>
                      <th>ایجاد</th>
                      <th>نمونه‌ها</th>
                      <th>وضعیت</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {history.versions.map((v: any) => (
                      <tr key={v.id}>
                        <td>{fa(v.version)}</td>
                        <td className="small">
                          {v.created_by_name ?? 'سامانه'} — {dateTimeFa(v.created_at)}
                        </td>
                        <td>{fa(v.instance_count)}</td>
                        <td>{v.is_active ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}</td>
                        <td>
                          {!v.is_active ? (
                            <Button variant="ghost" size="sm" onClick={() => act.run(async () => (await post(`/workflows/${v.key}/activate`, { version: v.version }), await open(v.key), await list.reload()))}>
                              فعال‌سازی
                            </Button>
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => act.run(async () => (await post(`/workflows/${v.key}/activate`, { version: null }), await open(v.key), await list.reload()))}>
                              غیرفعال‌سازی
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
