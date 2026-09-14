'use client';
import { useEffect, useRef } from 'react';
import { descriptionHtml } from '@/lib/domain/description';

export function DescriptionPreview({ value }: { value: unknown }) {
  return <div className="description-content" dangerouslySetInnerHTML={{ __html: descriptionHtml(value) }} />;
}

export function DescriptionEditor({ value, readOnly, label, onChange }: { value: unknown; readOnly: boolean; label: string; onChange: (value: string) => void }) {
  const editor = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  useEffect(() => {
    // Keep the caret stable while parent state follows typing.
    if (editor.current && value !== emitted.current) editor.current.innerHTML = descriptionHtml(value);
  }, [value]);
  const change = () => {
    const html = descriptionHtml(editor.current?.innerHTML || '');
    emitted.current = html;
    onChange(html);
  };
  return <div ref={editor} className="description-content description-editor" role="textbox" aria-label={label} aria-multiline="true" aria-readonly={readOnly} contentEditable={!readOnly} suppressContentEditableWarning onInput={change} onDrop={event => event.preventDefault()} onPaste={event => {
    event.preventDefault();
    if (readOnly) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.current?.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const text = document.createTextNode(event.clipboardData.getData('text/plain'));
    range.insertNode(text);
    range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    change();
  }} />;
}
