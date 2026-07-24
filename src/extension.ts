import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { CodexConfigService, validateBaseUrl } from './codexConfigService';
import { ProfileStore } from './profileStore';
import { ProfileTreeProvider } from './profileTree';
import { ApiProfile, CodexPaths } from './types';
import { WslPathResolver } from './wslPathResolver';

const INITIAL_IMPORT_KEY = 'initialImportCompleted';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ProfileStore(context.globalState, context.secrets);
  const resolver = new WslPathResolver();
  const configService = new CodexConfigService();
  const profiles = new ProfileTreeProvider(store);
  const treeView = vscode.window.createTreeView('codexSwitch.profiles', { treeDataProvider: profiles });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'codexSwitch.switchProfile';
  status.show();

  const refreshUi = (): void => {
    const active = store.activeId() ? store.get(store.activeId() as string) : undefined;
    status.text = active ? `$(plug) Codex: ${active.name}` : '$(plug) Codex: 未选择';
    status.tooltip = active ? `当前 API 配置：${active.baseUrl}` : '选择 Codex API 配置档案';
    treeView.message = store.list().length ? undefined : '尚无档案。使用 + 新增，或导入当前 Codex 配置。';
    profiles.refresh();
  };

  const resolvePaths = async (): Promise<CodexPaths> => {
    try {
      return await resolver.resolve();
    } catch (error) {
      const action = await vscode.window.showErrorMessage(errorMessage(error), '选择 WSL 发行版');
      if (action === '选择 WSL 发行版') {
        const distribution = await resolver.chooseDistribution();
        if (distribution) {
          return resolver.resolve();
        }
      }
      throw error;
    }
  };

  const importCurrent = async (silent = false): Promise<boolean> => {
    try {
      const current = await configService.readCurrent(await resolvePaths());
      const profile = uniqueProfile(store, '当前配置', current.baseUrl);
      await store.save(profile, current.apiKey);
      await store.setActive(profile.id);
      await context.globalState.update(INITIAL_IMPORT_KEY, true);
      refreshUi();
      if (!silent) {
        vscode.window.showInformationMessage(`已导入当前 Codex 配置为“${profile.name}”。`);
      }
      return true;
    } catch (error) {
      if (!silent) {
        vscode.window.showErrorMessage(`导入失败：${errorMessage(error)}`);
      } else {
        const action = await vscode.window.showWarningMessage(
          `未能自动导入当前 Codex 配置：${errorMessage(error)}`,
          '选择 WSL 发行版',
        );
        if (action === '选择 WSL 发行版' && await resolver.chooseDistribution()) {
          await importCurrent(false);
        }
      }
      return false;
    }
  };

  const switchProfile = async (candidate?: ApiProfile): Promise<void> => {
    const profile = candidate ?? (await pickProfile(store));
    if (!profile) {
      return;
    }
    const apiKey = await store.getApiKey(profile.id);
    if (!apiKey) {
      vscode.window.showErrorMessage(`档案“${profile.name}”缺少安全保存的 API Key。请编辑后再切换。`);
      return;
    }
    try {
      await configService.apply(await resolvePaths(), { baseUrl: profile.baseUrl, apiKey });
      await store.setActive(profile.id);
      refreshUi();
      const action = await vscode.window.showInformationMessage(
        `已切换到“${profile.name}”。重载窗口后，相关 Codex 终端或会话将读取新配置。`,
        'Reload Window',
      );
      if (action === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } catch (error) {
      vscode.window.showErrorMessage(`切换失败：${errorMessage(error)}`);
    }
  };

  const addProfile = async (): Promise<void> => {
    const name = await promptName(store);
    if (!name) {
      return;
    }
    const baseUrl = await promptUrl();
    if (!baseUrl) {
      return;
    }
    const apiKey = await promptApiKey(false);
    if (!apiKey) {
      return;
    }
    await store.save({ id: randomUUID(), name, baseUrl }, apiKey);
    refreshUi();
  };

  const editProfile = async (candidate?: ApiProfile): Promise<void> => {
    const current = candidate ?? (await pickProfile(store));
    if (!current) {
      return;
    }
    const name = await promptName(store, current.name, current.id);
    if (!name) {
      return;
    }
    const baseUrl = await promptUrl(current.baseUrl);
    if (!baseUrl) {
      return;
    }
    const apiKey = await promptApiKey(true);
    if (apiKey === undefined) {
      return;
    }
    const existingKey = await store.getApiKey(current.id);
    if (!apiKey && !existingKey) {
      vscode.window.showErrorMessage('此档案没有可保留的 API Key，请输入新的 API Key。');
      return;
    }
    await store.save({ ...current, name, baseUrl }, apiKey || existingKey as string);
    refreshUi();
  };

  const renameProfile = async (candidate?: ApiProfile): Promise<void> => {
    const current = candidate ?? (await pickProfile(store));
    if (!current) {
      return;
    }
    const name = await promptName(store, current.name, current.id);
    if (!name || name === current.name) {
      return;
    }
    const apiKey = await store.getApiKey(current.id);
    if (!apiKey) {
      vscode.window.showErrorMessage(`档案“${current.name}”缺少安全保存的 API Key。请先编辑该档案。`);
      return;
    }
    await store.save({ ...current, name }, apiKey);
    refreshUi();
  };

  const deleteProfile = async (candidate?: ApiProfile): Promise<void> => {
    const profile = candidate ?? (await pickProfile(store));
    if (!profile) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `删除档案“${profile.name}”？其安全存储的 API Key 也会删除；已写入 Codex 的配置不会改变。`,
      { modal: true },
      '删除',
    );
    if (confirmation === '删除') {
      await store.delete(profile.id);
      refreshUi();
    }
  };

  context.subscriptions.push(
    treeView,
    status,
    vscode.commands.registerCommand('codexSwitch.switchProfile', switchProfile),
    vscode.commands.registerCommand('codexSwitch.addProfile', addProfile),
    vscode.commands.registerCommand('codexSwitch.renameProfile', renameProfile),
    vscode.commands.registerCommand('codexSwitch.editProfile', editProfile),
    vscode.commands.registerCommand('codexSwitch.deleteProfile', deleteProfile),
    vscode.commands.registerCommand('codexSwitch.refreshProfiles', refreshUi),
    vscode.commands.registerCommand('codexSwitch.importCurrentConfig', () => importCurrent(false)),
    vscode.commands.registerCommand('codexSwitch.selectWslDistribution', async () => {
      const distribution = await resolver.chooseDistribution();
      if (distribution && !context.globalState.get<boolean>(INITIAL_IMPORT_KEY)) {
        await importCurrent(false);
      }
    }),
  );

  refreshUi();
  if (!context.globalState.get<boolean>(INITIAL_IMPORT_KEY) && store.list().length === 0) {
    await importCurrent(true);
  }
}

