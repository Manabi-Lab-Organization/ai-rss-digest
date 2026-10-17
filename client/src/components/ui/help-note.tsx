import { useState, type ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

export function HelpNote({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${label}の説明を${open ? '閉じる' : '見る'}`}
        className="inline-flex items-center text-muted-foreground hover:text-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && (
        <p className="mt-1 rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {children}
        </p>
      )}
    </>
  );
}

export function SectionHeading({
  title, help, children,
}: { title: string; help?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-2 px-1">
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {help && <HelpNote label={title}>{help}</HelpNote>}
        {children}
      </div>
    </div>
  );
}
