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