export function deactivate(): void {}

async function pickProfile(store: ProfileStore): Promise<ApiProfile | undefined> {
  const selected = await vscode.window.showQuickPick(
    store.list().map((profile) => ({
      label: profile.name,
      description: profile.baseUrl,
      profile,
    })),
    { placeHolder: '选择要应用的 Codex API 配置档案' },
  );
  return selected?.profile;
}

async function promptName(store: ProfileStore, currentValue = '', currentId?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Codex API 档案名称',
    value: currentValue,
    prompt: '例如：公司代理、个人 API',
    validateInput: (value) => {
      const name = value.trim();
      if (!name) {
        return '名称不能为空。';
      }
      if (store.list().some((profile) => profile.id !== currentId && profile.name === name)) {
        return '档案名称已存在。';
      }
      return undefined;
    },
  }).then((value) => value?.trim());
}

async function promptUrl(currentValue = ''): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Codex API Base URL',
    value: currentValue,
    prompt: '例如：https://api.openai.com/v1',
    validateInput: validateBaseUrl,
  }).then((value) => value?.trim());
}

async function promptApiKey(allowBlank: boolean): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Codex API Key',
    password: true,
    prompt: allowBlank ? '留空以保留当前安全存储的 Key' : '输入 API Key（将保存到 VS Code 安全存储）',
    validateInput: (value) => !allowBlank && !value.trim() ? 'API Key 不能为空。' : undefined,
  }).then((value) => value === undefined ? undefined : value.trim());
}

function uniqueProfile(store: ProfileStore, name: string, baseUrl: string): ApiProfile {
  const names = new Set(store.list().map((profile) => profile.name));
  let candidate = name;
  let index = 2;
  while (names.has(candidate)) {
    candidate = `${name} ${index}`;
    index += 1;
  }
  return { id: randomUUID(), name: candidate, baseUrl };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
