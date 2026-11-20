# agent_id 注册

每个代理创建一个 `<agent_id>.md` 文件，说明平台、角色、主机和能力。示例：

```markdown
---
agent_id: codex-local-01
platform: codex
role: executor
host: windows-local
---

负责读取任务、修改代码、运行检查并返回结果。
```
