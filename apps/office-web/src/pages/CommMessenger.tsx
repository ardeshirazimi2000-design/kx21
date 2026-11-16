import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../components/icons';
import { UserSelect } from '../components/pickers';
import { Badge, Button, Empty, ErrorBox, Field, Loading, Modal, Tabs, dateFa, fa } from '../components/ui';
import { ApiError, del, download, get, patch, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { Presence } from './CommDirectory';
import '../communications.css';

interface ConvItem {
  id: string;
  conversation_type: 'direct' | 'group';
  title: string;
  is_archived: boolean;
  unread: number;
  member_count: number;
  other_user_id: string | null;
  other_online?: boolean;
  muted: boolean;
  last_message_at: string | null;
  created_at: string;
  last_message: { body: string; type: string; deleted: boolean; sender_name: string | null; created_at: string } | null;
}

interface Attachment {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

interface Message {
  id: string;
  conversation_id: string;
  sender_user_id: string | null;
  sender_name: string | null;
  message_type: 'text' | 'file' | 'system';
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: Attachment[];
  conversation_title?: string;
}

interface ConvDetail {
  id: string;
  conversation_type: 'direct' | 'group';
  title: string;
  description: string | null;
  is_archived: boolean;
  member_role: 'owner' | 'member';
  muted: boolean;
  can_manage: boolean;
  members: { user_id: string; full_name: string; member_role: string; position_title: string | null; online: boolean }[];
}

const time = (d: string) => new Date(d).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const sizeFa = (n: number) => (n > 1024 * 1024 ? `${fa((n / 1024 / 1024).toFixed(1))} مگابایت` : `${fa(Math.max(1, Math.round(n / 1024)))} کیلوبایت`);
/** A key for this send, so a retry after a network error does not post the message twice (works on plain HTTP too). */
const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
const preview = (c: ConvItem) => {
  const m = c.last_message;
  if (!m) return 'بدون پیام';
  if (m.deleted) return 'پیام حذف شد';
  if (m.type === 'file') return `📎 ${m.body || 'فایل'}`;
  return m.type === 'system' ? m.body : `${c.conversation_type === 'group' && m.sender_name ? `${m.sender_name}: ` : ''}${m.body}`;
};

/** «پیام‌رسان سازمانی»: direct and group conversations; works whether or not the telephone exchange is up. */
export function CommMessengerPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const list = useApi<ConvItem[]>('/communications/conversations');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Message[] | null>(null);
  const [creating, setCreating] = useState(false);
  const select = (id: string | null) => setParams(id ? { c: id } : {}, { replace: false });
  const connected = useRealtime({
    NewMessage: () => void list.reload(),
    MessageRead: () => void list.reload(),
    ConversationUpdated: () => void list.reload(),
    ConversationRemoved: (p: { conversationId: string }) => {
      void list.reload();
      if (p.conversationId === selected) select(null);
    },
    UserPresenceChanged: (p: { userId: string; online: boolean }) =>
      list.setData((l) => l?.map((c) => (c.other_user_id === p.userId ? { ...c, other_online: p.online } : c)) ?? l),
    reconnect: () => void list.reload(),
  });

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) return setFound(null);
    const h = setTimeout(() => {
      get<Message[]>(`/communications/messages/search?q=${encodeURIComponent(t)}`)
        .then(setFound)
        .catch(() => setFound([]));
    }, 300);
    return () => clearTimeout(h);
  }, [q]);

  return (
    <div className={`msgr ${selected ? 'msgr-open' : ''}`}>
      <aside className="msgr-list" aria-label="گفت‌وگوها">
        <div className="msgr-list-head">
          <h1>پیام‌رسان</h1>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> گفت‌وگوی جدید
          </Button>
        </div>
        <input className="input" placeholder="جستجو در پیام‌ها…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="جستجو در پیام‌ها" />
        {!connected && <div className="msgr-offline small">اتصال بلادرنگ برقرار نیست؛ پیام‌ها هر چند لحظه به‌روز می‌شوند.</div>}
        {found ? (
          <ul className="msgr-convs">
            {!found.length && <li className="muted small msgr-pad">نتیجه‌ای پیدا نشد.</li>}
            {found.map((m) => (
              <li key={m.id}>
                <button type="button" className="msgr-conv" onClick={() => select(m.conversation_id)}>
                  <span className="msgr-conv-title">{m.conversation_title}</span>
                  <span className="msgr-conv-preview">
                    {m.sender_name}: {m.body || m.attachments[0]?.file_name}
                  </span>
                  <span className="msgr-conv-time small muted">{dateFa(m.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : list.loading && !list.data ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty>هنوز گفت‌وگویی ندارید. از «گفت‌وگوی جدید» یا دفترچه تلفن شروع کنید.</Empty>
        ) : (
          <ul className="msgr-convs">
            {list.data.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`msgr-conv ${c.id === selected ? 'active' : ''}`}
                  onClick={() => select(c.id)}
                  aria-current={c.id === selected}
                >
                  <span className="msgr-conv-title">
                    {c.conversation_type === 'group' ? (
                      <Icon name="users" size={15} />
                    ) : (
                      <span className={`presence-dot ${c.other_online ? 'on' : ''}`} aria-label={c.other_online ? 'برخط' : 'آفلاین'} />
                    )}
                    {c.title}
                    {c.is_archived && <Badge>بایگانی</Badge>}
                  </span>
                  <span className="msgr-conv-preview">{preview(c)}</span>
                  <span className="msgr-conv-time small muted">{c.last_message ? time(c.last_message.created_at) : ''}</span>
                  {c.unread > 0 && (
                    <span className="count" aria-label={`${fa(c.unread)} پیام خوانده‌نشده`}>
                      {fa(c.unread > 99 ? '99+' : c.unread)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="msgr-thread">
        {selected ? (
          <Thread key={selected} id={selected} onBack={() => select(null)} onChanged={() => void list.reload()} />
        ) : (
          <div className="msgr-empty">
            <Icon name="chat" size={40} />
            <p>یک گفت‌وگو را انتخاب کنید.</p>
          </div>
        )}
      </section>
      {creating && (
        <NewConversation
          canGroup={can('communications.conversation.manage')}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void list.reload();
            select(id);
          }}
        />
      )}
    </div>
  );
}

function Thread({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const { me } = useAuth();
  const detail = useApi<ConvDetail>(`/communications/conversations/${id}`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [reads, setReads] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [info, setInfo] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const lastRead = useRef<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      try {
        const r = await get<{ items: Message[]; hasMore: boolean; reads: { user_id: string; last_read_at: string | null }[] }>(
          `/communications/conversations/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`,
        );
        const older = [...r.items].reverse();
        setMessages((cur) => (before ? [...older, ...cur] : older));
        setHasMore(r.hasMore);
        setReads(Object.fromEntries(r.reads.filter((x) => x.last_read_at).map((x) => [x.user_id, x.last_read_at!])));
        setError(null);
      } catch (e) {
        setError(e as ApiError);
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  /** Marks read up to the newest message of someone else, once the page is in view. */
  const markRead = useCallback(
    (list: Message[]) => {
      if (document.visibilityState !== 'visible') return;
      const last = [...list].reverse().find((m) => m.sender_user_id !== me!.id && m.message_type !== 'system');
      if (!last || last.id === lastRead.current) return;
      lastRead.current = last.id;
      post(`/communications/messages/${last.id}/read`).then(onChanged, () => undefined);
    },
    [me, onChanged],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    markRead(messages);
    const v = () => markRead(messages);
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, [messages, markRead]);
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  useRealtime({
    NewMessage: (p: { conversationId: string; message: Message }) => {
      if (p.conversationId !== id) return;
      setMessages((cur) => (cur.some((m) => m.id === p.message.id) ? cur : [...cur, p.message]));
    },
    MessageUpdated: (p: { conversationId: string; message: Message }) => {
      if (p.conversationId === id) setMessages((cur) => cur.map((m) => (m.id === p.message.id ? p.message : m)));
    },
    MessageRead: (p: { conversationId: string; userId: string; lastReadAt: string }) => {
      if (p.conversationId === id && p.userId !== me!.id) setReads((r) => ({ ...r, [p.userId]: p.lastReadAt }));
    },
    ConversationUpdated: (p: { conversationId: string }) => {
      if (p.conversationId === id) {
        void detail.reload();
        void load();
      }
    },
    reconnect: () => void load(),
  });

  const d = detail.data;
  const others = d?.members.filter((m) => m.user_id !== me!.id) ?? [];
  const readByAll = (m: Message) => others.length > 0 && others.every((o) => reads[o.user_id] && reads[o.user_id] >= m.created_at);

  let lastDay = '';
  return (
    <>
      <header className="msgr-thread-head">
        <button type="button" className="icon-btn msgr-back" onClick={onBack} aria-label="بازگشت به فهرست گفت‌وگوها">
          <Icon name="back" />
        </button>
        <div className="msgr-thread-title">
          <strong>{d?.title ?? '…'}</strong>
          {d &&
            (d.conversation_type === 'direct' ? (
              <span className="small muted">
                {others[0]?.position_title ?? ''} {others[0] && <Presence online={others[0].online} />}
              </span>
            ) : (
              <span className="small muted">{fa(d.members.length)} عضو</span>
            ))}
        </div>
        {d && (
          <button type="button" className="icon-btn" onClick={() => setInfo(true)} aria-label="جزئیات گفت‌وگو">
            <Icon name="settings" />
          </button>
        )}
      </header>
      <div className="msgr-messages" role="log" aria-live="polite">
        <ErrorBox error={error ?? detail.error} />
        {loading ? (
          <Loading />
        ) : (
          <>
            {hasMore && (
              <div className="msgr-more">
                <Button variant="ghost" size="sm" onClick={() => void load(messages[0]?.created_at)}>
                  پیام‌های قدیمی‌تر
                </Button>
              </div>
            )}
            {!messages.length && <Empty>هنوز پیامی نیست. اولین پیام را بنویسید.</Empty>}
            {messages.map((m) => {
              const day = dateFa(m.created_at);
              const sep = day !== lastDay;
              lastDay = day;
              return (
                <div key={m.id}>
                  {sep && <div className="msgr-day">{day}</div>}
                  <Bubble m={m} mine={m.sender_user_id === me!.id} showSender={d?.conversation_type === 'group'} read={readByAll(m)} />
                </div>
              );
            })}
          </>
        )}
        <div ref={bottom} />
      </div>
      {d &&
        (d.is_archived ? (
          <div className="msgr-archived">این گروه بایگانی شده و پیام جدید نمی‌پذیرد.</div>
        ) : (
          <Composer id={id} onSent={(m) => setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]))} />
        ))}
      {info && d && (
        <ConversationInfo
          d={d}
          onClose={() => setInfo(false)}
          onChanged={() => {
            void detail.reload();
            onChanged();
          }}
          onLeft={() => {
            setInfo(false);
            onChanged();
            onBack();
          }}
        />
      )}
    </>
  );
}

function Bubble({ m, mine, showSender, read }: { m: Message; mine: boolean; showSender: boolean; read: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.body);
  const act = useAction();
  if (m.message_type === 'system') return <div className="msgr-system">{m.body}</div>;
  const save = () =>
    act.run(async () => {
      await patch(`/communications/messages/${m.id}`, { body: text });
      setEditing(false);
    });
  const remove = () =>
    act.run(async () => {
      if (confirm('این پیام برای همه حذف شود؟')) await del(`/communications/messages/${m.id}`);
    });
  return (
    <div className={`msgr-bubble-row ${mine ? 'mine' : ''}`}>
      <div className={`msgr-bubble ${m.deleted_at ? 'deleted' : ''}`}>
        {showSender && !mine && <div className="msgr-sender">{m.sender_name}</div>}
        {m.deleted_at ? (
          <em className="muted">این پیام حذف شد</em>
        ) : editing ? (
          <div className="col gap-sm">
            <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000} aria-label="ویرایش پیام" />
            <ErrorBox error={act.error} />
            <div className="row gap-sm">
              <Button size="sm" onClick={save} busy={act.busy} disabled={!text.trim()}>
                ذخیره
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                انصراف
              </Button>
            </div>
          </div>
        ) : (
          <>
            {m.body && <div className="msgr-text">{m.body}</div>}
            {m.attachments.map((a) => (
              <button key={a.id} type="button" className="msgr-file" onClick={() => void download(`/communications/attachments/${a.id}`, a.file_name)}>
                <Icon name="paperclip" size={16} />
                <span className="picked-name">{a.file_name}</span>
                <span className="small muted">{sizeFa(Number(a.size_bytes))}</span>
              </button>
            ))}
          </>
        )}
        <div className="msgr-meta">
          {m.edited_at && !m.deleted_at && <span>ویرایش‌شده</span>}
          <span>{time(m.created_at)}</span>
          {mine && !m.deleted_at && <span title={read ? 'خوانده شد' : 'ارسال شد'}>{read ? '✓✓ خوانده شد' : '✓ ارسال شد'}</span>}
        </div>
        {mine && !m.deleted_at && !editing && (
          <div className="msgr-tools">
            {m.message_type === 'text' && (
              <button type="button" onClick={() => setEditing(true)}>
                ویرایش
              </button>
            )}
            <button type="button" onClick={remove} disabled={act.busy}>
              حذف
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ id, onSent }: { id: string; onSent: (m: Message) => void }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const cid = useRef(newClientId());
  const fileInput = useRef<HTMLInputElement>(null);
  const act = useAction();
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (act.busy || (!text.trim() && !file)) return;
    void act.run(async () => {
      const m = file
        ? await upload<Message>(`/communications/conversations/${id}/attachments`, { body: text.trim(), clientId: cid.current }, file)
        : await post<Message>(`/communications/conversations/${id}/messages`, { body: text.trim(), clientId: cid.current });
      onSent(m);
      setText('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      cid.current = newClientId(); // a retry of a failed send keeps the same key
    });
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <form className="msgr-composer" onSubmit={send}>
      <ErrorBox error={act.error} />
      {file && (
        <div className="msgr-picked">
          <Icon name="paperclip" size={16} />
          <span className="picked-name">{file.name}</span>
          <span className="small muted">{sizeFa(file.size)}</span>
          <button type="button" className="icon-btn" onClick={() => setFile(null)} aria-label="حذف فایل">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      <div className="msgr-compose-row">
        <button type="button" className="icon-btn msgr-attach" onClick={() => fileInput.current?.click()} aria-label="پیوست فایل">
          <Icon name="paperclip" />
        </button>
        <input ref={fileInput} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <textarea
          className="input"
          rows={1}
          placeholder={file ? 'توضیح فایل (اختیاری)…' : 'پیام…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={key}
          maxLength={4000}
          aria-label="متن پیام"
        />
        <Button type="submit" busy={act.busy} disabled={!text.trim() && !file} aria-label="ارسال">
          <Icon name="send" size={18} />
        </Button>
      </div>
    </form>
  );
}

function NewConversation({ canGroup, onClose, onCreated }: { canGroup: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [tab, setTab] = useState<'direct' | 'group'>('direct');
  const [userId, setUserId] = useState('');
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const act = useAction();
  const create = () =>
    act.run(async () => {
      const r =
        tab === 'direct'
          ? await post<{ id: string }>('/communications/conversations', { type: 'direct', userId })
          : await post<{ id: string }>('/communications/conversations', { type: 'group', title, memberIds: members.map((m) => m.id) });
      onCreated(r.id);
    });
  return (
    <Modal
      title="گفت‌وگوی جدید"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={create} busy={act.busy} disabled={tab === 'direct' ? !userId : title.trim().length < 2}>
            شروع گفت‌وگو
          </Button>
        </>
      }
    >
      {canGroup && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'direct', label: 'دونفره' },
            { id: 'group', label: 'گروه سازمانی' },
          ]}
        />
      )}
      <ErrorBox error={act.error} />
      {tab === 'direct' ? (
        <Field label="با چه کسی؟">
          <UserSelect value={userId} onChange={setUserId} />
        </Field>
      ) : (
        <>
          <Field label="نام گروه">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} />
          </Field>
          <MemberPicker members={members} onChange={setMembers} />
        </>
      )}
    </Modal>
  );
}

function MemberPicker({ members, onChange }: { members: { id: string; name: string }[]; onChange: (m: { id: string; name: string }[]) => void }) {
  return (
    <Field label="اعضا">
      <UserSelect
        value=""
        placeholder="افزودن عضو…"
        onChange={(id, u) => {
          if (id && !members.some((m) => m.id === id)) onChange([...members, { id, name: u?.full_name ?? '' }]);
        }}
      />
      {members.length > 0 && (
        <div className="row wrap gap-sm mt">
          {members.map((m) => (
            <span key={m.id} className="chip">
              {m.name}{' '}
              <button type="button" className="chip-btn" onClick={() => onChange(members.filter((x) => x.id !== m.id))} aria-label={`حذف ${m.name}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </Field>
  );
}

function ConversationInfo({ d, onClose, onChanged, onLeft }: { d: ConvDetail; onClose: () => void; onChanged: () => void; onLeft: () => void }) {
  const { me } = useAuth();
  const [title, setTitle] = useState(d.title);
  const [adding, setAdding] = useState<{ id: string; name: string }[]>([]);
  const act = useAction();
  const run = (fn: () => Promise<unknown>) =>
    act.run(async () => {
      await fn();
      onChanged();
    });
  const base = `/communications/conversations/${d.id}`;
  return (
    <Modal title={d.conversation_type === 'group' ? 'جزئیات گروه' : 'جزئیات گفت‌وگو'} onClose={onClose}>
      <ErrorBox error={act.error} />
      <label className="row gap-sm mb">
        <input type="checkbox" checked={d.muted} onChange={(e) => run(() => patch(base, { muted: e.target.checked }))} />
        بی‌صدا (برای پیام‌های این گفت‌وگو اعلان نگیرم)
      </label>
      {d.conversation_type === 'group' && d.can_manage && (
        <Field label="نام گروه">
          <div className="row gap-sm">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} />
            <Button variant="secondary" onClick={() => run(() => patch(base, { title }))} disabled={title.trim().length < 2 || title === d.title}>
              ذخیره
            </Button>
          </div>
        </Field>
      )}
      <h4>اعضا ({fa(d.members.length)})</h4>
      <ul className="msgr-members">
        {d.members.map((m) => (
          <li key={m.user_id}>
            <span className="msgr-member-name">
              <strong>{m.full_name}</strong>
              <span className="small muted">{m.position_title ?? ''}</span>
            </span>
            {m.member_role === 'owner' && <Badge tone="accent">مالک</Badge>}
            <Presence online={m.online} />
            {d.can_manage && m.user_id !== me!.id && (
              <Button size="sm" variant="ghost" onClick={() => confirm(`${m.full_name} از گروه حذف شود؟`) && run(() => del(`${base}/members/${m.user_id}`))}>
                حذف
              </Button>
            )}
          </li>
        ))}
      </ul>
      {d.can_manage && (
        <>
          <MemberPicker members={adding} onChange={setAdding} />
          <Button
            variant="secondary"
            disabled={!adding.length}
            onClick={() =>
              run(async () => {
                await post(`${base}/members`, { userIds: adding.map((a) => a.id) });
                setAdding([]);
              })
            }
          >
            افزودن به گروه
          </Button>
        </>
      )}
      {d.conversation_type === 'group' && (
        <div className="row gap-sm mt wrap">
          {d.can_manage && (
            <Button variant="secondary" onClick={() => run(() => patch(base, { isArchived: !d.is_archived }))}>
              {d.is_archived ? 'خارج کردن از بایگانی' : 'بایگانی گروه'}
            </Button>
          )}
          <Button
            variant="danger"
            onClick={() =>
              act.run(async () => {
                if (!confirm('از این گروه خارج می‌شوید؟')) return;
                await del(`${base}/members/${me!.id}`);
                onLeft();
              })
            }
          >
            خروج از گروه
          </Button>
        </div>
      )}
    </Modal>
  );
}
