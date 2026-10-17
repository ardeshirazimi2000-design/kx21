import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { useEffect, type ReactNode } from 'react';

const SIZES = ['10pt', '11pt', '12pt', '13pt', '14pt', '16pt', '18pt', '20pt', '24pt'];

/**
 * Word-like rich-text editor for the letter body (RTL). Produces the HTML subset the API keeps
 * (see office-api/src/lib/html.ts); the server sanitises it again.
 */
export function LetterEditor({
  value,
  onChange,
  placeholder,
  frame = (content) => content,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Wraps the typing area (e.g. in the letterhead page) below the toolbar. */
  frame?: (content: ReactNode) => ReactNode;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: { levels: [1, 2, 3] } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyleKit.configure({ backgroundColor: false, fontFamily: false, lineHeight: false }),
      TableKit.configure({ table: { resizable: false } }),
    ],
    content: value || '<p></p>',
    editorProps: { attributes: { class: 'letter-html editor-area', dir: 'rtl', 'aria-label': placeholder ?? 'متن نامه' } },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? '' : e.getHTML()),
  });
  // Outside changes (a template's starting text) replace the content.
  useEffect(() => {
    if (editor && value !== editor.getHTML() && !(value === '' && editor.isEmpty)) editor.commands.setContent(value || '<p></p>', { emitUpdate: false });
  }, [editor, value]);
  if (!editor) return null;
  return (
    <div className="editor">
      <Toolbar editor={editor} />
      {frame(<EditorContent editor={editor} />)}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      table: e.isActive('table'),
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      align: (['right', 'center', 'left', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? '',
      size: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      color: (e.getAttributes('textStyle').color as string | undefined) ?? '#000000',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  const btn = (label: ReactNode, title: string, run: () => void, active = false, disabled = false) => (
    <button
      type="button"
      className={`tb ${active ? 'on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="ابزار ویرایش">
      {btn('↶', 'واگرد', () => c().undo().run(), false, !s.canUndo)}
      {btn('↷', 'ازنو', () => c().redo().run(), false, !s.canRedo)}
      <span className="sep" />
      <select
        className="tb-select"
        title="سبک"
        value={s.block}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'p') c().setParagraph().run();
          else
            c()
              .setHeading({ level: Number(v[1]) as 1 | 2 | 3 })
              .run();
        }}
      >
        <option value="p">متن عادی</option>
        <option value="h1">عنوان ۱</option>
        <option value="h2">عنوان ۲</option>
        <option value="h3">عنوان ۳</option>
      </select>
      <select
        className="tb-select"
        title="اندازه قلم"
        value={s.size}
        onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}
      >
        <option value="">اندازه</option>
        {SIZES.map((x) => (
          <option key={x} value={x}>
            {Number.parseInt(x, 10).toLocaleString('fa')}
          </option>
        ))}
      </select>
      <span className="sep" />
      {btn(<b>ب</b>, 'پررنگ (Ctrl+B)', () => c().toggleBold().run(), s.bold)}
      {btn(<i>ک</i>, 'کج (Ctrl+I)', () => c().toggleItalic().run(), s.italic)}
      {btn(<u>ز</u>, 'زیرخط (Ctrl+U)', () => c().toggleUnderline().run(), s.underline)}
      {btn(<s>خ</s>, 'خط‌خورده', () => c().toggleStrike().run(), s.strike)}
      <label className="tb tb-color" title="رنگ متن">
        <span style={{ borderBottom: `3px solid ${s.color}` }}>رنگ</span>
        <input type="color" value={s.color} onChange={(e) => c().setColor(e.target.value).run()} aria-label="رنگ متن" />
      </label>
      <span className="sep" />
      {btn('⇶', 'راست‌چین', () => c().setTextAlign('right').run(), s.align === 'right')}
      {btn('≡', 'وسط‌چین', () => c().setTextAlign('center').run(), s.align === 'center')}
      {btn('⇇', 'چپ‌چین', () => c().setTextAlign('left').run(), s.align === 'left')}
      {btn('☰', 'تراز از دو طرف', () => c().setTextAlign('justify').run(), s.align === 'justify')}
      <span className="sep" />
      {btn('•', 'فهرست نقطه‌ای', () => c().toggleBulletList().run(), s.bullet)}
      {btn('۱.', 'فهرست شماره‌دار', () => c().toggleOrderedList().run(), s.ordered)}
      {btn('—', 'خط جداکننده', () => c().setHorizontalRule().run())}
      <span className="sep" />
      {btn('▦', 'درج جدول', () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      {s.table && (
        <>
          {btn('+سطر', 'افزودن سطر', () => c().addRowAfter().run())}
          {btn('+ستون', 'افزودن ستون', () => c().addColumnAfter().run())}
          {btn('−سطر', 'حذف سطر', () => c().deleteRow().run())}
          {btn('−ستون', 'حذف ستون', () => c().deleteColumn().run())}
          {btn('×جدول', 'حذف جدول', () => c().deleteTable().run())}
        </>
      )}
      <span className="sep" />
      {btn('⌫', 'پاک کردن قالب‌بندی', () => c().unsetAllMarks().clearNodes().run())}
    </div>
  );
}
