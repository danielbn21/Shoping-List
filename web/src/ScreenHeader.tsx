import type { ReactNode } from 'react';
import { t, isRtl } from './i18n';
import { useMedia } from './util';

export type Crumb = { label: string; onClick?: () => void };

// The header every screen below Home shares: the back arrow always in the same place, the title with a scope line (what this screen changes),
// and the menu or actions on the other side. On a desktop the scope line becomes a breadcrumb. Home uses it without the arrow (1.9.2).
export default function ScreenHeader({ title, scope, onBack, backLabel, crumbs, right, color, brand }: {
  title: string; scope?: string; onBack?: () => void; backLabel?: string; crumbs?: Crumb[]; right?: ReactNode; color?: string; brand?: boolean;
}) {
  const wide = useMedia('(min-width: 1024px)');
  const label = backLabel ?? t('back');
  return (
    <header className="screenhead">
      {onBack
        ? <button type="button" className="iconbtn" onClick={onBack} aria-label={label} title={label}>{isRtl() ? '→' : '←'}</button>
        : brand && <img className="screenlogo" src="/icon-192.png" alt="" />}
      <div className="screentitles grow">
        <h1 dir="auto" style={color ? { borderBottom: `5px solid ${color}` } : undefined}>{title}</h1>
        {wide && crumbs && crumbs.length > 1
          ? <nav className="crumbs" aria-label={t('breadcrumb')}>{crumbs.map((c, k) => (
              <span key={k}>{k > 0 && <span aria-hidden="true"> › </span>}{c.onClick && k < crumbs.length - 1 ? <button type="button" className="btn link" onClick={c.onClick}>{c.label}</button> : <span dir="auto">{c.label}</span>}</span>
            ))}</nav>
          : scope && <span className="muted scope" dir="auto">{scope}</span>}
      </div>
      {right}
    </header>
  );
}
