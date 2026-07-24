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
