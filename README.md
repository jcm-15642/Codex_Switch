# Codex Switch

一个用于 VS Code 的本地扩展，用来管理多个 Codex API URL 与 API Key，并安全切换写入当前 WSL 用户的 `~/.codex` 配置。

## 使用方式

1. 在 VS Code 中安装生成的 `.vsix` 文件。
2. 打开活动栏中的 **Codex Switch**。
3. 首次运行会尝试导入当前 `auth.json` 和 `config.toml`。在 Windows 本机窗口中，如果默认 WSL 发行版不是目标发行版，执行 **Codex Switch: Select WSL Distribution**。
4. 使用 `+` 新建档案，或点击档案/状态栏快速切换。
5. 切换后重启相关 Codex 终端或会话。

API Key 只保存在 VS Code 的安全存储中；扩展仅修改 `OPENAI_API_KEY` 与 `[model_providers.OpenAI].base_url`，每次写入前会在同一目录创建带时间戳的备份。

## 开发

```powershell
npm install
npm test
npm run package
```
