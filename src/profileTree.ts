import * as vscode from 'vscode';
import { ProfileStore } from './profileStore';
import { ApiProfile } from './types';

export class ProfileTreeProvider implements vscode.TreeDataProvider<ApiProfile> {
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(private readonly store: ProfileStore) {}

  public refresh(): void {
    this.changed.fire();
  }

  public getTreeItem(profile: ApiProfile): vscode.TreeItem {
    const active = this.store.activeId() === profile.id;
    const kind = profile.kind ?? 'privateApi';
    const item = new vscode.TreeItem(profile.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${active ? '当前 · ' : ''}${kind === 'officialAccount' ? '官方账号 · ' : 'API · '}${profile.baseUrl}`;
    item.tooltip = `${profile.name}\n${kind === 'officialAccount' ? '官方账号认证' : '私有 API 认证'}\n${profile.baseUrl}${active ? '\n当前已应用' : ''}`;
    item.contextValue = 'codexProfile';
    item.iconPath = new vscode.ThemeIcon(active ? 'check' : 'server');
    item.command = {
      command: 'codexSwitch.switchProfile',
      title: 'Switch profile',
      arguments: [profile],
    };
    return item;
  }

  public getChildren(): ApiProfile[] {
    return [...this.store.list()].sort((left, right) => left.name.localeCompare(right.name));
  }
}
