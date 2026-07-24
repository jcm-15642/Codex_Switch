import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { CodexConfigService, validateBaseUrl } from '../codexConfigService';
import { CodexPaths } from '../types';

async function fixture(): Promise<{ directory: string; paths: CodexPaths }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-switch-'));
  const paths: CodexPaths = {
    codexDirectory: directory,
    authPath: path.join(directory, 'auth.json'),
    configPath: path.join(directory, 'config.toml'),
    description: 'test',
  };
  await fs.writeFile(paths.authPath, '{\n  "OPENAI_API_KEY": "old-key",\n  "extra": true\n}\n');
  await fs.writeFile(
    paths.configPath,
    'model_provider = "OpenAI"\n\n[model_providers.OpenAI]\nname = "OpenAI"\nbase_url = "https://old.example/v1" # keep this\nwire_api = "responses"\n\n[features]\nplugins = false\n',
  );
  return { directory, paths };
}

test('validates HTTP(S) URLs', () => {
  assert.equal(validateBaseUrl('https://example.test/v1'), undefined);
  assert.match(validateBaseUrl('ftp://example.test') ?? '', /http/);
  assert.match(validateBaseUrl('not a url') ?? '', /valid/);
});

test('reads and applies only Codex API fields, preserving TOML content', async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CodexConfigService();
  assert.deepEqual(await service.readCurrent(paths), {
    apiKey: 'old-key',
    baseUrl: 'https://old.example/v1',
  });

  const result = await service.apply(
    paths,
    { apiKey: 'new-key', baseUrl: 'https://new.example/v1' },
    { profileName: 'Test profile' },
  );
  assert.equal(result.changed, true);
  const auth = JSON.parse(await fs.readFile(paths.authPath, 'utf8')) as Record<string, unknown>;
  const config = await fs.readFile(paths.configPath, 'utf8');
  assert.equal(auth.OPENAI_API_KEY, 'new-key');
  assert.equal(auth.extra, true);
  assert.equal(await fs.readFile(paths.authPath, 'utf8'), '{\n  "OPENAI_API_KEY": "new-key",\n  "extra": true\n}\n');
  assert.match(config, /base_url = "https:\/\/new\.example\/v1" # keep this/);
  assert.match(config, /\[features\]\nplugins = false/);
  const backups = await service.listBackups(paths);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].profileName, 'Test profile');
  assert.equal(await fs.readFile(path.join(backups[0].directory, 'auth.json'), 'utf8'), '{\n  "OPENAI_API_KEY": "old-key",\n  "extra": true\n}\n');
});

test('does not create a backup when the target configuration is unchanged', async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CodexConfigService();
  const result = await service.apply(paths, { apiKey: 'old-key', baseUrl: 'https://old.example/v1' });
  assert.equal(result.changed, false);
  assert.equal((await service.listBackups(paths)).length, 0);
});

test('captures private API and official-account auth documents without exposing or discarding fields', async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CodexConfigService();
  assert.deepEqual(await service.captureCurrentProfile(paths), {
    kind: 'privateApi',
    baseUrl: 'https://old.example/v1',
    apiKey: 'old-key',
  });

  const officialAuth = '{\n  "tokens": { "access_token": "official-token" },\n  "account_id": "account-1"\n}\n';
  await fs.writeFile(paths.authPath, officialAuth);
  const captured = await service.captureCurrentProfile(paths);
  assert.deepEqual(captured, {
    kind: 'officialAccount',
    baseUrl: 'https://old.example/v1',
    authJson: officialAuth,
  });
});

test('switches from a private API configuration back to an official-account snapshot', async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CodexConfigService();
  const officialAuth = '{\n  "tokens": { "access_token": "official-token" },\n  "account_id": "account-1"\n}\n';
  await fs.writeFile(paths.authPath, officialAuth);
  const official = await service.captureCurrentProfile(paths);
  assert.equal(official.kind, 'officialAccount');

  await service.apply(paths, { apiKey: 'new-private-key', baseUrl: 'https://private.example/v1' });
  const privateAuth = JSON.parse(await fs.readFile(paths.authPath, 'utf8')) as Record<string, unknown>;
  assert.equal(privateAuth.OPENAI_API_KEY, 'new-private-key');
  assert.deepEqual(privateAuth.tokens, { access_token: 'official-token' });

  assert.ok(official.authJson);
  const restored = await service.applyOfficial(paths, official.baseUrl, official.authJson);
  assert.equal(restored.changed, true);
  assert.equal(await fs.readFile(paths.authPath, 'utf8'), officialAuth);
  assert.equal((await service.captureCurrentProfile(paths)).baseUrl, 'https://old.example/v1');
});

test('retains only the configured number of complete backup groups', async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CodexConfigService();
  for (let index = 1; index <= 4; index += 1) {
    await service.apply(
      paths,
      { apiKey: `key-${index}`, baseUrl: `https://example-${index}.test/v1` },
      { policy: { maxBackups: 3, maxAgeDays: 0 } },
    );
  }
  assert.equal((await service.listBackups(paths)).length, 3);
});

test('restores both configuration files from one backup group', async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CodexConfigService();
  const first = await service.apply(paths, { apiKey: 'first-key', baseUrl: 'https://first.test/v1' });
  await service.apply(paths, { apiKey: 'second-key', baseUrl: 'https://second.test/v1' });
  assert.ok(first.backup);
  const restored = await service.restoreBackup(paths, first.backup, { maxBackups: 10, maxAgeDays: 0 });
  assert.equal(restored.changed, true);
  assert.deepEqual(await service.readCurrent(paths), { apiKey: 'old-key', baseUrl: 'https://old.example/v1' });
});

test('rejects malformed or incompatible configuration without writing', async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CodexConfigService();
  await fs.writeFile(paths.configPath, '[model_providers.OpenAI]\nbase_url = [\n');
  await assert.rejects(service.apply(paths, { apiKey: 'new', baseUrl: 'https://new.example/v1' }), /valid TOML/);
  assert.equal(await fs.readFile(paths.authPath, 'utf8'), '{\n  "OPENAI_API_KEY": "old-key",\n  "extra": true\n}\n');
});
