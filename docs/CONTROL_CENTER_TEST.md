# Control Center v1.0 测试记录

本文件只记录软件 API 和协议测试。没有启动训练、验证、测试集评估、消融或性能实验，因此不触发研究实验卡片流程。

## 自动测试

在仓库根目录执行：

```powershell
node --test relay-worker/tests/control-center.test.mjs
node --check relay-worker/src/index.js
python -m unittest discover -s scripts -p "test_*.py"
```

第一条测试使用内存 D1 替身验证 Worker 的请求、认证和状态转换，不连接生产 Cloudflare 或 GitHub。第二条只做 JavaScript 语法检查。Python 测试用于验证本地加密协议工具。

## 手动 API 验收

配置本地 D1 和 `MANAGEMENT_PASSWORD` 后，应按以下顺序验证：

1. 未带 `X-Relay-Admin` 请求 `/api/conversations` 返回 401；未配置管理密码返回 503。
2. 注册 `cloud-chatgpt-01` 和 `codex-local-01`，再创建一个默认 `stopped` 对话。
3. `start → pause → resume → stop` 每一步只允许合法状态转换；重复启动或归档后启动必须失败。
4. `PATCH /api/conversations/:id` 修改名称、目标、时间间隔，再读取确认值来自 D1 而不是浏览器缓存。
5. `GET /events` 能看到创建和状态变化审计记录。
6. 代理没有管理密码时不能访问管理接口；没有正确的 `X-Agent-Key` 时不能发送心跳、领取任务或回执。
7. 旧 `/write` 和 `/read` 使用 `X-Relay-Password` 继续通过；把密码放进请求体必须失败。
8. 旧 AES-GCM 消息和新消息都能由 `scripts/decrypt_relay.py` 解密，中文内容保持 UTF-8。
9. 页面关闭后，D1 中的状态和配置仍然存在；本阶段不声称已有后台自动执行。

## 本阶段未验收

任务自动创建、租约过期恢复、真正的并发原子领取、审批阻断、Codex CLI 执行、Cron 调度、云端模型 API 适配和生产域名 CORS 尚未部署验证。它们属于后续阶段，不能在报告中写成已完成。
