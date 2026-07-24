import * as TOML from '@iarna/toml';
import * as crypto from 'node:crypto';
import { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ApplyResult, BackupInfo, BackupPolicy, CapturedProfileAuth, CodexConfiguration, CodexPaths } from './types';

const PROVIDER_SECTION = /^\s*\[\s*model_providers\.OpenAI\s*\]\s*(?:#.*)?\r?$/;
const SECTION = /^\s*\[/;
const BASE_URL = /^(\s*base_url\s*=\s*)("(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)(\r?)$/;
const AUTH_KEY_VALUE = /("OPENAI_API_KEY"\s*:\s*)("(?:\\.|[^"\\])*")/;
const BACKUP_DIRECTORY = 'codex-switch-backups';
const MIN_BACKUPS_TO_KEEP = 3;

export const DEFAULT_BACKUP_POLICY: BackupPolicy = { maxBackups: 10, maxAgeDays: 30 };

interface BackupManifest {
  version: 1;
  createdAt: string;
  profileName?: string;
  reason: BackupInfo['reason'];
}

interface ApplyOptions {
  profileName?: string;
  policy?: BackupPolicy;
}

export function validateBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : 'URL must start with http:// or https://.';
  } catch {
    return 'Enter a valid API URL.';
  }
}

export class CodexConfigService {
  public async readCurrent(paths: CodexPaths): Promise<CodexConfiguration> {
    const [authText, tomlText] = await this.readConfigurationFiles(paths);
    return this.parseConfiguration(authText, tomlText);
  }

  /** Capture the complete current auth document without exposing its contents to callers' logs. */
  public async captureCurrentProfile(paths: CodexPaths): Promise<CapturedProfileAuth> {
    const [authJson, tomlText] = await this.readConfigurationFiles(paths);
    const auth = this.parseAuthDocument(authJson);
    const apiKey = auth.OPENAI_API_KEY;
    const baseUrl = this.extractBaseUrl(tomlText);
    if (typeof apiKey === 'string' && apiKey.trim()) {
      return { kind: 'privateApi', baseUrl, apiKey };
    }
    return { kind: 'officialAccount', baseUrl, authJson };
  }

  public async apply(
    paths: CodexPaths,
    configuration: CodexConfiguration,
    options: ApplyOptions = {},
  ): Promise<ApplyResult> {
    const urlError = validateBaseUrl(configuration.baseUrl);
    if (urlError) {
      throw new Error(urlError);
    }
    if (!configuration.apiKey.trim()) {
      throw new Error('API Key cannot be empty.');
    }

    const [authText, tomlText] = await this.readConfigurationFiles(paths);
    const currentAuth = this.parseAuthDocument(authText);
    const currentApiKey = typeof currentAuth.OPENAI_API_KEY === 'string' ? currentAuth.OPENAI_API_KEY : undefined;
    if (currentApiKey === configuration.apiKey && this.extractBaseUrl(tomlText) === configuration.baseUrl) {
      return { changed: false };
    }

    const backup = await this.writePair(
      paths,
      this.patchAuth(authText, configuration.apiKey),
      this.patchToml(tomlText, configuration.baseUrl),
      { profileName: options.profileName, reason: 'profile-switch', policy: options.policy },
    );
    return { changed: true, backup };
  }

  /** Restore an official-account auth snapshot while changing only Codex's provider base URL. */
  public async applyOfficial(
    paths: CodexPaths,
    baseUrl: string,
    authJson: string,
    options: ApplyOptions = {},
  ): Promise<ApplyResult> {
    const urlError = validateBaseUrl(baseUrl);
    if (urlError) {
      throw new Error(urlError);
    }
    this.parseAuthDocument(authJson);
    const [currentAuth, currentToml] = await this.readConfigurationFiles(paths);
    if (currentAuth === authJson && this.extractBaseUrl(currentToml) === baseUrl) {
      return { changed: false };
    }
    const backup = await this.writePair(
      paths,
      authJson,
      this.patchToml(currentToml, baseUrl),
      { profileName: options.profileName, reason: 'profile-switch', policy: options.policy },
    );
    return { changed: true, backup };
  }

