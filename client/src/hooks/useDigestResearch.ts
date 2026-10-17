import { useQuery } from '@tanstack/react-query';
import type { DigestResearchStatus, DigestResearchSummary } from 'shared';
import { api } from '../lib/api';

export function isResearchActive(status: DigestResearchStatus): boolean {
  return status === 'pending' || status === 'running';
}

const ACTIVE_POLL_INTERVAL_MS = 20_000;

export function useResearchList(enabled = true) {
  return useQuery<DigestResearchSummary[]>({
    queryKey: ['digest', 'research'],
    queryFn: () => api.digest.researchList(),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.some((r) => isResearchActive(r.status)) ? ACTIVE_POLL_INTERVAL_MS : false,
  });
}
