
export type DigestFeedKind = 'rss' | 'gnews';
export type DigestFeedStatus = 'active' | 'paused' | 'dead_candidate';
export type DigestFeedTier = 'none' | 'primary';

export interface DigestFeed {
  id: number;
  title: string;
  xmlUrl: string;
  htmlUrl: string | null;
  kind: DigestFeedKind;
  category: string | null;
  tier: DigestFeedTier;
  status: DigestFeedStatus;
  lastFetchedAt: string | null;
  lastPublishedAt: string | null;
  lastError: string | null;
  errorCount: number;
  articleCount?: number;
  adoptedCount?: number;
  healthWarning?: 'stale' | 'no-hits' | null;
  createdAt: string;
}

export interface DigestArticle {
  id: number;
  feedId: number | null;
  feedTitle?: string | null;
  title: string;
  url: string;
  publishedAt: string | null;
  summaryRaw: string | null;
  fetchedAt: string;
}

export type DigestFrequency = 'daily' | 'weekly3' | 'weekly1';

export type SourceSuggestFrequency = 'off' | 'monthly' | 'weekly';

export interface DigestSettings {
  deliveryHour: number;
  frequency: DigestFrequency;
  emailEnabled: boolean;
  sourceSuggestFrequency: SourceSuggestFrequency;
}

export interface DigestProfile {
  settings: DigestSettings;
  onboardedAt: string | null;
}

export const DEFAULT_DIGEST_SETTINGS: DigestSettings = {
  deliveryHour: 6,
  frequency: 'daily',
  emailEnabled: true,
  sourceSuggestFrequency: 'monthly',
};

export type DigestEditionStatus = 'generating' | 'done' | 'failed';
export type DigestEditionFormat = 'brief' | 'paper';

export interface DigestEditionArticle {
  articleId: number;
  headline: string;
  lead: string;
  body: string;
  url: string;
  sourceTitle: string | null;
  score: number | null;
  sourceCount?: number;
}

export interface DigestEditionOtherArticle {
  articleId: number;
  headline: string;
  url: string;
  sourceTitle: string | null;
  publishedAt: string | null;
}

export interface DigestEditionEditorialNote {
  feedCount: number;
  candidateCount: number;
  adoptedCount: number;
  emptySections: string[];
}

export interface DigestEditionContent {
  format: DigestEditionFormat;
  sections: Array<{ name: string; articles: DigestEditionArticle[] }>;
  candidateCount: number;
  sourceCount: number;
  note?: string;
  coverage?: string;
  others?: Array<{ name: string; articles: DigestEditionOtherArticle[] }>;
  editorialNote?: DigestEditionEditorialNote;
}

export interface DigestEditionSummary {
  id: number;
  editionDate: string;
  status: DigestEditionStatus;
  format: DigestEditionFormat;
  title: string;
  articleCount: number;
  isFirstIssue: boolean;
  growingNotice: boolean;
  generatedAt: string | null;
  createdAt: string;
}

export interface DigestEdition extends DigestEditionSummary {
  content: DigestEditionContent | null;
  mailSentAt: string | null;
}

export type DigestSourceProposalStatus = 'proposed' | 'approved' | 'rejected';

export interface DigestSourceProposal {
  id: number;
  origin: string;
  title: string;
  xmlUrl: string;
  kind: DigestFeedKind;
  category: string | null;
  reason: string;
  status: DigestSourceProposalStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface DigestChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type DigestChatAttachmentKind = 'image' | 'pdf' | 'text' | 'docx';

export interface DigestChatAttachment {
  kind: DigestChatAttachmentKind;
  mediaType: string;
  dataBase64: string;
  name: string;
}

export interface DigestPollStatus {
  status: 'none' | 'running' | 'done' | 'failed';
  finishedAt: string | null;
  result: {
    feedCount: number;
    added: number;
    reattached: number;
    notModified: number;
    errorCount: number;
  } | null;
}

export interface DigestChatRequest {
  messages: DigestChatMessage[];
  deep?: boolean;
  premium?: boolean;
  attachments?: DigestChatAttachment[];
}

export interface DigestChatResponse {
  reply: string;
  proposals: DigestSourceProposal[];
}

export interface DigestChatHistoryItem {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  attachmentNames?: string[];
  proposals?: DigestSourceProposal[];
  createdAt: string;
}

export interface DigestReviewStatus {
  signalsSinceLastReview: number;
  threshold: number;
  lastReviewAt: string | null;
  latestProposal: {
    id: number;
    status: DigestEditorialProposalStatus;
    createdAt: string;
  } | null;
}

export type DigestEditorialProposalStatus = 'proposed' | 'approved' | 'dismissed';

export interface DigestEditorialProposal {
  id: number;
  content: string;
  status: DigestEditorialProposalStatus;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface DigestProposalMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  revised: boolean;
  createdAt: string;
}

export interface DigestProposalThread {
  proposalId: number;
  status: DigestEditorialProposalStatus;
  draft: string;
  revisionId: number;
  revisionCount: number;
  messages: DigestProposalMessage[];
  constitutionDiff?: Array<{ section: string; before: string; after: string }>;
  problems?: string[];
}

export interface DigestProfileSection {
  name: string;
  body: string;
  isConstitution: boolean;
}

export interface DigestProfileVersion {
  proposalId: number;
  content: string;
  approvedAt: string | null;
  note: string | null;
  chars: number;
  sections: DigestProfileSection[];
}

export type DigestResearchStatus = 'pending' | 'running' | 'done' | 'failed';
export type DigestResearchVisualStatus = 'none' | 'running' | 'done' | 'failed';

export interface DigestResearchSummary {
  id: number;
  articleId: number;
  headline: string;
  articleUrl: string | null;
  status: DigestResearchStatus;
  visual: DigestResearchVisualStatus;
  requestedAt: string;
  completedAt: string | null;
}

export interface DigestResearchDetail extends DigestResearchSummary {
  report: string | null;
}

export type DigestResearchStartResult =
  | { started: true }
  | { started: false; status: 'pending' | 'running' | 'done'; researchId: number };

export type DigestResearchVisualStartResult =
  | { started: true }
  | { started: false; status: 'running' | 'done' };

export type DigestPodcastStatus = 'pending' | 'running' | 'done' | 'failed' | 'expired';

export type DigestPodcastInfo =
  | { status: 'none' }
  | {
      id: number;
      status: DigestPodcastStatus;
      mimeType: string | null;
      durationSec: number | null;
      audioBytes: number | null;
      createdAt: string;
      completedAt: string | null;
    };

export type DigestPodcastStartResult =
  | { started: true }
  | { started: false; status: 'pending' | 'running' | 'done' };

export interface DigestUsageStage {
  stage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostUsd: number;
}

export interface DigestUsageSummary {
  month: string;
  stages: DigestUsageStage[];
  total: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    estimatedCostUsd: number;
  };
}
