export type UserRole = 'user' | 'admin';

export interface User {
  id: number;
  email: string;
  displayName: string | null;
  role: UserRole;
  createdAt: string;
  features?: ServerFeatures;
}

export interface ServerFeatures {
  googleLogin: boolean;
  email: boolean;
  podcast: boolean;
}

export const ALL_FEATURES_ON: ServerFeatures = {
  googleLogin: true,
  email: true,
  podcast: true,
};

export interface GoogleNeedsRegistrationResponse {
  needsRegistration: true;
  email: string;
  name: string | null;
}

export interface AuthSession {
  userId: number;
  email: string;
  displayName: string | null;
}

export const PRODUCT_NAME = 'AI RSS Digest';

export interface SiteConfig {
  appName: string;
  organizationName: string;
  supportEmail: string;
  termsUrl: string;
  privacyUrl: string;
}
