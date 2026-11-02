# TopenSync 技术架构

> 面向维护者。讲清楚「代码是怎么组织的、每个模块负责什么、为什么这么分」。

---

## 一、进程结构

```
┌─────────────────────────────────────────────────────────┐
│ 主进程（Node）                                            │
│  index.ts    单实例锁、窗口、引擎装配                       │
│  engine.ts   整机：把四个模块接起来，对外暴露能力            │
│  ipc.ts      IPC 通道注册（只转发，不含业务逻辑）            │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Watcher  │  │Reconciler│  │ Planner  │  │ Transfer │ │
│  │ 本地监控  │  │ 远端对账  │  │ 决策中枢  │  │ 传输执行  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │             │            │             │        │
│       └─────────────┴────────────┴─────────────┘        │
│                          ↕                                │
│                  Manifest (SQLite)                        │
│                   OpenListClient                          │
└────────────────────────┬────────────────────────────────┘
                         │ contextBridge
                    ┌────┴─────┐
                    │ preload  │  最小 API 面
                    └────┬─────┘
                         │
                    ┌────┴─────┐
                    │ renderer │  React + Zustand
                    └──────────┘
```

**preload 只暴露必要的方法**，不把 Node 能力直接抛给渲染进程。所有跨进程数据都走 `src/shared/types.ts` 里的类型契约。

---

## 二、模块分工

| 模块 | 职责 | **不做什么** |
|---|---|---|
| **Watcher** | 监听本地目录，产出归一化事件（add/change/unlink） | 不做上传决策，不碰远端 |
| **Reconciler** | 列举远端文件树 → 比对 → 产出差异 | 不回传内容到本地 |
| **Planner** | 两条通道的**汇合点**：去重决策 → 上传队列 → 删除队列 | 不直接发 HTTP |
| **Transfer** | 执行上传：双哈希头、单次 PUT / 分片 | 不做去重判断 |

这个分界是硬约束：**只有 Planner 能决定「传不传」，只有 Transfer 能发上行请求**。跨过这条线就会出现「某个模块偷偷决定跳过」的情况，而跳过原因正是用户最需要看到的解释。

---

## 三、目录结构

```
src/
├── main/                     主进程
│   ├── index.ts              入口：单实例锁、窗口、引擎装配
│   ├── engine.ts             引擎：装配整机，对外暴露能力
│   ├── ipc.ts                IPC 通道注册（只转发）
│   ├── config/store.ts       配置持久化（safeStorage 加密凭据）
│   ├── db/manifest.ts        SQLite 清单（node:sqlite）
│   ├── hash/hashes.ts        双哈希计算（MD5 + SHA1 一次读出）
│   ├── openlist/client.ts    OpenList REST 客户端
│   ├── planner/
│   │   ├── planner.ts        决策中枢：L1/L1.5/L2 + 队列 + 删除
│   │   └── rename.ts         重命名识别（inode + 时间窗口）
│   ├── reconcile/reconciler.ts  远端对账器
│   ├── transfer/transfer.ts  传输执行器（单次 PUT / 分片）
│   ├── verify/verifier.ts    深度校验（下载远端重算哈希）
│   ├── diagnostics/          诊断包导出（bundle / zip）
│   └── watcher/
│       ├── watcher.ts        chokidar 封装 + Windows 边界处理
│       └── paths.ts          路径工具（三类路径的严格区分）
├── preload/index.ts          预加载（最小 API 面）
├── renderer/src/             渲染进程
│   ├── pages/                8 个页面
│   ├── components/           TopBar / Rail / BatchBar / Icon
│   ├── store.ts              Zustand 全局状态
│   └── styles/               tokens.css（设计变量）+ app.css
└── shared/types.ts           主/预/渲染共享的类型定义

scripts/                      实机验证脚本（见下文）
tests/                        单元测试
docs/                         本目录
```

---

## 四、三类路径必须严格区分

这是本项目最容易出错的地方。

