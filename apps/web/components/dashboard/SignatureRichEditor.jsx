'use client';

// ---------------------------------------------------------------------------
// SignatureRichEditor — TipTap-based rich signature editor (client only)
// ---------------------------------------------------------------------------
//
// Wraps TipTap (ProseMirror) with a small dashboard-styled toolbar (bold,
// italic, underline, lists, link, color, alignment, heading, insert image).
// Emits HTML that the parent reads on save via an imperative handle:
//
//   const ref = useRef(null);
//   ...
//   const html = ref.current.getHTML();   // sanitized via sanitizeSignatureHtml
//   const text = ref.current.getText();   // plain-text fallback
//
// `getHTML()` runs the editor output through the shared `sanitizeSignatureHtml`
// so we never hand unsafe markup to the save path; it re-throws the sanitizer's
// >100KB error so the parent can show a "signature too large" message and block
// the save instead of persisting truncated markup.
//
// Initial content: prefer `initialHtml` (sanitized before loading so we never
// inject unsafe stored HTML into the DOM), else convert `initialText` to simple
// HTML, else empty.
//
// TipTap runs client-side only. `useEditor({ immediatelyRender: false })` keeps
// it out of SSR under Next 16 / React 19.
// ---------------------------------------------------------------------------

import {
  useEditor,
  EditorContent,
} from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Underline } from '@tiptap/extension-underline';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Btn } from '../Primitives';
import { sanitizeSignatureHtml } from '@/lib/sanitizeSignatureHtml';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB, mirrors the server cap.

/** Escape + newline→<br> so plain-text signatures load as simple HTML. */
function textToHtml(text) {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n/)
    .map((line) => (line === '' ? '<br>' : `<p>${line}</p>`))
    .join('');
}

/** Choose the editor's starting HTML, sanitizing any stored HTML first. */
function computeInitialContent(initialHtml, initialText) {
  if (initialHtml && initialHtml.trim()) {
    try {
      return sanitizeSignatureHtml(initialHtml);
    } catch {
      // Stored HTML too large / invalid: fall back to the text seed.
    }
  }
  if (initialText && initialText.trim()) return textToHtml(initialText);
  return '';
}

const ToolbarButton = ({ active, onClick, disabled, title, children }) => (
  <button
    type="button"
    className={'sig-tb-btn' + (active ? ' is-active' : '')}
    onMouseDown={(e) => e.preventDefault()} // keep editor selection
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={title}
    aria-pressed={active || undefined}
  >
    {children}
  </button>
);

