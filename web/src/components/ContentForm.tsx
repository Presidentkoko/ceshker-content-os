import { useState } from 'react';
import { PLATFORM_LABELS, type ContentItem, type Platform } from '../../../shared/domain';
import { zonedToUtc } from '../../../shared/time';
import { useMeta } from '../lib/hooks';
import { toLocalInput } from '../lib/format';

export interface ContentFormValue {
  title: string;
  caption: string;
  description: string;
  cta: string;
  hashtags: string;
  notes: string;
  category: string;
  priority: string;
  content_type: string;
  campaign_id: string;
  date: string;
  time: string;
  timezone: string;
  targets: string[]; // "platform:placement"
  /** Chosen Facebook Page id / Instagram user id per platform; '' = default Page. */
  accounts: { facebook: string; instagram: string };
}

export function toFormValue(c: Partial<ContentItem> | null, tz: string): ContentFormValue {
  const local = toLocalInput(c?.scheduled_at ?? null, c?.timezone ?? tz);
  return {
    title: c?.title ?? '',
    caption: c?.caption ?? '',
    description: c?.description ?? '',
    cta: c?.cta ?? '',
    hashtags: c?.hashtags ?? '',
    notes: c?.notes ?? '',
    category: c?.category ?? 'General',
    priority: c?.priority ? String(c.priority) : '',
    content_type: c?.content_type ?? 'post',
    campaign_id: c?.campaign_id ?? '',
    date: local.date,
    time: local.time || '10:00',
    timezone: c?.timezone ?? tz,
    targets: [...new Set((c?.targets ?? []).map((t) => `${t.platform}:${t.placement}`))],
    accounts: {
      facebook: c?.targets?.find((t) => t.platform === 'facebook')?.account_id ?? '',
      instagram: c?.targets?.find((t) => t.platform === 'instagram')?.account_id ?? '',
    },
  };
}

/** Converts the form to the API payload. */
export function toPayload(v: ContentFormValue) {
  return {
    title: v.title.trim(),
    caption: v.caption,
    description: v.description,
    cta: v.cta,
    hashtags: v.hashtags,
    notes: v.notes,
    category: v.category,
    priority: v.priority ? Number(v.priority) : null,
    content_type: v.content_type,
    campaign_id: v.campaign_id || null,
    timezone: v.timezone,
    scheduled_at: v.date ? zonedToUtc(v.date, v.time || '10:00', v.timezone).toISOString() : null,
    targets: v.targets.map((t) => {
      const [platform, placement] = t.split(':');
      const account = platform === 'facebook' || platform === 'instagram' ? v.accounts[platform] : '';
      return { platform: platform as Platform, placement: placement as any, account_id: account || null };
    }),
  };
}

const TIMEZONES = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'UTC'];

