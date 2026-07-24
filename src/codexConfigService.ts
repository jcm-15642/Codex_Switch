import * as TOML from '@iarna/toml';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CodexConfiguration, CodexPaths } from './types';

const PROVIDER_SECTION = /^\s*\[\s*model_providers\.OpenAI\s*\]\s*(?:#.*)?\r?$/;
const SECTION = /^\s*\[/;
const BASE_URL = /^(\s*base_url\s*=\s*)("(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)(\r?)$/;

export function validateBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : 'URL 必须以 http:// 或 https:// 开头。';
  } catch {
    return '请输入有效的 API URL。';
  }
}

export class CodexConfigService {
  public async readCurrent(paths: CodexPaths): Promise<CodexConfiguration> {
    const [authText, tomlText] = await Promise.all([
      fs.readFile(paths.authPath, 'utf8'),
      fs.readFile(paths.configPath, 'utf8'),
    ]);
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(authText) as Record<string, unknown>;
    } catch {
      throw new Error('auth.json 不是有效的 JSON，未进行任何修改。');
    }
    const apiKey = auth.OPENAI_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('auth.json 中未找到非空的 OPENAI_API_KEY。');
    }
    return { apiKey, baseUrl: this.extractBaseUrl(tomlText) };
  }

  public async apply(paths: CodexPaths, configuration: CodexConfiguration): Promise<void> {
    const urlError = validateBaseUrl(configuration.baseUrl);
    if (urlError) {
      throw new Error(urlError);
    }
    if (!configuration.apiKey.trim()) {
      throw new Error('API Key 不能为空。');
    }

    const [authText, tomlText] = await Promise.all([
      fs.readFile(paths.authPath, 'utf8'),
      fs.readFile(paths.configPath, 'utf8'),
    ]);
    const newAuth = this.patchAuth(authText, configuration.apiKey);
    const newToml = this.patchToml(tomlText, configuration.baseUrl);
    await this.writePair(paths.authPath, newAuth, paths.configPath, newToml);
  }

  private extractBaseUrl(tomlText: string): string {
    this.validateToml(tomlText);
    const match = this.findBaseUrl(tomlText);
    if (!match) {
      throw new Error('config.toml 中未找到 [model_providers.OpenAI].base_url。');
    }
    return this.decodeTomlString(match[2]);
  }

  private patchAuth(authText: string, apiKey: string): string {
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(authText) as Record<string, unknown>;
    } catch {
      throw new Error('auth.json 不是有效的 JSON，未进行任何修改。');
    }
    if (typeof auth.OPENAI_API_KEY !== 'string') {
      throw new Error('auth.json 中未找到 OPENAI_API_KEY，未进行任何修改。');
    }
    auth.OPENAI_API_KEY = apiKey;
    const indentation = /\n([\t ]+)"/.exec(authText)?.[1] ?? '  ';
    return `${JSON.stringify(auth, null, indentation)}\n`;
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
    throw new Error('config.toml 中未找到 [model_providers.OpenAI].base_url，未进行任何修改。');
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
      throw new Error('config.toml 不是有效的 TOML，未进行任何修改。');
    }
  }

  private decodeTomlString(value: string): string {
    if (value.startsWith('"')) {
      return JSON.parse(value) as string;
    }
    return value.slice(1, -1);
  }

  private async writePair(
    firstPath: string,
    firstContent: string,
    secondPath: string,
    secondContent: string,
  ): Promise<void> {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const [firstBackup, secondBackup] = [
      `${firstPath}.codex-switch.${stamp}.bak`,
      `${secondPath}.codex-switch.${stamp}.bak`,
    ];
    const [firstTemp, secondTemp] = [this.tempPath(firstPath), this.tempPath(secondPath)];
    let firstReplaced = false;
    let secondReplaced = false;

    try {
      await Promise.all([fs.copyFile(firstPath, firstBackup), fs.copyFile(secondPath, secondBackup)]);
      await Promise.all([
        this.writeTemp(firstTemp, firstContent, firstPath),
        this.writeTemp(secondTemp, secondContent, secondPath),
      ]);
      await fs.rename(firstTemp, firstPath);
      firstReplaced = true;
      await fs.rename(secondTemp, secondPath);
      secondReplaced = true;
    } catch (error) {
      const restoration: Promise<void>[] = [];
      if (firstReplaced) {
        restoration.push(fs.copyFile(firstBackup, firstPath));
      }
      if (secondReplaced) {
        restoration.push(fs.copyFile(secondBackup, secondPath));
      }
      await Promise.allSettled(restoration);
      throw new Error(`写入 Codex 配置失败，已尝试恢复备份：${this.errorMessage(error)}`);
    } finally {
      await Promise.allSettled([fs.unlink(firstTemp), fs.unlink(secondTemp)]);
    }
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