  public async listBackups(paths: CodexPaths): Promise<BackupInfo[]> {
    const root = this.backupRoot(paths);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (this.isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const backups: BackupInfo[] = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const directory = path.join(root, entry.name);
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
        if (manifest.version !== 1 || !manifest.createdAt || !this.isBackupReason(manifest.reason)) {
          continue;
        }
        backups.push({
          id: entry.name,
          directory,
          createdAt: manifest.createdAt,
          profileName: manifest.profileName || undefined,
          reason: manifest.reason,
        });
      } catch {
        // Ignore incomplete or manually altered backup directories.
      }
    }
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public async pruneBackups(paths: CodexPaths, policy: BackupPolicy): Promise<BackupInfo[]> {
    const backups = await this.listBackups(paths);
    const keepCount = Math.max(MIN_BACKUPS_TO_KEEP, this.normalizedPolicy(policy).maxBackups);
    const maxAgeDays = this.normalizedPolicy(policy).maxAgeDays;
    const expiration = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : undefined;
    const removed: BackupInfo[] = [];

    for (const [index, backup] of backups.entries()) {
      const isProtected = index < MIN_BACKUPS_TO_KEEP;
      const isOverCount = index >= keepCount;
      const isExpired = expiration !== undefined && Date.parse(backup.createdAt) < expiration;
      if (!isProtected && (isOverCount || isExpired)) {
        await this.deleteBackup(paths, backup);
        removed.push(backup);
      }
    }
    return removed;
  }

  public async restoreBackup(
    paths: CodexPaths,
    backup: BackupInfo,
    policy: BackupPolicy = DEFAULT_BACKUP_POLICY,
  ): Promise<ApplyResult> {
    this.assertBackupBelongsTo(paths, backup);
    const [authText, tomlText] = await Promise.all([
      fs.readFile(path.join(backup.directory, 'auth.json'), 'utf8'),
      fs.readFile(path.join(backup.directory, 'config.toml'), 'utf8'),
    ]);
    this.parseAuthDocument(authText);
    this.extractBaseUrl(tomlText);
    const [currentAuth, currentToml] = await this.readConfigurationFiles(paths);
    if (currentAuth === authText && currentToml === tomlText) {
      return { changed: false };
    }
    const createdBackup = await this.writePair(paths, authText, tomlText, {
      reason: 'before-restore',
      policy,
    });
    return { changed: true, backup: createdBackup };
  }

  public async deleteBackup(paths: CodexPaths, backup: BackupInfo): Promise<void> {
    this.assertBackupBelongsTo(paths, backup);
    await fs.rm(backup.directory, { recursive: true, force: false });
  }

  public async listLegacyBackupFiles(paths: CodexPaths): Promise<string[]> {
    const names = await fs.readdir(paths.codexDirectory);
    return names.filter((name) => /^(auth\.json|config\.toml)\.codex-switch\..+\.bak$/.test(name));
  }

  public async removeLegacyBackupFiles(paths: CodexPaths): Promise<number> {
    const names = await this.listLegacyBackupFiles(paths);
    await Promise.all(names.map((name) => fs.rm(path.join(paths.codexDirectory, name), { force: false })));
    return names.length;
  }

  private async readConfigurationFiles(paths: CodexPaths): Promise<[string, string]> {
    return Promise.all([fs.readFile(paths.authPath, 'utf8'), fs.readFile(paths.configPath, 'utf8')]);
  }

