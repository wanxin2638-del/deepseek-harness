# 桌面集成能力 · 真机验证记录（P2.5）

> 工作验证文档，不属于 `docs/` 发布树。对应 [桌面集成计划](../desktop-integration.md) P2.5。
> 约定：无 `DEEPSEEK_API_KEY` 的机器只能验证原语与装配面；模型驱动项按"未验证+原因+操作步骤"记录。

## 0. 验证环境

- 机器：Windows（dev shell 以 `.runtime` 装配态后端运行，Chrome DevTools 端口 9223）。
- 版本：`apps/desktop`（P2.1 桥）+ `@deepseek-ai/dsh-client-desktop-integration`（P2.2 行）+ web-app bundle patch（P2.3）。
- 本机无模型 key：模型驱动项（C1/C2/C3/C4 的真实触发）需要用户配置 key 后按步骤复验。

## 1. C1 任务完成提醒

- 步骤（需要 key）：窗口最小化 → 在新会话提交一个短任务 → 等待"完成"标记出现 → 预期：toast（文案 locale）+ 4s 任务栏闪烁；回到窗口不打扰。
- 无 key 证据：完成边沿 → 桥调用的映射由 P2.2 行为测试覆盖（`completed` 边沿通知 + duration 闪烁）；桥的 notify/flash 真机行为在 §5 原语验证中通过。
- 状态：**未完整验证（缺 key）**；映射与桥已分别验证。

## 2. C2 审批挂起闪烁

- 步骤（需要 key）：触发一个需要审批的工具调用 → 切走窗口 → 预期：任务栏持续闪烁直到回窗口处理；处理（允许/拒绝）后停止。
- 无 key 证据：pending → until-focus flash、消失 → flashClear，由 P2.2 行为测试覆盖；真实 pending 交互需真实审批请求。
- 状态：**待 key 复验**。

## 3. C3 失败提醒

- 步骤（需要 key）：提交一个必然失败的任务（例如调用不存在的工具名）→ 预期：critical toast + 8s 闪烁；重试选择不打扰。
- 无 key 证据：`api-session/error` → notify(urgency critical) + flash，由 P2.2 行为测试覆盖。
- 状态：**待 key 复验**。

## 4. C4 后台任务完成

- 步骤（需要 key）：发送一个 `run_in_background` 的长任务 → 预期：job 转 completed 时 toast + 闪烁。
- 无 key 证据：`jobsBySession` 状态转移 → notify，由 P2.2 行为测试覆盖（completed/failed/killed 各一）。
- 状态：**待 key 复验**。

## 5. 桥原语真机验证（P2.1 复用）

- 命令：`pnpm --filter @deepseek-ai/dsh-desktop start -- --remote-debugging-port=9223` 后 `node apps/desktop/scripts/probe-bridge.mjs --port 9223`。
- 结果（2026-09-07 实测）：

```
[ok] bridge present: {"present":true,"methods":["flash","flashClear","notify","onWindowState","windowState"]}
[ok] windowState: "visible-unfocused"
[ok] notify: true
[ok] flash duration: "ok"
[ok] flashClear: "ok"
```

- 含义：`window.desktopBridge` 五方法齐备；`notify` 走真实 `Notification`（返回 true = toast 已派发）；`flash`/`flashClear` 调用 `win.flashFrame`；窗口状态推送就绪。
- 非法 payload / 非 loopback sender 拒绝由桥单元测试（`apps/desktop/tests/bridge-ipc.main.spec.ts`）覆盖。

## 6. 免打扰时段

- 无 key 证据：`quietHours` 命中当前小时时 notify/flash 全跳过（P2.2 行为测试）；C2 审批闪烁同样被抑制。
- 状态：已验证（行为面）。

## 7. 无桥环境（普通浏览器）

- 预期：同一 web profile 在普通浏览器行为与官方 web 完全一致（插件 no-op，D6）。
- 证据：插件在 `window.desktopBridge` 缺失时初始化前短路（P2.2 `no bridge` 测试）；web profile 装配含该行但浏览器侧无副作用。
- 状态：已验证（行为面）。

## 8. 文案

- 预期：中英切换后通知标题/正文正确。
- 证据：P2.2 copy 测试断言 zh/en 输出与键集合一致；`verify-client-ui-i18n` 通过。
- 状态：已验证（行为面）。

## 9. 装配集成（P2.3）

- `.runtime/node_modules/@deepseek-ai/dsh-client-desktop-integration/lib/client.js` 存在于装配闭包（P2.3 实测待补）。
- 壳启动日志无行导入错误；页面正常 boot（P2.3 实测待补）。