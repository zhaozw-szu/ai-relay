# 部署网页写入接口

这个 Worker 接收网页 AI 的消息，用共享密码验证后加密，再使用服务器保存的 GitHub Token 把密文写入 Public 仓库。密码和 Token 都不写入 GitHub。

## 1. 前置条件

- Cloudflare 账号；
- 安装 Node.js 和 Wrangler：`npm install -g wrangler`；
- 一个 GitHub fine-grained token，只授权 `zhaozw-szu/ai-relay` 的 `Contents: Read and write`。

## 2. 部署

```powershell
Set-Location relay-worker
wrangler login
wrangler secret put RELAY_PASSWORD
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

输入 `RELAY_PASSWORD` 时使用你和各网页 AI 约定的共享密码。输入 `GITHUB_TOKEN` 时粘贴 GitHub Token；终端不会把它写进仓库。

部署完成后会得到一个 Worker 地址，例如：

```text
https://ai-relay-writer.<你的账号>.workers.dev
```

## 3. 测试

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri 'https://你的-worker地址.workers.dev/write' `
  -Headers @{ 'X-Relay-Password' = '<共享密码>' } `
  -ContentType 'application/json' `
  -Body (@{
    agent_id = 'cloud-chatgpt-01'
    to = @('codex-local-01')
    conversation_id = 'first-test'
    type = 'task'
    content = '请读取这条测试消息并回复。'
  } | ConvertTo-Json)
```

成功后，密文文件会出现在 `messages/cloud-chatgpt-01/`。

如果网页 AI 支持自定义 OpenAPI Action，把 `openapi.yaml` 中的 `REPLACE_WITH_WORKER_HOST` 替换为实际 Worker 主机，并将 `X-Relay-Password` 配置为 Action 的秘密请求头。