const SignatureRichEditor = forwardRef(function SignatureRichEditor(
  { inboxId, initialHtml, initialText, disabled = false, onChange },
  ref,
) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        // Link is added separately so we control its options.
        link: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
    ],
    content: computeInitialContent(initialHtml, initialText),
    onUpdate: () => {
      if (onChange) onChange();
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      /**
       * Sanitized HTML for the save path. Re-throws the sanitizer's >100KB
       * error so the parent can block the save and show an inline message.
       */
      getHTML() {
        if (!editor) return '';
        return sanitizeSignatureHtml(editor.getHTML());
      },
      getText() {
        return editor ? editor.getText() : '';
      },
      isEmpty() {
        return editor ? editor.isEmpty : true;
      },
    }),
    [editor],
  );

  if (!editor) {
    // Pre-mount placeholder so layout doesn't jump before the client editor
    // hydrates (useEditor returns null until it initializes).
    return <div className="sig-editor sig-editor--loading" aria-hidden />;
  }

  const setLink = () => {
    const prev = editor.getAttributes('link').href || '';
    const url = window.prompt('Link URL (http(s):// or mailto:)', prev);
    if (url === null) return; // cancelled
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const trimmed = url.trim();
    if (!/^(https?:|mailto:)/i.test(trimmed)) {
      setUploadError('Links must start with http://, https:// or mailto:');
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: trimmed })
      .run();
  };

  const onPickImage = () => {
    setUploadError('');
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const onImageSelected = async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so re-selecting the same file fires change again.
    e.target.value = '';
    if (!file) return;

    setUploadError('');
    if (!IMAGE_ACCEPT.split(',').includes(file.type)) {
      setUploadError('Unsupported image type. Use PNG, JPEG, GIF or WebP.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError('Image is too large (max 2 MB).');
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/inboxes/${inboxId}/signature/image`, {
        method: 'POST',
        body: form,
      });
      let data = {};
      try {
        data = await res.json();
      } catch {
        /* ignore parse failure */
      }
      if (!res.ok || !data.url) {
        const msg =
          typeof data?.error === 'string' ? data.error : 'Image upload failed.';
        setUploadError(msg);
        return;
      }
      editor.chain().focus().setImage({ src: data.url }).run();
      if (onChange) onChange();
    } catch {
      setUploadError('Image upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const setColor = (e) => {
    editor.chain().focus().setColor(e.target.value).run();
  };
  const currentColor = editor.getAttributes('textStyle').color || '#0b1020';

  return (
    <div className={'sig-editor' + (disabled ? ' is-disabled' : '')}>
      <div className="sig-toolbar" role="toolbar" aria-label="Signature formatting">
        <ToolbarButton
          title="Bold"
          active={editor.isActive('bold')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <span style={{ fontWeight: 700 }}>B</span>
        </ToolbarButton>
        <ToolbarButton
          title="Italic"
          active={editor.isActive('italic')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <span style={{ fontStyle: 'italic' }}>I</span>
        </ToolbarButton>
        <ToolbarButton
          title="Underline"
          active={editor.isActive('underline')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <span style={{ textDecoration: 'underline' }}>U</span>
        </ToolbarButton>

        <span className="sig-tb-sep" aria-hidden />

        <ToolbarButton
          title="Heading"
          active={editor.isActive('heading', { level: 2 })}
          disabled={disabled}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          H
        </ToolbarButton>
        <ToolbarButton
          title="Bullet list"
          active={editor.isActive('bulletList')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          &bull;
        </ToolbarButton>
        <ToolbarButton
          title="Numbered list"
          active={editor.isActive('orderedList')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          1.
        </ToolbarButton>

        <span className="sig-tb-sep" aria-hidden />

        <ToolbarButton
          title="Align left"
          active={editor.isActive({ textAlign: 'left' })}
          disabled={disabled}
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
        >
          &#8676;
        </ToolbarButton>
        <ToolbarButton
          title="Align center"
          active={editor.isActive({ textAlign: 'center' })}
          disabled={disabled}
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
        >
          &#8677;&#8676;
        </ToolbarButton>
        <ToolbarButton
          title="Align right"
          active={editor.isActive({ textAlign: 'right' })}
          disabled={disabled}
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
        >
          &#8677;
        </ToolbarButton>

        <span className="sig-tb-sep" aria-hidden />

        <ToolbarButton
          title="Add / edit link"
          active={editor.isActive('link')}
          disabled={disabled}
          onClick={setLink}
        >
          &#128279;
        </ToolbarButton>
        <label className="sig-tb-btn sig-tb-color" title="Text color">
          <span style={{ color: currentColor, fontWeight: 700 }}>A</span>
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : '#0b1020'}
            onChange={setColor}
            disabled={disabled}
            aria-label="Text color"
          />
        </label>

        <span className="sig-tb-sep" aria-hidden />

        <ToolbarButton
          title="Insert image"
          disabled={disabled || uploading}
          onClick={onPickImage}
        >
          {uploading ? '…' : '🖼'}
        </ToolbarButton>
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          onChange={onImageSelected}
          style={{ display: 'none' }}
        />
      </div>

      <EditorContent editor={editor} className="sig-content" />

      {uploadError && (
        <div className="sig-editor-error" role="alert">
          {uploadError}
        </div>
      )}
    </div>
  );
});

export default SignatureRichEditor;
