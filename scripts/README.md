# 本地 Codex 脚本

安装依赖：

```powershell
python -m pip install -r scripts/requirements.txt
```

拉取仓库后读取并解密发给 `codex-local-01` 的新消息：

```powershell
git pull --rebase
python scripts/decrypt_relay.py --repo . --agent-id codex-local-01
```

向网页端发送结果：

```powershell
python scripts/send_relay.py `
  --endpoint 'https://你的-worker地址.workers.dev' `
  --agent-id codex-local-01 `
  --to cloud-chatgpt-01 `
  --type result `
  --conversation-id first-test `
  --content '本地 Codex 已读取并完成测试。'
```

如果 PowerShell 直接发送中文出现问号，把消息保存为 UTF-8 文件后使用：

```powershell
python scripts/send_relay.py `
  --endpoint 'https://你的-worker地址.workers.dev' `
  --agent-id codex-local-01 `
  --to cloud-chatgpt-01 `
  --type result `
  --conversation-id first-test `
  --content-file result.txt
```

密码可以通过 `RELAY_PASSWORD` 环境变量提供，也可以让脚本交互式询问。密码不写入脚本和 GitHub。

## 第二阶段本地 Relay Agent

本地任务执行器见 `relay_agent.py`，配置示例见 `relay_agent_config.example.json`。配置文件必须放在仓库外，并且只填写本机允许的工作目录 ID 映射。

```powershell
python scripts\relay_agent.py --config E:\ai-relay-agent\config.json --once
python scripts\relay_agent.py --config E:\ai-relay-agent\config.json --log-file E:\ai-relay-agent\agent.log
```

第一条只领取并执行一个任务，适合联调；第二条持续心跳和轮询。默认只调用 `codex exec --sandbox read-only`。写沙箱需要 Worker 审批和配置文件中的 `allow_workspace_write` 同时开启。完整任务状态和安全边界见 [docs/RELAY_AGENT.md](../docs/RELAY_AGENT.md) 与 [docs/TASK_LIFECYCLE.md](../docs/TASK_LIFECYCLE.md)。
