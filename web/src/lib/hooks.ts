import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText } from './api';
import { useUi } from './ui-state';

export interface PublicBrand {
  key: string;
  name: string;
  mark: string;
  subtitle: string;
  socialName: string;
  videoBrand: string;
  libraryTitle: string;
  libraryBlurb: string;
  voice: string;
}

export interface Meta {
  timezone: string;
  brand: PublicBrand;
  canva_configured?: boolean;
  categories: string[];
  content_types: string[];
  platforms: string[];
  platform_placements: Record<string, string[]>;
  campaigns: { id: string; name: string; slug: string }[];
  derivatives: { kind: string; label: string }[];
  sheet_url: string | null;
  meta_pages: { page_id: string; name: string; ig_user_id: string | null; ig_username: string | null; is_default: boolean }[];
}

export function useBrand() {
  return useQuery({ queryKey: ['brand'], queryFn: () => api.get<PublicBrand>('/brand'), staleTime: Infinity });
}

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta'), staleTime: 60_000 });
}

/**
 * Runs a server action with consistent feedback: busy state, success/error
 * toasts, and a refresh of every cached query so all views stay consistent.
 */
export function useAction() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  async function run<T>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> {
    setBusy(key);
    try {
      const r = await fn();
      if (success) toast('success', typeof success === 'function' ? success(r) : success);
      await qc.invalidateQueries();
      return r;
    } catch (e) {
      toast('error', 'Action failed', errorText(e));
      await qc.invalidateQueries();
      return undefined;
    } finally {
      setBusy(null);
    }
  }
  return { run, busy };
}
