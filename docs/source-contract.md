# 合作来源约定

## 资料边界

录制网关 /recordings/{id}/chunks 给出 chunkId、processId、byteLength、sealed、ticksPerSecond、startTicks 和 startTime。块为 NDJSON，记录类型 metadata、constant、event、checkpoint；constant 的 id 只在 processId/chunkId 有效，可以 forward-reference。checkpoint 给出前一常量段依赖；stack 常量引用 frame，frame 引用 method。末块 sealed=false 时缺失结尾不算空块。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/recordings/r1/chunks`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 接收端采集语义

自动采集以 `recording` 为来源、`{ processId, chunkId }` 为归档身份，与人工收件的身份空间分开。常量引用在块读全后两阶段解析，支持前向引用；未解析节点保留编号与原因而非空字符串。`sealed=false` 末块的半截尾行记为 `tailGap`，此前完整事件仍接收且 `complete=false`；已封口块的坏行整块拒绝。时钟换算依据随事件保存，查询可回溯到原始块字节、常量定义行和 checkpoint。接收端只做结构化采集，不做性能排名或自动归因。
