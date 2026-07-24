import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexPaths } from './types';
import { decodeWslOutput, parseWslDistributions, WslDistribution } from './wslUtils';

const execFileAsync = promisify(execFile);

export class WslPathResolver {
  public constructor(private readonly configuration = vscode.workspace.getConfiguration('codexSwitch')) {}

  public async resolve(): Promise<CodexPaths> {
    if (vscode.env.remoteName?.startsWith('wsl')) {
      return this.fromLinuxHome(os.homedir(), '当前 Remote-WSL 用户');
    }
    if (process.platform !== 'win32') {
      throw new Error('此扩展需要在 Remote-WSL 窗口或本机 Windows VS Code 窗口中运行。');
    }

    const configured = this.configuration.get<string>('wslDistribution', '').trim();
    const distribution = configured || (await this.defaultDistribution())?.name;
    if (!distribution) {
      throw new Error('未检测到默认 WSL 发行版。请执行“Codex Switch: Select WSL Distribution”。');
    }
    return this.fromWindowsWsl(distribution);
  }

  public async listDistributions(): Promise<WslDistribution[]> {
    const { stdout } = await execFileAsync('wsl.exe', ['--list', '--verbose'], {
      encoding: 'buffer',
      windowsHide: true,
    });
    return parseWslDistributions(decodeWslOutput(stdout as Buffer));
  }

  public async chooseDistribution(): Promise<string | undefined> {
    if (process.platform !== 'win32' || vscode.env.remoteName?.startsWith('wsl')) {
      vscode.window.showInformationMessage('Remote-WSL 会自动使用当前 Linux 用户，无需选择发行版。');
      return undefined;
    }
    const distributions = await this.listDistributions();
    const selection = await vscode.window.showQuickPick(
      distributions.map((item) => ({
        label: item.name,
        description: item.isDefault ? 'WSL 默认发行版' : undefined,
      })),
      { placeHolder: '选择包含 ~/.codex 的 WSL 发行版' },
    );
    if (!selection) {
      return undefined;
    }
    await this.configuration.update('wslDistribution', selection.label, vscode.ConfigurationTarget.Global);
    return selection.label;
  }

  private async defaultDistribution(): Promise<WslDistribution | undefined> {
    return (await this.listDistributions()).find((distribution) => distribution.isDefault);
  }

  private async fromWindowsWsl(distribution: string): Promise<CodexPaths> {
    const { stdout } = await execFileAsync(
      'wsl.exe',
      ['--distribution', distribution, '--exec', 'sh', '-lc', 'printf %s "$HOME"'],
      { encoding: 'buffer', windowsHide: true },
    );
    const linuxHome = decodeWslOutput(stdout as Buffer).trim();
    if (!linuxHome.startsWith('/')) {
      throw new Error(`无法取得 WSL 发行版“${distribution}”的主目录。`);
    }
    const uncHome = `\\\\wsl.localhost\\${distribution}${linuxHome.replaceAll('/', '\\')}`;
    return this.fromWindowsHome(uncHome, `WSL: ${distribution} (${linuxHome})`);
  }

  private fromLinuxHome(home: string, description: string): CodexPaths {
    const codexDirectory = path.posix.join(home, '.codex');
    return {
      codexDirectory,
      authPath: path.posix.join(codexDirectory, 'auth.json'),
      configPath: path.posix.join(codexDirectory, 'config.toml'),
      description,
    };
  }

  private fromWindowsHome(home: string, description: string): CodexPaths {
    const codexDirectory = path.win32.join(home, '.codex');
    return {
      codexDirectory,
      authPath: path.win32.join(codexDirectory, 'auth.json'),
      configPath: path.win32.join(codexDirectory, 'config.toml'),
      description,
    };
  }
}
