export interface ApiProfile {
  id: string;
  name: string;
  baseUrl: string;
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
