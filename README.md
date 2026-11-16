# 运行诊断录制流的分块常量与事件资料接收

这是面向资料接收人员的 Node.js 服务。提供人工收件、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。自动来源已接入：`POST /api/collect` 从录制网关分块采集 NDJSON 事件，做结构化常量解析与时钟换算后落档，不做性能排名或自动归因。人工入口继续保留，两者来源互不混淆。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示来源采集（完整块、未解析引用、未封口尾块三种情景）与人工收件，结束即清理。

## 容器

`docker build -t recording-pools:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 recording-pools:local` 启动。环境准备后，`docker run --rm --network none recording-pools:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部收件版本，`GET /health` 检查进程。人工记录身份字段为 process, chunk, event。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

### 自动采集与事件查询

`POST /api/collect` 请求体为 `{ "source": "<来源基址>", "probe"?: "<清单路径，默认取 fixtures/project.json>" }`。服务先取录制网关的块清单，再按每条 `href`（相对链接按清单地址解释）拉取 NDJSON 块字节，解析后以 `recording` 来源、`{ processId, chunkId }` 身份进入同一归档，原始字节仍按 sha256 单独入 blobs。响应逐块给出 `accepted/rejected`；任一块被拒时整体返回 207，其他块照常接收，来源不可达返回 502。相同原文重复采集复用版本，事件查询因此不会出现重复条目。

解析规则（`src/recording.mjs`，纯函数并由 `test/recording.test.mjs` 覆盖）：

- 常量编号只在 `processId/chunkId` 作用域内有效，不同进程或不同块的相同编号绝不共用定义；事件先收集、块读完后再统一解析，所以常量定义可以前向引用（出现在事件之后）。
- 引用解析为带 `status` 的节点树：已解析节点带常量值与定义所在行；找不到定义或 kind 不符的节点保留原编号、`status:"unresolved"` 与原因，绝不回填空字符串。stack 沿 frame→method 链解析。
- 时钟换算结果同时保留原始 `ticks`、块的 `startTicks/ticksPerSecond/startTime`、偏移毫秒与墙钟时间，分数毫秒不丢失。
- `sealed=false` 的末块允许最后一行停在未封口的半截记录：该缺口记录为 `tailGap`，块内此前完整的事件全部接收，`complete=false`，不会把尾部缺口表述为“没有事件”。已封口块出现坏行则整块拒绝。
- `complete` 仅在块已封口、无尾部缺口且末个 checkpoint 声明 `complete:true` 时为真；系统只做结构化采集，不产出排名或归因结论。

查询接口：`GET /api/events` 扁平化返回事件（可选过滤 `processId`、`chunkId`、`eventId`、`version`），每条事件带所属回执、块封口/完整状态、尾部缺口、完整引用树和时钟依据；`GET /api/chunks` 返回块级视图，含常量定义（含行号）、checkpoint、时钟基准、原始字节摘要与来源 URL。事件编号只在块内唯一，跨块定位事件时应同时给出 `chunkId`。

`src/` 为收件与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档描述来源协议，不限制收件端架构。
