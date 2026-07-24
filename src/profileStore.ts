import * as vscode from 'vscode';
import { ApiProfile } from './types';

const PROFILES_KEY = 'profiles';
const ACTIVE_PROFILE_KEY = 'activeProfileId';
const SECRET_PREFIX = 'codexSwitch.profileKey.';
const OFFICIAL_AUTH_SECRET_PREFIX = 'codexSwitch.officialAuth.';

export class ProfileStore {
  public constructor(
    private readonly state: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  public list(): ApiProfile[] {
    return this.state.get<ApiProfile[]>(PROFILES_KEY, []);
  }

  public get(id: string): ApiProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  public activeId(): string | undefined {
    return this.state.get<string>(ACTIVE_PROFILE_KEY);
  }

  public async savePrivate(profile: ApiProfile, apiKey: string): Promise<void> {
    await this.saveProfile({ ...profile, kind: 'privateApi' });
    await this.secrets.store(this.privateSecretKey(profile.id), apiKey);
  }

  public async saveOfficial(profile: ApiProfile, authJson: string): Promise<void> {
    await this.saveProfile({ ...profile, kind: 'officialAccount' });
    await this.secrets.store(this.officialSecretKey(profile.id), authJson);
  }

  private async saveProfile(profile: ApiProfile): Promise<void> {
    const profiles = this.list();
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    await this.state.update(PROFILES_KEY, profiles);
  }

  public async getApiKey(id: string): Promise<string | undefined> {
    return this.secrets.get(this.privateSecretKey(id));
  }

  public async getOfficialAuth(id: string): Promise<string | undefined> {
    return this.secrets.get(this.officialSecretKey(id));
  }

  public async setActive(id: string | undefined): Promise<void> {
    await this.state.update(ACTIVE_PROFILE_KEY, id);
  }

  public async delete(id: string): Promise<void> {
    await this.state.update(PROFILES_KEY, this.list().filter((profile) => profile.id !== id));
    await Promise.all([
      this.secrets.delete(this.privateSecretKey(id)),
      this.secrets.delete(this.officialSecretKey(id)),
    ]);
    if (this.activeId() === id) {
      await this.setActive(undefined);
    }
  }

  private privateSecretKey(id: string): string {
    return `${SECRET_PREFIX}${id}`;
  }

  private officialSecretKey(id: string): string {
    return `${OFFICIAL_AUTH_SECRET_PREFIX}${id}`;
  }
}
