# 第二阶段测试报告

本报告区分模拟测试与真实测试。没有启动训练、验证集、消融或性能实验；这里只做软件联调和只读代码分析。

## 模拟测试

已执行：

```powershell
node --test relay-worker/tests/*.test.mjs
python -m unittest discover -s scripts -p 'test_*.py'
python -m py_compile scripts/relay_agent.py
node --check relay-worker/src/index.js
```

当前覆盖：

- 第一阶段管理认证和状态转换；
- 任务幂等键；
- 两个并发 claim 请求只有一个获得租约；
- 代理心跳认证；
- Agent 参数数组、`shell=False` 和只读 sandbox；
- 工作目录白名单；
- 未开启审批时拒绝 workspace-write；
- UTF-8/AES-GCM 旧消息解密；
- 两个迁移文件可在 SQLite 中顺序执行。

## 真实测试准备

本机已发现 `codex` 命令，`codex exec --help` 确认支持 `--sandbox read-only` 和 `--cd`。真实闭环仍需要本地开发 Worker/D1 或已配置的测试环境；当前生产 Worker 尚未绑定 D1，因此本阶段没有对生产执行真实任务，也没有把任何测试消息写入生产。

本次实际尝试过一次只读 CLI 调用。Codex 进程成功启动并进入 `read-only` 模式，但在第一次读取项目文件前，Windows Codex 运行时返回 `Failed to create unified exec process: registered Core process has no package identity`。因此这次记录为“CLI 启动成功、只读任务未完成”，没有把它计为真实端到端成功，也没有发现文件被修改。

真实只读测试命令应使用仓库外配置，并由负责人在本地测试环境运行：

```powershell
python scripts\relay_agent.py --config E:\ai-relay-agent\config.json --once
```

任务指令建议为：

```text
检查当前项目的文件结构，解释主要模块，并给出三个优化建议，不修改任何文件。
```

完成真实测试后，应在本文件追加实际时间、Worker/D1 环境、任务 ID、Codex 退出码、结果摘要和是否成功。当前报告不把模拟结果写成真实闭环结果。

## 尚未验证

租约过期恢复、断网重试后的真实回执、页面关闭后后台运行、真实审批写操作、生产 D1 并发行为和云端模型自动下一轮均未验证，属于后续联调或第三阶段。
