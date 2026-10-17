import type {
  DigestFeed,
  DigestArticle,
  DigestProfile,
  DigestSettings,
  DigestEdition,
  DigestEditionSummary,
  DigestChatHistoryItem,
  DigestChatRequest,
  DigestChatResponse,
  DigestPollStatus,
  DigestSourceProposal,
  DigestSourceProposalStatus,
  DigestReviewStatus,
  DigestEditorialProposal,
  DigestProposalThread,
  DigestProfileVersion,
  DigestProfileSection,
  DigestResearchSummary,
  DigestResearchDetail,
  DigestResearchStartResult,
  DigestResearchVisualStartResult,
  DigestPodcastInfo,
  DigestPodcastStartResult,
  DigestUsageSummary,
} from 'shared';

import { fetchWithReauth } from './reauth';

const BASE_URL = '/api';

export type AnnouncementSegment = 'all' | 'admin';

export interface Announcement {
  id: number;
  title: string;
  body: string;
  important: boolean;
  targetSegment: AnnouncementSegment;
  startsAt: string;
  endsAt: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserAnnouncement {
  id: number;
  title: string;
  body: string;
  important: boolean;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  readAt: string | null;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetchWithReauth(`${BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (body.code && body.message) throw new Error(body.message);
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    register: (email: string, password: string, displayName: string | undefined, code?: string, setupCode?: string) =>
      request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName, code, setupCode }) }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request('/auth/me'),
    resetPassword: (token: string, newPassword: string) =>
      request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
    googleLogin: (credential: string, code?: string, confirmRegistration?: boolean, setupCode?: string) =>
      request('/auth/google', { method: 'POST', body: JSON.stringify({ credential, code, confirmRegistration, setupCode }) }),
    googleClientId: () => request<{ clientId: string }>('/auth/google/client-id'),
    signupStatus: () => request<{ mode?: 'first_admin' | 'invite_only' }>('/auth/signup-status'),
    logoutOthers: () =>
      request<{ ok: boolean; deletedSessions: number }>('/auth/logout-others', { method: 'POST' }),
  },

  user: {
    updateProfile: (displayName: string) =>
      request<{ ok: boolean; displayName: string }>('/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName }),
      }),
    deleteAccount: (confirm: string) =>
      request<{ ok: boolean; deleted: boolean }>('/user/account', {
        method: 'DELETE',
        body: JSON.stringify({ confirm }),
      }),
  },

  admin: {
    users: () =>
      request<Array<{
        id: number;
        email: string;
        displayName: string | null;
        role: string;
        createdAt: string;
      }>>('/admin/users'),
    updateUser: (id: number, data: Record<string, unknown>) =>
      request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    resetPassword: (id: number) =>
      request<{ temporaryPassword: string }>(`/admin/users/${id}/reset-password`, { method: 'POST' }),
    deleteUser: (id: number, confirm: string) =>
      request<{ ok: true; alreadyDeleted?: boolean }>(`/admin/users/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm }),
      }),
    overview: () =>
      request<{
        totalUsers: number;
        newUsers7d: number;
        newUsers30d: number;
      }>('/admin/analytics/overview'),
    inviteCodes: {
      list: () =>
        request<Array<{
          code: string;
          maxUses: number | null;
          usedCount: number;
          expiresAt: string | null;
          note: string | null;
          isActive: boolean;
          createdBy: number | null;
          createdAt: string;
        }>>('/admin/invite-codes'),
      create: (data: { code?: string; maxUses?: number | null; expiresAt?: string | null; note?: string | null }) =>
        request('/admin/invite-codes', { method: 'POST', body: JSON.stringify(data) }),
      update: (code: string, data: Record<string, unknown>) =>
        request(`/admin/invite-codes/${encodeURIComponent(code)}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        }),
      delete: (code: string) =>
        request(`/admin/invite-codes/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    },
    announcements: {
      list: () => request<Announcement[]>('/admin/announcements'),
      create: (data: {
        title: string;
        body: string;
        important?: boolean;
        targetSegment?: AnnouncementSegment;
        startsAt?: string;
        endsAt?: string | null;
        isPublished?: boolean;
      }) => request<Announcement>('/admin/announcements', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: number, data: Record<string, unknown>) =>
        request<Announcement>(`/admin/announcements/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (id: number) =>
        request(`/admin/announcements/${id}`, { method: 'DELETE' }),
    },
  },

  digest: {
    feeds: () => request<DigestFeed[]>('/digest/feeds'),
    addFeed: (data: { url?: string; keyword?: string; title?: string; category?: string }) =>
      request<DigestFeed & { itemCount?: number }>('/digest/feeds', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateFeed: (id: number, data: { url?: string; title?: string; category?: string; tier?: DigestFeed['tier'] }) =>
      request<DigestFeed>(`/digest/feeds/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    pauseFeed: (id: number) =>
      request<DigestFeed>(`/digest/feeds/${id}/pause`, { method: 'POST' }),
    activateFeed: (id: number) =>
      request<DigestFeed>(`/digest/feeds/${id}/activate`, { method: 'POST' }),
    deleteFeed: (id: number) =>
      request<{ ok: true }>(`/digest/feeds/${id}`, { method: 'DELETE' }),
    articles: (params?: { feedId?: number; limit?: number; offset?: number }) => {
      const q = new URLSearchParams();
      if (params?.feedId != null) q.set('feedId', String(params.feedId));
      if (params?.limit != null) q.set('limit', String(params.limit));
      if (params?.offset != null) q.set('offset', String(params.offset));
      const qs = q.toString();
      return request<{ articles: DigestArticle[]; total: number }>(
        `/digest/articles${qs ? `?${qs}` : ''}`
      );
    },
    poll: async (): Promise<{ started: boolean }> => {
      const res = await fetch(`${BASE_URL}/digest/poll`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) return { started: true };
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (res.status === 409) return { started: false };
      throw new Error((typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
    },
    pollStatus: () => request<DigestPollStatus>('/digest/poll-status'),
    editions: (limit?: number) =>
      request<DigestEditionSummary[]>(
        `/digest/editions${limit != null ? `?limit=${limit}` : ''}`
      ),
    latestEdition: () => request<DigestEdition | null>('/digest/editions/latest'),
    edition: (id: number) => request<DigestEdition>(`/digest/editions/${id}`),
    runEdition: (first?: boolean) =>
      request<{ started: true }>('/digest/editions/run', {
        method: 'POST',
        body: JSON.stringify(first ? { first: true } : {}),
      }),
    profile: () => request<DigestProfile>('/digest/profile'),
    updateProfile: (settings: Partial<DigestSettings>) =>
      request<DigestProfile>('/digest/profile', {
        method: 'PUT',
        body: JSON.stringify({ settings }),
      }),
    chat: ({ messages, deep, premium, attachments }: DigestChatRequest) =>
      request<DigestChatResponse>('/digest/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages,
          ...(deep ? { deep: true } : {}),
          ...(premium ? { premium: true } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      }),
    proposals: (status?: DigestSourceProposalStatus) =>
      request<DigestSourceProposal[]>(
        `/digest/proposals${status ? `?status=${status}` : ''}`
      ),
    approveProposal: (id: number) =>
      request<{ proposal: DigestSourceProposal; feed: DigestFeed }>(
        `/digest/proposals/${id}/approve`,
        { method: 'POST' }
      ),
    rejectProposal: (id: number) =>
      request<DigestSourceProposal>(`/digest/proposals/${id}/reject`, { method: 'POST' }),
    rateArticle: (id: number, rating: 1 | -1 | 0, reason?: string) =>
      request<{ id: number; humanRating: number | null }>(`/digest/articles/${id}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating, ...(reason ? { reason } : {}) }),
      }),
    articleRatings: (ids: number[]) =>
      request<{ ratings: Record<number, 1 | -1> }>(
        `/digest/articles/ratings?ids=${ids.join(',')}`
      ),
    reviewStatus: () => request<DigestReviewStatus>('/digest/review-status'),
    coverage: (days = 30) => request<{ days: number; text: string }>(`/digest/coverage?days=${days}`),
    profileVersions: () =>
      request<{
        current: { content: string; chars: number; sections: DigestProfileSection[] };
        versions: DigestProfileVersion[];
      }>(
        '/digest/editorial-profile/versions',
      ),
    restoreProfile: (proposalId: number) =>
      request<{ ok: true; restoredFrom: number; chars: number }>(
        '/digest/editorial-profile/restore',
        { method: 'POST', body: JSON.stringify({ proposalId }) },
      ),
    editorialProposals: () =>
      request<DigestEditorialProposal[]>('/digest/editorial-proposals'),
    proposalThread: (id: number) =>
      request<DigestProposalThread>(`/digest/editorial-proposals/${id}/thread`),
    sendProposalMessage: (id: number, message: string) =>
      request<DigestProposalThread>(`/digest/editorial-proposals/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }),
    approveEditorialProposal: (id: number, revisionId: number, note?: string) =>
      request<DigestEditorialProposal>(`/digest/editorial-proposals/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ revisionId, ...(note ? { note } : {}) }),
      }),
    dismissEditorialProposal: (id: number, note?: string) =>
      request<DigestEditorialProposal>(`/digest/editorial-proposals/${id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify(note ? { note } : {}),
      }),
    startResearch: async (articleId: number): Promise<DigestResearchStartResult> => {
      const res = await fetch(`${BASE_URL}/digest/articles/${articleId}/research`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) return { started: true };
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (
        res.status === 409 &&
        typeof body.researchId === 'number' &&
        (body.status === 'pending' || body.status === 'running' || body.status === 'done')
      ) {
        return { started: false, status: body.status, researchId: body.researchId };
      }
      throw new Error((typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
    },
    researchList: () => request<DigestResearchSummary[]>('/digest/research'),
    research: (id: number) => request<DigestResearchDetail>(`/digest/research/${id}`),
    startResearchVisual: async (id: number): Promise<DigestResearchVisualStartResult> => {
      const res = await fetch(`${BASE_URL}/digest/research/${id}/visual`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) return { started: true };
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (res.status === 409 && (body.status === 'running' || body.status === 'done')) {
        return { started: false, status: body.status };
      }
      throw new Error((typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
    },
    researchVisualUrl: (id: number) => `${BASE_URL}/digest/research/${id}/visual`,
    chatHistory: () => request<DigestChatHistoryItem[]>('/digest/chat/history'),
    startPodcast: async (
      editionId: number,
      reuse?: boolean
    ): Promise<DigestPodcastStartResult> => {
      const res = await fetch(`${BASE_URL}/digest/editions/${editionId}/podcast`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reuse ? { reuse: true } : {}),
      });
      if (res.ok) return { started: true };
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (
        res.status === 409 &&
        (body.status === 'pending' || body.status === 'running' || body.status === 'done')
      ) {
        return { started: false, status: body.status };
      }
      throw new Error((typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
    },
    podcast: (editionId: number) =>
      request<DigestPodcastInfo>(`/digest/editions/${editionId}/podcast`),
    podcastAudioUrl: (editionId: number) =>
      `${BASE_URL}/digest/editions/${editionId}/podcast/audio`,
    usageSummary: () => request<DigestUsageSummary>('/digest/usage/summary'),
  },

  announcements: {
    list: () => request<UserAnnouncement[]>('/announcements'),
    markRead: (id: number) => request(`/announcements/${id}/read`, { method: 'POST' }),
  },
};
