# Codex Switch

[![CI](https://github.com/jcm-15642/Codex_Switch/actions/workflows/ci.yml/badge.svg)](https://github.com/jcm-15642/Codex_Switch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个 VS Code / Remote-WSL 扩展，用于管理多个 Codex API URL 与 API Key 档案，并安全切换当前用户 `~/.codex` 中的配置。

## 功能

- 在侧栏、状态栏或命令面板中快速切换 API Profile。
- API Key 使用 VS Code `SecretStorage` 保存；档案元数据不包含 Key。
- 支持私有 API Profile 与官方账号 Profile；官方账号认证快照同样仅保存在 VS Code `SecretStorage`。
- 同时支持 Remote-WSL 和本机 Windows VS Code；目标目录从当前 WSL 用户的 `$HOME` 动态推导。
- 仅修改 `auth.json` 的 `OPENAI_API_KEY` 与 `config.toml` 的 `[model_providers.OpenAI].base_url`。
- 写入前创建成组快照，可恢复、可删除，并自动保留最近备份。

## 安装

从 [GitHub Releases](https://github.com/jcm-15642/Codex_Switch/releases) 下载最新 `.vsix`，然后在 VS Code 或兼容 IDE 中选择 **Extensions: Install from VSIX**。

连接 Remote-WSL 时，请将扩展安装到远程 Ubuntu 扩展宿主。若在本机 Windows 窗口使用，首次可运行 **Codex Switch: Select WSL Distribution** 选择目标发行版。

## 使用

1. 打开活动栏中的 **Codex Switch**。
2. 首次运行会导入当前 Codex 配置为一个 Profile。
3. 使用 `+` 新建 Profile，或点击已有 Profile 切换。
4. 切换成功后点击 **Reload Window**，让新的 Codex 终端或会话读取配置。

要创建官方账号 Profile：先在 Codex 中完成官方账号登录，再运行 **Codex Switch: Import Current Official Account**。扩展会安全保存当时完整的 `auth.json` 快照；之后可在私有 API 与该官方账号之间来回切换。

常用命令：

- `Codex Switch: Rename Profile`
- `Codex Switch: Edit Profile`
- `Codex Switch: Import Current Official Account`
- `Codex Switch: Manage Backups`
- `Codex Switch: Clean Managed Backups`
- `Codex Switch: Remove Legacy Backup Files`

## 备份与安全

实际配置发生变化时，扩展会在 `~/.codex/codex-switch-backups/<时间戳>/` 创建一个完整备份组：

- `auth.json`
- `config.toml`
- `manifest.json`（时间、来源档案和原因；不包含 API Key）

默认保留最近 10 组，并在成功写入后清理超过 30 天的备份；始终至少保留最近 3 组。可通过以下设置调整：

- `codexSwitch.backupRetentionCount`
- `codexSwitch.backupMaxAgeDays`：设为 `0` 可关闭按时间清理。

`auth.json` 及其备份均可能包含明文 API Key。请不要将 `~/.codex`、备份目录、截图或诊断日志上传到 GitHub、网盘或公开聊天。

切换只读写 `auth.json` 与 `config.toml`；不会删除或重建 `sessions`、日志、记忆或状态数据库。因此私有 API → 私有 API、私有 API → 官方账号、官方账号 → 私有 API 都保留本地对话记录文件。

## 开发

```powershell
npm ci
npm test
npm run package
```

构建产物为 `codex-switch-<version>.vsix`。详细贡献和安全报告方式见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

## 发布 GitHub Release

项目已配置标签发布工作流。完成代码提交并推送后，执行：

```powershell
git push origin main
git tag -a v0.2.2 -m "v0.2.2"
git push origin v0.2.2
```

GitHub Actions 会运行测试、打包 VSIX，并自动创建同名 GitHub Release。

## License

[MIT](LICENSE)
