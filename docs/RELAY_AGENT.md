# 本地 Relay Agent 使用说明

本地 Agent 位于 [scripts/relay_agent.py](../scripts/relay_agent.py)，它持续向 Worker 发送心跳、领取任务、调用受限 Codex CLI，并回传结果。它不读取 GitHub Token，也不接受远程绝对路径。

## 配置

复制 [配置示例](../scripts/relay_agent_config.example.json) 到仓库外，例如 `E:\ai-relay-agent\config.json`，然后修改：

- `worker_url`：Worker 地址；
- `agent_id`：已经注册的固定代理 ID；
- `agent_key`：只给这个代理使用的可轮换密钥；
- `working_directories`：本地目录 ID 到绝对路径的白名单；
- `state_file`、`retry_file`：放在仓库外；
- `allow_workspace_write`：默认 `false`，不要为只读测试打开。

示例：

```json
{
  "worker_url": "https://your-worker.workers.dev",
  "agent_id": "codex-local-01",
  "agent_key": "从 Cloudflare AGENT_KEYS 生成的单独密钥",
  "poll_interval_seconds": 60,
  "heartbeat_interval_seconds": 30,
  "lease_seconds": 900,
  "max_task_seconds": 1800,
  "codex_command": ["codex"],
  "working_directories": {"relay-template": "E:/图像篡改检测/github-relay-template"},
  "state_file": "E:/ai-relay-agent/state.json",
  "retry_file": "E:/ai-relay-agent/outbox.json",
  "allow_workspace_write": false
}
```

## 启动

在 PowerShell 中：

```powershell
python scripts\relay_agent.py --config E:\ai-relay-agent\config.json --once
python scripts\relay_agent.py --config E:\ai-relay-agent\config.json --log-file E:\ai-relay-agent\agent.log
```

`--once` 用于联调，只处理一个任务；不带 `--once` 才会持续轮询。Ctrl+C 会停止轮询并尝试把 Agent 状态写成 `offline`。

## 安全约束

- HTTP 请求使用 `X-Agent-Key`，日志会脱敏密钥；
- Codex 通过 `subprocess.Popen` 参数数组调用，始终 `shell=False`；
- 任务中的文字只作为 Codex 的一个参数，不会拼接成 PowerShell 命令；
- 工作目录只能从 `working_directories` 的 ID 映射得到；
- 默认只允许 `codex exec --sandbox read-only`；
- 写沙箱必须同时满足本地 `allow_workspace_write=true` 和 Worker 审批通过；
- 任务租约会在后台续期，结果提交必须携带正确 `lease_token`；
- 网络失败的结果保存到本地 outbox，重启后重试；
- 配置、状态和 outbox 不应放进公开仓库。

生产前仍需把配置文件放在仓库外、限制文件权限，并轮换曾经暴露过的旧凭据。