| 类型 | 形态 | 用在哪 |
|---|---|---|
| **本地绝对路径** | `C:\Users\me\Docs\a.txt` | 只在主进程内 |
| **本地相对路径** | `docs/a.txt`（POSIX 分隔） | 清单库主键，也是远端路径的骨架 |
| **远端路径** | `/quark-backup/docs/a.txt` | 发给 OpenList 的路径，始终 `/` 分隔 |

**混用会导致清单主键、远端路径、排除规则同时跑偏**，而且症状是「文件莫名不传」，很难定位。

`src/main/watcher/paths.ts` 是唯一处理路径转换的地方。

### Windows 长路径

同步根路径 ≥ 240 字符时需要加 `\\?\` 前缀绕开 MAX_PATH。但**加了前缀的路径和没加的路径在 Node 的 path API 眼里是两个不同的根**：

```
relative('C:\\Sync', '\\\\?\\C:\\Sync\\a.txt')  →  '\\\\?\\C:\\Sync\\a.txt'   ← 不是 'a.txt'
```

chokidar 监听的是带前缀的路径，它回报的事件路径也带前缀；而同步根是用户配的裸路径。两边一混，相对路径就算不出来，文件会被当成「不在根内」而静默丢弃。

`stripLongPath()` 负责在比较前统一剥掉前缀。

### 路径穿越防护

`absolutize()` 拒绝任何含 `..` 分段的相对路径。

调用方有 IPC 边界——渲染进程把「要删的本地文件列表」直接传进来。删除操作是 `rm(abs, { force: true })`，**没有二次确认的机会**，所以必须在拼接阶段就挡掉越界。

判断「是否越界」用 `rel === '..' || rel.startsWith('..' + sep)`，**不能用 `startsWith('..')`**——Windows 允许 `..foo.txt` 这种合法文件名。

---

## 五、SQLite 清单

`node:sqlite`（Node 22+ 内置，**无 native 编译**）。

### 表结构

| 表 | 用途 |
|---|---|
| `files` | 同步结论：路径、大小、mtime、哈希、远端归属、状态、可信度 |
| `diffs` | 对账差异：类型、本地路径、远端路径、处置状态 |
| `remote_snapshot` | 上轮对账看到的远端文件，用于发现「远端被外部删除」 |
| `scans` | 扫描批次记录 |
| `sync_log` | 运行日志（带类别与文件路径） |

### 两条不变量

1. **清单表是全局的，不按 syncRoot 隔离。** 换过同步目录后旧记录还留在表里。`recoverPending()` 恢复前必须确认本地文件**确实存在**，否则旧记录会被当成新文件重传，远端凭空多出目录。

2. **加索引必须在补列之后。** `CREATE TABLE IF NOT EXISTS` 只在表不存在时生效，老库不会因为 SCHEMA 变了就长出新列。建表语句里如果带 `CREATE INDEX ... ON sync_log(category)`，而老库没有 `category` 列 → 报 `no such column: category`，**连迁移的机会都没有**。

### 关闭守卫

数据库句柄被包了一层 Proxy：连接关闭后 `prepare()` 返回空操作语句（`run` 不写、`get` 返回 undefined、`all` 返回空数组）。

**为什么需要**：引擎退出时先停 Planner（不等在途任务）再关数据库。在途上传任务恢复后还会调 `setState()`，对已关闭的连接会抛 `database is not open`；而这个异常经 planner 的 `catch(handleFatal)` 又调一次 `setState`，再次抛出 → 无人接手的 Promise 拒绝 → **主进程被终止**。

用 Proxy 而不是逐个方法加判断：写操作点有 40+ 个，逐个加守卫一定会漏。

### scans 表：扫描结果的持久化

`scans` 表一直都在，但此前**只有远端对账往里写**，本地扫描的结果只存在 engine 的内存字段里——程序一关就没了，用户重开看到「已扫描 0 个文件」，以为没扫过。

现在：

- 本地扫描首次就绪时 `startScan('local')` 开一行，之后用 `updateLastScanCounts()` 更新同一行（本地扫描是**持续**的，不能每个事件插一行）
- 远端对账每轮 `startScan('remote')` → `finishScan()`
- 引擎启动时 `restoreScanHistory()` 回读最近一轮，概览页显示真实数字

**口径必须一致**：`scans.scanned_count` 存的是**文件数**（不是目录数）。引擎运行时展示的是 `scannedFiles`，两处口径不一致的话，重启后回读的数字会和运行中显示的对不上——同一轮对账，两个数。

---

## 五之二、两条通道的进度必须分开

`ScanProgress` 以前只有**一个**实例，两条通道共用：

- 对账一开始就把本地扫描的进度覆盖掉，本地扫描的状态永远回不来
- 一条通道推终态会误伤另一条
- 对账的**成功路径压根没推终态**（只有 catch 分支推了），于是对账早就结束了，顶栏进度条还挂着、按钮永远显示「对账中…」

现在 `AppStats.progress` 是 `ScanProgressPair`：

```typescript
interface ScanProgressPair {
  local: ScanProgress | null
  remote: ScanProgress | null
}
```

主进程按 `kind` 分流存，渲染层按 `kind` 分流渲染成**两条独立的进度条**。

**教训**：共用一个「当前进度」对象，天然就会互相覆盖。两条独立的通道就该有两个独立的槽位。

---

## 五之三、启动默认不开始同步

`engine.start()` 只做两件事：连接自检、回读历史扫描结果。**不建 watcher、不建 reconciler、不建 planner**。

用户点顶栏「开始同步」才调 `engine.startSync()`，把三者一次性拉起来。

三处需要区分：

| 状态 | `started` | `paused` | 顶栏按钮 |
|---|---|---|---|
| 刚启动 | false | false | 开始同步 |
| 运行中 | true | false | 暂停同步 |
| 中途暂停 | true | true | 继续同步 |

**「对账器创建」与「对账器排期」必须分开**：`updateConfig()` 改完地址后要**立刻**建对账器（否则用户点「立即对账」会静默失败——这是修过的 P0），但**排期**（定时器 + 启动即对账）只在 `started` 为真时才开。否则用户还没点「开始同步」，远端对账自己就跑起来了。

---

## 五之四、大数据量：分页 + 虚拟滚动

六万个本地文件、几千个远端文件时，界面会卡死。两层解决：

**数据层**：`manifest.listFiles({ limit, offset })` 分页查询，渲染进程每次只取 5000 条（`FILE_PAGE_SIZE`），「加载更多」按钮追加。一次性把六万条塞进 IPC 返回值，JSON 序列化要一两秒，渲染进程主线程直接卡住。

**渲染层**：`components/VirtualTable.tsx` 只渲染可视区 + 缓冲区的行，上方/下方各放一个撑高度的占位行，DOM 节点数恒定在几十个。

虚拟滚动的前提是**行高固定**：

- CSS 里 `.vtable-tbl tbody tr { height: 40px }` 强制等高
- 组件里的 `ROW_HEIGHT` 必须与 CSS **严格一致**，否则滚动会跳行
- 单元格内容不能撑高行：原来「哈希」列是两行（md5 + sha1），改成单行 + `title` 提示完整值

---

## 六、配置

- 存在 `userData/config.json`
- 凭据用 Electron `safeStorage` 加密，不落明文
- `normalizeConfig()` 做两件事：**trim 路径两端** + 填默认值

**路径必须 trim 两端。** 尾随空格在界面上**完全不可见**，却会改变远端的实际目标位置——实测把远端根配成 `.../公司 `（尾部空格），整批照片被传进新建的「公司␣」目录。

**改远端根必须改写清单里的 `remote_path`。** 改根后还留着旧前缀，下一轮对账拿着旧前缀去找 → 全判「远端缺失」→ 整批重传。

改根**不是数据迁移**：旧根里的文件留在原地（程序不搬不删），清单改写后既不重传，也不会传到两处。

### 配置是快照还是函数

`Planner` / `Transfer` / `Reconciler` 都用 `getConfig: () => AppConfig` 而不是 `config: AppConfig`。

原因：`normalizeConfig()` 每次都返回**新对象**。如果持有构造那一刻的引用，用户在 UI 里改了「单文件上限」「回收站目录」「校验模式」，Planner 用新值、Transfer 用旧值——两边对「这个文件能不能传」给出相反的判断。

---

## 七、IPC 契约

`src/main/ipc.ts` 注册 23 个 invoke 通道 + 3 个 on 通道；`src/shared/types.ts` 的 `MainToRendererEvents` 声明 7 个推送通道。

**约定**：

- **查询类**用 `handle`（返回数据）
- **动作类**用 `on`（单向触发，不需要回执）
- **需要等结果的动作用 `handle`**——例如 `diff:resolve`：以前用 `send` + `setTimeout(400)` 猜时间，而「移入回收站」要走网络请求，400ms 常常不够，差异行就永远留在表里，用户以为操作没生效、反复点

### 同步状态的三态

| 通道 | 用途 | 何时可调 |
|---|---|---|
| `sync:start` | 开始同步（建 watcher / reconciler / planner） | 任意时候 |
| `sync:pause` | 暂停（停三者，保留清单与配置） | 已开始时 |
| `sync:resume` | 继续（重建三者并恢复未完成任务） | 已暂停时 |

启动后默认未开始——`sync:start` 是唯一能把同步拉起来的入口。

### 渲染进程的事件订阅

`store.ts` 的 `init()` 注册 7 个订阅 + 1 个轮询定时器。

React 19 的 `<StrictMode>` 在开发模式下**必双调用 effect**——两次 `init()` 会让每个 IPC 通道有两个监听器（每条日志追加两次）、两个定时器（轮询翻倍）。所以 `init()` 必须返回清理函数，且有模块级 `initialized` 标志防重复初始化。

---

## 八、错误处理原则

### 主进程

**未处理的 Promise 拒绝会终止 Node 进程。** 所有 `void someAsyncCall()` 都必须挂 `.catch()`：

```ts
void this.planner?.handleEvent(...).catch((err) => {
  this.pushLog('error', `处理本地变更失败 ${e.relPath}：${err}`)
})
```

### 渲染进程

所有 IPC 调用都要有错误处理，否则主进程抛错 → `invoke` 的 Promise reject → 无人 catch → **界面完全静默**，用户看到的是「点了没反应」。

`store.ts` 用统一的 `safe()` 包装，捕获后写入 `lastError`，顶栏显示红色提示条。

### 日志去重

带类别的日志点用 `onLogDetail`（带 meta），**不要再调 `onLog`**——两者都会写日志，会重复出一条。

---

## 九、构建与打包

```bash
npm run build      # tsc --noEmit × 2 + electron-vite build
npm run package    # build + electron-builder → release/
```

### 关键约束

1. **仓库根目录的 `package.json` 不能有 `"type": "module"`**。electron-vite 会输出 ESM `.mjs`，与 `preload: join(__dirname, '../preload/index.js')` 路径对不上，且本环境 ESM 下 `import { app } from 'electron'` 会崩。主进程/预加载一律 CJS 产物。

2. **启动 Electron 必须用 `env -u ELECTRON_RUN_AS_NODE`**。WorkBuddy 沙箱设置了 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以纯 Node 模式运行：`require('electron')` 返回 npm 包路径字符串而非内建模块，`app` 为 undefined、渲染进程起不来。

3. **上传是 `PUT /api/fs/put`，不是 POST。**

4. **列举目录 `per_page` 必须足够大**（用 99999）。`per_page: 0` 返回**空数组**。

5. **夸克秒传需 MD5 + SHA1 双哈希同时提供**，缺任一个服务端会整文件缓存（失秒传 + OOM 风险）。

6. **`As-Task: true` 会强制整文件落盘**，本项目不用。

---

## 十、实机验证脚本

`scripts/` 下都是**跑真实应用**的验证脚本，不是单元测试。

| 脚本 | 用途 |
|---|---|
| `run-app.cjs` | **真人试运行**：正式 profile、连真实 OpenList、真传文件、窗口常驻 |
| `smoke.cjs` | 跑通「扫描 → 清单 → 队列 → 上传尝试」全链路 |
| `shot.cjs` | 逐页截图，核对界面实际渲染 |
| `shot-real-manifest.cjs` | 用**正式 profile**（真实配置与清单）只读截图清单页与对账页 |
| `ui-verify.cjs` | 量 DOM 断言界面 |
| `ui-verify-adopt.cjs` | 量 DOM 断言认领相关 UI |
| `ui-verify-ux.cjs` | 量 DOM 断言清单措辞、可信度筛选、清除筛选、扫描反馈与进度条、日志类别与文件列 |
| `live-verify.cjs` | 连**真实**内网 OpenList，跑完整同步 + 删除链路 |
| `feature-verify.cjs` | 验证传输类别 / 对账列举差异 / 扫描本地按钮 + **日志类别断言** |
| `queue-verify.cjs` | 在真实应用里**点 DOM 按钮**验证重试/取消 |
| `adopt-e2e.cjs` / `adopt-live.cjs` | 认领路径的端到端验证 |
| `remote-ls.cjs` / `seed-remote.cjs` / `clean-remote.cjs` | 远端目录列举与造数/清理 |
| `delete-verify.cjs` / `remote-root-verify.cjs` | 删除链路与远端根改写验证 |

### 通用坑

1. **`main()` 必须包在 `app.whenReady().then()` 里**——窗口是那时才建的，太早取 `BrowserWindow.getAllWindows()[0]` 拿到 `undefined`。

2. **断言必须落在真实状态上。** 删了远端文件就去列远端目录，不能只看界面上的差异数字；远端操作是异步的（请求返回只表示已受理，夸克侧落盘要 1~3 秒），必须**轮询等待**而不是固定 sleep。

3. **表格里混着多种行时必须按行文本定位**，不能「勾第 0 行」。否则会把「勾错了行」「还在处理中」误判成「功能坏了」。

4. **页面里有两张同类表格时不能取第一个。** 清单页的「只在远端的文件」那张排在主表前面，`querySelector('.card.table-card table.tbl')` 取到的是它——必须按**表头文字**精确定位主表。

5. **`executeJavaScript` 里写 `a?.b > c?.d` 这类「可选链 + 比较运算符」会在 Chromium 抛「Script failed to execute」。** 探针里改用 `el.scrollWidth > el.clientWidth` 的显式取值。

6. **试运行脚本会真的删本地文件、真的点删除按钮。** 看日志要先分清哪些是脚本行为、哪些是人在窗口里手动操作的。

7. **带安全闸的脚本**：远端根路径必须含 `live-verify` / `feature-verify` 标记，否则拒绝运行。

---

## 十一、已知技术债

| 项 | 说明 |
|---|---|
| `chunkConcurrency` 未接线 | 配置项与 UI 都有，但分片上传是串行的 |
| `pruneRemoteSnapshot` 无调用点 | 逻辑写好了但没接上，`remote_snapshot` 表只增不减 |
| 远端目录缓存无失效机制 | `remoteDirCache` 只增不减，一次瞬时列举失败会把「空目录」缓存住 |
| `verifyHashMaxBytes = 0` 语义两处相反 | 一处当「不限」，一处当「禁止」 |
| 任务表随文件数无界增长 | 每个扫到的文件都建一条任务记录，10 万文件的目录会让首屏 IPC 传 10 万个对象 |
| `missing_remote` 逐条串行复核 | 10 万文件的库对账会超时中止（默认 30 分钟） |
