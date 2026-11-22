# 第二阶段任务生命周期

## 创建

管理员在 `POST /api/conversations/:conversation_id/tasks` 创建任务。必须指定参与者中的 `target_agent_id`、指令、工作目录 ID 和幂等键（未提供时由 Worker 生成）。工作目录 ID 只是一项声明；真正的绝对路径只存在本地 Agent 配置中。

只读分析任务使用：

```json
{
  "target_agent_id": "codex-local-01",
  "task_type": "read_only_analysis",
  "sandbox_mode": "read-only",
  "working_directory_id": "relay-template",
  "instruction": "检查项目结构并提出三个优化建议，不修改任何文件。",
  "idempotency_key": "structure-review-001"
}
```

相同 `idempotency_key` 再次提交只返回原任务，不会创建第二条任务。

## 状态

```text
pending → claimed → running → succeeded
    │          │         └────→ failed / timed_out
    │          └──────────────→ timed_out（租约过期后恢复）
    ├── waiting_approval → pending（批准）
    │                    └→ cancelled（拒绝）
    └── cancelled（对话停止）
```

旧的 `tasks.status` 列仍保存 `queued/leased/running/...`，用于兼容第一阶段；第二阶段以新增的 `execution_state` 返回对外状态。

## 领取和租约

`POST /api/agent/claim` 只允许目标 Agent 领取，并且同时满足：

- Agent 密钥正确且已注册；
- 对话状态为 `running`；
- `execution_state` 为 `pending`；
- `available_at` 已到；
- 当前时间在 `active_hours` 内；
- 审批任务已有 `approved` 审批；
- 任务尚未超过尝试次数。

领取使用条件更新：先读取候选任务，再用 `WHERE execution_state = 'pending'` 更新。多个 Agent 同时竞争时只有更新成功的一方得到 `lease_token`；其他请求得到空任务并重新轮询。

获得租约后必须先 `ack` 进入 `running`，长任务通过 `renew` 延长租约，完成时携带同一个 `lease_token` 调用 `result`。租约过期、令牌不匹配、Agent 不匹配或任务已终态时，Worker 拒绝更新，避免旧执行者覆盖新执行者。

## 审批

`read_only_analysis + read-only` 可以直接进入 `pending`。代码修改、命令任务、`workspace-write` 或对话要求审批的任务进入 `waiting_approval`，同时创建绑定 `task_id` 的审批记录。批准会把任务转为 `pending`，拒绝会把任务转为 `cancelled`。

本阶段本地 Agent 还会再次检查：只有配置允许 `workspace-write` 且 Worker 返回 `approval_status=approved` 时，才允许调用写沙箱。否则任务失败并回传原因。

## 对话状态的影响

- `stopped` 或 `paused` 对话不能领取新任务；
- `pause` 不强制终止已经开始的任务；
- `stop` 会取消 `pending` 和 `waiting_approval`，已经 `claimed/running` 的任务按正常完成或租约恢复处理；
- `max_rounds` 限制同一对话尚未取消或超时的任务数量；
- `round_delay_seconds` 会把上一任务完成后的下一任务 `available_at` 推迟；
- `active_hours` 和 `timezone` 在 Worker 领取时再次判断。

云端模型还没有自动生成下一轮任务，因此本阶段只保存并执行这些规则，不能声称已经实现 ChatGPT 自动轮询。
