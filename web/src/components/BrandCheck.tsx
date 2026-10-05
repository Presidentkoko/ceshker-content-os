import { Badge } from './ui';

export interface BrandCheckValue { status: 'pass' | 'fail' | 'review' | 'error'; detail: string; checked_at: string }

const TONE: Record<BrandCheckValue['status'], string> = { pass: 'success', fail: 'danger', review: 'warning', error: 'outline' };
const LABEL: Record<BrandCheckValue['status'], string> = { pass: 'Logo OK', fail: 'Wrong logo', review: 'No logo found', error: 'Brand check failed to run' };

/** The Canva MCP brand check result for an image, with the reason on hover. */
export function BrandBadge({ check }: { check: BrandCheckValue | null | undefined }) {
  if (!check) return null;
  return <Badge tone={TONE[check.status]} title={check.detail}>{LABEL[check.status]}</Badge>;
}
