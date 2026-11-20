# GitHub 异步中转模板

这个目录是“多个云端代理 ↔ 本地 Codex”的 GitHub 文件中转模板。

每个参与者使用唯一且稳定的 `agent_id`，只写自己的消息目录和回执目录，所有参与者都可以读取整个仓库。具体规则见 [协议.md](协议.md)。

示例代理：

```text
cloud-chatgpt-01
cloud-claude-01
codex-local-01
```

建议把这个目录复制到单独的 GitHub 私有仓库，避免研究代码和中转消息混在一起。

普通网页 ChatGPT 会话不是常驻进程，不会自动定时检查仓库。网页端需要手动触发，或者另行配置 API/自动化任务；本地 Codex 可以使用 Windows 任务计划程序定时 `git pull`。
