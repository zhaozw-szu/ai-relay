# AI Relay Control Center v1.0 架构

## 目标和范围

这一版把现有的 GitHub 加密消息中转扩展成可持久化的控制中心。GitHub Pages 是管理界面，Cloudflare Worker 是 API 层，Cloudflare D1 保存状态和索引，GitHub 仓库继续保存兼容旧协议的加密消息正文。本提交只完成第一阶段的状态管理和 API，没有部署生产，也没有实现云端模型的自动调用。

## 组件职责

| 组件 | 责任 | 凭据 |
| --- | --- | --- |
| `relay/index.html` | 展示真实后端状态、注册代理、创建/启停/归档对话、兼容旧消息收发 | 只在浏览器内存使用管理密码和共享密码 |
| `relay-worker/src/index.js` | CORS、管理认证、D1 CRUD、状态转换、代理心跳/领取接口、旧加密消息接口 | `MANAGEMENT_PASSWORD`、`AGENT_KEYS`、`RELAY_PASSWORD`、`GITHUB_TOKEN` 为 Worker Secret |
| D1 | 对话、代理、任务、消息索引、审批、心跳、审计事件 | 由 Cloudflare 绑定 `DB` |
| GitHub 仓库 | 保存 AES-GCM 加密的消息文件；文件正文不进入 D1 | Worker Secret 中的 GitHub token |
| 本地 Agent（后续阶段） | 使用独立代理密钥心跳、领取并执行任务 | `X-Agent-Key` |

## 身份边界

管理接口使用 `X-Relay-Admin`，与旧协议的 `X-Relay-Password` 分开。代理接口使用 `X-Agent-Key`，并且密钥按 `agent_id` 映射；没有配置对应密钥时不会把代理标记为在线。旧 `/write` 和 `/read` 保持共享密码兼容，但写入密码只从请求头读取，不接受请求体中的密码。

Worker 可以通过 `CORS_ORIGINS` 限制页面来源。未设置时为兼容已有页面暂用 `*`；生产部署前应改成实际 Pages 来源，例如 `https://zhaozw-szu.github.io`。

## D1 数据模型

`relay-worker/migrations/0001_control_center.sql` 是唯一的第一版迁移文件，包含：

- `agents`、`agent_heartbeats`：注册资料、状态和真实心跳；
- `conversations`、`conversation_agents`：对话配置、参与者、`stopped/running/paused/archived` 状态；
- `tasks`：幂等键、租约、重试次数和任务生命周期，为第二阶段执行器预留；
- `message_index`：GitHub 加密消息的轻量索引，不保存明文；
- `approvals`：任务审批状态；
- `audit_events`：状态变化和管理操作审计。

状态改变先写 D1 再写审计事件。消息发送先写 GitHub，再写 `message_index`；若索引失败，接口明确返回 `index_repair_required`、`message_id` 和 GitHub path，不把失败伪装成成功。

## API 摘要

管理接口都需要 `X-Relay-Admin`：

```text
GET    /api/agents
POST   /api/agents
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:conversation_id
PATCH  /api/conversations/:conversation_id
POST   /api/conversations/:conversation_id/start|pause|resume|stop
GET    /api/conversations/:conversation_id/events
GET    /api/conversations/:conversation_id/messages
POST   /api/conversations/:conversation_id/messages
GET    /api/approvals
POST   /api/approvals/:approval_id/decision
```

代理接口使用 `X-Agent-Key`：

```text
POST /api/agent/heartbeat
POST /api/agent/claim
POST /api/agent/tasks/:task_id/ack
POST /api/agent/tasks/:task_id/result
```

旧接口仍可用：`GET /health`、`POST /write`、`GET /read`。消息记录新增 `reply_to` 和 `task_id` 字段，旧记录没有这两个字段时按 `null` 读取。

## 状态规则

新对话默认是 `stopped`。`start` 只允许从 `stopped` 或 `paused` 进入 `running`；`pause` 只允许从 `running` 进入 `paused`；`resume` 只允许从 `paused` 进入 `running`；`stop` 可以从运行、暂停或已停止进入 `stopped`。归档后的对话不能启动，取消归档后恢复为停止状态。

页面不承担后台调度。轮询间隔、轮次延迟和时间窗口持久化在 D1；本地 Agent 和后续 Worker Cron 才是执行调度者。

## 明确未实现

本阶段还没有把任务自动创建、Codex CLI 执行、审批前置阻断、D1 Cron、云端 ChatGPT/Claude API Adapter 接入生产。页面显示的代理状态只能来自已写入 D1 的注册记录和心跳，不能凭名称推断在线。
