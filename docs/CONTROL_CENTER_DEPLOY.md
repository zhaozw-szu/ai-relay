# Control Center v1.0 部署和回滚

本阶段只准备部署差异，不自动部署生产。以下命令在 `relay-worker` 目录执行；命令中的 token、密码只在交互输入或 Cloudflare Secret 中保存，不要写入仓库。

## 1. 创建 D1

```powershell
Set-Location E:\图像篡改检测\github-relay-template\relay-worker
wrangler d1 create ai-relay-control
```

把命令返回的真实 `database_id` 填入 `wrangler.toml` 的注释模板，并启用：

```toml
[[d1_databases]]
binding = "DB"
database_name = "ai-relay-control"
database_id = "<真实 database_id>"
migrations_dir = "migrations"
```

先在本地预览数据库执行迁移：

```powershell
wrangler d1 migrations apply ai-relay-control --local
```

当前分支包含 `0001_control_center.sql`、`0002_task_execution.sql` 和 `0003_result_idempotency.sql` 三个迁移，必须按顺序应用。第二个迁移增加任务执行字段，第三个迁移增加可重试结果的幂等 ID；不要只应用第一版后部署第二阶段 Worker。

确认 SQL 无误并计划上线后，才执行远端迁移：

```powershell
wrangler d1 migrations apply ai-relay-control --remote
```

## 2. 设置 Worker 配置

已有旧协议 Secret 保持不变。管理密码必须与 `RELAY_PASSWORD` 分开，并使用新的随机值：

```powershell
wrangler secret put RELAY_PASSWORD
wrangler secret put GITHUB_TOKEN
wrangler secret put MANAGEMENT_PASSWORD
wrangler secret put AGENT_KEYS
```

`AGENT_KEYS` 可以是 JSON，例如：

```json
{"codex-local-01":"一个单独生成并可轮换的代理密钥"}
```

把以下变量加入 `[vars]`，只允许实际 Pages 来源：

```toml
CORS_ORIGINS = "https://zhaozw-szu.github.io,http://localhost:8788"
```

不要把任何 Secret 放进 `relay/index.html`、OpenAPI 文件、日志、命令历史或 GitHub 仓库。测试环境共享密码也应视为已暴露，生产部署前必须重新生成并轮换。

## 3. 部署前检查

```powershell
wrangler d1 migrations list ai-relay-control --local
node --check src/index.js
```

本阶段代码没有自动执行 `wrangler deploy`。完成人工审查、确认 D1 ID 和凭据后，再由项目负责人执行：

```powershell
wrangler deploy
```

部署后先检查：

```powershell
Invoke-RestMethod https://ai-relay-writer.zhaozw-ai-relay.workers.dev/health
```

管理 API 的最小检查示例（PowerShell 不回显 Secret）：

```powershell
$headers = @{ "X-Relay-Admin" = Read-Host "管理密码" }
Invoke-RestMethod `
  -Uri "https://ai-relay-writer.zhaozw-ai-relay.workers.dev/api/conversations" `
  -Headers $headers
```

## 4. 页面配置

GitHub Pages 发布 `relay/index.html` 后打开：

```text
https://zhaozw-szu.github.io/ai-relay/relay/
```

管理区输入 `MANAGEMENT_PASSWORD`，旧消息区输入 `RELAY_PASSWORD`。页面不把密码写入 `localStorage`，刷新页面后需要重新输入。

## 5. 回滚

回滚前保存 Worker 当前版本和 D1 迁移状态。代码回滚只能回滚 Worker 脚本；不要删除已经应用的 D1 表或迁移记录。若新版本尚未使用新表，可把 Worker 回滚到上一版本：

```powershell
wrangler deployments list
wrangler rollback <需要回滚的版本或部署标识>
```

如果只是页面出现问题，可暂时恢复 `relay/index.html` 的上一提交并等待 Pages 发布，不影响 GitHub 加密消息。若消息写入 GitHub 成功但 `message_index` 失败，保留接口返回的 `message_id`、`path`，人工补录索引后再继续；不能删除原消息或重复发送。

## 6. 当前人工配置清单

- 创建 D1 并填入真实 ID；
- 设置独立的管理密码和代理密钥；
- 把 CORS 白名单限制为实际域名；
- 注册 `cloud-chatgpt-01` 和 `codex-local-01` 代理；
- 在生产部署前撤销历史中曾暴露的 GitHub token，并使用新 token；
- 审查迁移和 Worker diff 后再执行远端迁移和 `wrangler deploy`。
