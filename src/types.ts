export type ProfileKind = 'privateApi' | 'officialAccount';

export interface ApiProfile {
  id: string;
  name: string;
  baseUrl: string;
  /** Missing on profiles created before v0.2.0; treat those as private API profiles. */
  kind?: ProfileKind;
}

export interface CapturedProfileAuth {
  kind: ProfileKind;
  baseUrl: string;
  apiKey?: string;
  authJson?: string;
}

export interface CodexConfiguration {
  apiKey: string;
  baseUrl: string;
}

export interface CodexPaths {
  codexDirectory: string;
  authPath: string;
  configPath: string;
  description: string;
}

export interface BackupPolicy {
  maxBackups: number;
  maxAgeDays: number;
}

export interface BackupInfo {
  id: string;
  directory: string;
  createdAt: string;
  profileName?: string;
  reason: 'profile-switch' | 'before-restore';
}

export interface ApplyResult {
  changed: boolean;
  backup?: BackupInfo;
}
