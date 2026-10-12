import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n';

/** In-place per-block editor: readable view stays, tools appear only here. */
export function BlockEditor({ initialValue, onSave, onCancel, onDraftChange }: {
  initialValue: string;
  onSave: (draft: string) => void;
  onCancel: () => void;
  onDraftChange?: (draft: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(initialValue);
  draftRef.current = draft;

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    autogrow(area);
  }, []);

  const save = () => onSave(draftRef.current);

  return (
    <div
      data-block-editor
      role="group"
      aria-label={t("preview.editing_block")}
      className="my-2 rounded-[var(--r-md)] border border-[var(--accent)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-pop)]"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onSave(draftRef.current);
      }}
    >
      <textarea
        ref={areaRef}
        value={draft}
        rows={Math.min(Math.max(initialValue.split('\n').length + 1, 3), 12)}
        aria-label={t("preview.editing_block")}
        className="max-h-[50vh] min-h-24 w-full resize-none overflow-y-auto rounded-[var(--r-sm)] bg-transparent p-1 font-mono text-[16px] leading-relaxed text-[var(--text-primary)] outline-none"
        onChange={(event) => {
          setDraft(event.target.value);
          autogrow(event.target);
          onDraftChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-quaternary)]">
          {t("preview.block_edit_hint")}
        </span>
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
          className="h-8 shrink-0 rounded-[var(--r-md)] border border-[var(--border-default)] px-3 text-[12.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={save}
          className="h-8 shrink-0 rounded-[var(--r-md)] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-[var(--accent-contrast)] transition-transform active:translate-y-px"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

function autogrow(area: HTMLTextAreaElement): void {
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * 0.5))}px`;
}