export function ContentForm({ value, onChange, disabled }: { value: ContentFormValue; onChange: (v: ContentFormValue) => void; disabled?: boolean }) {
  const { data: meta } = useMeta();
  const set = <K extends keyof ContentFormValue>(k: K, v: ContentFormValue[K]) => onChange({ ...value, [k]: v });
  const toggle = (key: string) => set('targets', value.targets.includes(key) ? value.targets.filter((t) => t !== key) : [...value.targets, key]);
  const [touched, setTouched] = useState(false);
  const hasYoutube = value.targets.some((t) => t.startsWith('youtube'));

  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
      <div className="field">
        <label htmlFor="f-title">Title</label>
        <input id="f-title" className="input" value={value.title} onChange={(e) => set('title', e.target.value)} onBlur={() => setTouched(true)} maxLength={300} required />
        {touched && !value.title.trim() && <span className="error">Title is required.</span>}
        {hasYoutube && <span className="help">YouTube: lead with the question or subject; keep under 100 characters ({value.title.length}/100).</span>}
      </div>
      <div className="grid grid-3">
        <div className="field">
          <label htmlFor="f-cat">Category</label>
          <select id="f-cat" className="select" value={value.category} onChange={(e) => set('category', e.target.value)}>
            {meta?.categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-type">Content type</label>
          <select id="f-type" className="select" value={value.content_type} onChange={(e) => set('content_type', e.target.value)}>
            {meta?.content_types.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-prio">Priority</label>
          <select id="f-prio" className="select" value={value.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="">None</option>
            <option value="1">P1 · Time-sensitive</option>
            <option value="2">P2 · Important</option>
            <option value="3">P3 · Normal</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-camp">Campaign</label>
        <select id="f-camp" className="select" value={value.campaign_id} onChange={(e) => set('campaign_id', e.target.value)}>
          <option value="">No campaign</option>
          {meta?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="field">
        <span className="field-label">Destinations</span>
        <div className="stack-sm">
          {meta &&
            // Only platforms the dashboard publishes to, plus any other already chosen on this post.
            Object.entries(meta.platform_placements).filter(([p]) => ['facebook', 'instagram', 'youtube'].includes(p) || value.targets.some((t) => t.startsWith(p + ':'))).map(([p, placements]) => (
              <div key={p} className="row-wrap">
                <span style={{ width: 90 }} className="small muted">{PLATFORM_LABELS[p as Platform]}</span>
                <div className="checks">
                  {(p === 'facebook' || p === 'instagram') && (meta?.meta_pages?.length ?? 0) > 1 && (
                    <select className="select sm" aria-label={`${PLATFORM_LABELS[p as Platform]} account`} style={{ width: 'auto' }} value={value.accounts[p]} onChange={(e) => set('accounts', { ...value.accounts, [p]: e.target.value })}>
                      <option value="">Default Page</option>
                      {meta!.meta_pages.filter((mp) => p === 'facebook' || mp.ig_user_id).map((mp) => (
                        <option key={mp.page_id} value={p === 'facebook' ? mp.page_id : mp.ig_user_id!}>{p === 'facebook' ? mp.name : `@${mp.ig_username}`}{mp.is_default ? ' (default)' : ''}</option>
                      ))}
                    </select>
                  )}
                  {placements.map((pl) => {
                    const key = `${p}:${pl}`;
                    const on = value.targets.includes(key);
                    return (
                      <label key={key} className={`check-pill ${on ? 'on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => toggle(key)} />
                        {pl}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-caption">Caption</label>
        <textarea id="f-caption" className="textarea" rows={7} value={value.caption} onChange={(e) => set('caption', e.target.value)} />
        <span className="help">{value.caption.length.toLocaleString()} characters · Instagram limit 2,200</span>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="f-cta">Call to action</label>
          <input id="f-cta" className="input" value={value.cta} onChange={(e) => set('cta', e.target.value)} placeholder="e.g. Download the free Texas Creative Finance Closing Checklist" />
        </div>
        <div className="field">
          <label htmlFor="f-tags">Hashtags</label>
          <input id="f-tags" className="input" value={value.hashtags} onChange={(e) => set('hashtags', e.target.value)} placeholder="#CreativeFinance #TexasRealEstate" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-desc">Description {hasYoutube ? '(YouTube)' : ''}</label>
        <textarea id="f-desc" className="textarea" rows={4} value={value.description} onChange={(e) => set('description', e.target.value)} />
      </div>
      <div className="grid grid-3">
        <div className="field">
          <label htmlFor="f-date">Publication date</label>
          <input id="f-date" type="date" className="input" value={value.date} onChange={(e) => set('date', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-time">Time</label>
          <input id="f-time" type="time" className="input" value={value.time} onChange={(e) => set('time', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-tz">Time zone</label>
          <select id="f-tz" className="select" value={value.timezone} onChange={(e) => set('timezone', e.target.value)}>
            {[...new Set([value.timezone, ...TIMEZONES])].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-notes">Internal notes</label>
        <textarea id="f-notes" className="textarea" rows={3} value={value.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>
    </fieldset>
  );
}