  private parseConfiguration(authText: string, tomlText: string): CodexConfiguration {
    const auth = this.parseAuthDocument(authText);
    const apiKey = auth.OPENAI_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('auth.json does not contain a non-empty OPENAI_API_KEY.');
    }
    return { apiKey, baseUrl: this.extractBaseUrl(tomlText) };
  }

  private parseAuthDocument(authText: string): Record<string, unknown> {
    try {
      const auth = JSON.parse(authText) as unknown;
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
        throw new Error('not an object');
      }
      return auth as Record<string, unknown>;
    } catch {
      throw new Error('auth.json is not valid JSON; no changes were made.');
    }
  }

  private extractBaseUrl(tomlText: string): string {
    this.validateToml(tomlText);
    const match = this.findBaseUrl(tomlText);
    if (!match) {
      throw new Error('config.toml does not contain [model_providers.OpenAI].base_url.');
    }
    return this.decodeTomlString(match[2]);
  }

  private patchAuth(authText: string, apiKey: string): string {
    const auth = this.parseAuthDocument(authText);
    if (typeof auth.OPENAI_API_KEY === 'string') {
      const patched = authText.replace(
        AUTH_KEY_VALUE,
        (_whole, prefix: string) => `${prefix}${JSON.stringify(apiKey)}`,
      );
      if (patched !== authText) {
        return patched;
      }
      throw new Error('auth.json contains OPENAI_API_KEY in an unsupported JSON format.');
    }
    if (auth.OPENAI_API_KEY !== undefined) {
      throw new Error('auth.json contains a non-string OPENAI_API_KEY.');
    }
    return this.insertApiKey(authText, apiKey, Object.keys(auth).length > 0);
  }

  /** Adds a Key to an official-account document without reformatting its existing fields. */
  private insertApiKey(authText: string, apiKey: string, hasExistingFields: boolean): string {
    const closingBrace = authText.lastIndexOf('}');
    if (closingBrace < 0) {
      throw new Error('auth.json is not a JSON object.');
    }
    const indentation = /\n([\t ]+)"/.exec(authText)?.[1] ?? '  ';
    const before = authText.slice(0, closingBrace);
    const after = authText.slice(closingBrace);
    if (!hasExistingFields) {
      return `${before}\n${indentation}"OPENAI_API_KEY": ${JSON.stringify(apiKey)}\n${after}`;
    }
    const trimmedBefore = before.replace(/[\t \r\n]+$/, '');
    const suffix = before.slice(trimmedBefore.length);
    const separator = trimmedBefore.endsWith(',') ? '' : ',';
    const lineBreak = suffix.includes('\n') ? '\n' : ' ';
    return `${trimmedBefore}${separator}${lineBreak}${indentation}"OPENAI_API_KEY": ${JSON.stringify(apiKey)}${suffix || lineBreak}${after}`;
  }

  private patchToml(tomlText: string, baseUrl: string): string {
    this.validateToml(tomlText);
    const lines = tomlText.split('\n');
    let inProvider = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (PROVIDER_SECTION.test(line)) {
        inProvider = true;
        continue;
      }
      if (inProvider && SECTION.test(line)) {
        inProvider = false;
      }
      if (inProvider && BASE_URL.test(line)) {
        lines[index] = line.replace(
          BASE_URL,
          (_whole, prefix: string, _current: string, suffix: string, carriageReturn: string) =>
            `${prefix}${JSON.stringify(baseUrl)}${suffix}${carriageReturn}`,
        );
        return lines.join('\n');
      }
    }
    throw new Error('config.toml does not contain [model_providers.OpenAI].base_url; no changes were made.');
  }

  private findBaseUrl(tomlText: string): RegExpExecArray | undefined {
    let inProvider = false;
    for (const line of tomlText.split('\n')) {
      if (PROVIDER_SECTION.test(line)) {
        inProvider = true;
        continue;
      }
      if (inProvider && SECTION.test(line)) {
        inProvider = false;
      }
      const match = inProvider ? BASE_URL.exec(line) : undefined;
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  private validateToml(tomlText: string): void {
    try {
      TOML.parse(tomlText);
    } catch {
      throw new Error('config.toml is not valid TOML; no changes were made.');
    }
  }

  private decodeTomlString(value: string): string {
    return value.startsWith('"') ? JSON.parse(value) as string : value.slice(1, -1);
  }

  private async writePair(
    paths: CodexPaths,
    authContent: string,
    tomlContent: string,
    options: { reason: BackupInfo['reason']; profileName?: string; policy?: BackupPolicy },
  ): Promise<BackupInfo> {
    const backup = await this.createBackup(paths, options.reason, options.profileName);
    const [authTemp, tomlTemp] = [this.tempPath(paths.authPath), this.tempPath(paths.configPath)];
    let authReplaced = false;
    let tomlReplaced = false;

    try {
      await Promise.all([
        this.writeTemp(authTemp, authContent, paths.authPath),
        this.writeTemp(tomlTemp, tomlContent, paths.configPath),
      ]);
      await fs.rename(authTemp, paths.authPath);
      authReplaced = true;
      await fs.rename(tomlTemp, paths.configPath);
      tomlReplaced = true;
    } catch (error) {
      const restorations: Promise<void>[] = [];
      if (authReplaced) {
        restorations.push(fs.copyFile(path.join(backup.directory, 'auth.json'), paths.authPath));
      }
      if (tomlReplaced) {
        restorations.push(fs.copyFile(path.join(backup.directory, 'config.toml'), paths.configPath));
      }
      await Promise.allSettled(restorations);
      throw new Error(`Failed to write Codex configuration; restoration was attempted: ${this.errorMessage(error)}`);
    } finally {
      await Promise.allSettled([fs.unlink(authTemp), fs.unlink(tomlTemp)]);
    }

    await this.pruneBackups(paths, options.policy ?? DEFAULT_BACKUP_POLICY);
    return backup;
  }

  private async createBackup(
    paths: CodexPaths,
    reason: BackupInfo['reason'],
    profileName?: string,
  ): Promise<BackupInfo> {
    const createdAt = new Date().toISOString();
    const id = `${createdAt.replaceAll(':', '-').replaceAll('.', '-')}-${crypto.randomUUID().slice(0, 8)}`;
    const directory = path.join(this.backupRoot(paths), id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await Promise.all([
        fs.copyFile(paths.authPath, path.join(directory, 'auth.json')),
        fs.copyFile(paths.configPath, path.join(directory, 'config.toml')),
      ]);
      const manifest: BackupManifest = { version: 1, createdAt, profileName, reason };
      await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
      return { id, directory, createdAt, profileName, reason };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private backupRoot(paths: CodexPaths): string {
    return path.join(paths.codexDirectory, BACKUP_DIRECTORY);
  }

  private assertBackupBelongsTo(paths: CodexPaths, backup: BackupInfo): void {
    const expected = path.join(this.backupRoot(paths), backup.id);
    if (path.resolve(expected) !== path.resolve(backup.directory)) {
      throw new Error('Invalid backup location.');
    }
  }

  private normalizedPolicy(policy: BackupPolicy): BackupPolicy {
    return {
      maxBackups: Math.max(MIN_BACKUPS_TO_KEEP, Math.floor(policy.maxBackups || DEFAULT_BACKUP_POLICY.maxBackups)),
      maxAgeDays: Math.max(0, Math.floor(policy.maxAgeDays ?? DEFAULT_BACKUP_POLICY.maxAgeDays)),
    };
  }

  private isBackupReason(value: unknown): value is BackupInfo['reason'] {
    return value === 'profile-switch' || value === 'before-restore';
  }

  private isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
  }

  private tempPath(targetPath: string): string {
    return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.codex-switch.tmp`);
  }

  private async writeTemp(tempPath: string, content: string, originalPath: string): Promise<void> {
    const original = await fs.stat(originalPath);
    await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: original.mode });
    await fs.chmod(tempPath, original.mode);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
