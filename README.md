# TopenSync

Windows 桌面同步程序：**本地目录 →（内网 HTTP）→ OpenList →（外网）→ 夸克网盘**。

远端保持**原始文件树**，在 OpenList 里可直接浏览、预览、播放。

仓库地址：https://github.com/haiyinlin/topensync

---

## 这是什么

一个只做一件事的备份工具：把指定的本地文件夹单向同步到自部署 OpenList 暴露的夸克网盘存储。

设计上刻意保持克制：

- **单向同步**（本地为准）。远端对账只做校正，不把远端内容拉回本地。
- **不打包**。小文件逐个直传，保留完整目录层级。
- **不绕过服务端**。全部走 OpenList 的标准 HTTP 接口。

---

## 两条扫描通道

这是本项目最核心的概念，两者角色不同、不可互相替代：

| | 本地扫描 | 远端对账 |
|---|---|---|
| 性质 | 变更事件源 | 对账基准 |
| 触发 | chokidar 实时 | 定时（默认 6 小时）+ 手动 |
| 覆盖 | 本地同步根目录 | 远端根目录 |
| 发现 | 「本地改了」 | 「远端被外部删了 / 改了 / 多了」 |
| 动作 | 直接进上传队列 | 产出差异 → 差异回流进同一个上传队列 |

**为什么必须有远端对账**：只扫本地有一个静默漏洞——你在 OpenList 网页端删了某个文件，本地 mtime 没变，清单就认为它已同步，于是永远不再上传，备份就此缺失。对账周期性地重列远端树来发现这类偏差。

差异处置默认立场是「本地为准」：

| 差异 | 默认动作 |
|---|---|
| 远端缺失 | 自动重传 |
| 内容不符 | 自动覆盖远端 |
| 仅远端存在 | **只记录，不动作**（避免误删其他设备刚上传的内容） |
| 时间差异 | 只记录 |

---

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Electron + electron-vite |
| 语言 | TypeScript（严格模式） |
| UI | React + Zustand |
| 监控 | chokidar |
| HTTP | Node 内置 `fetch`（undici），流式上传 |
| 清单 | `node:sqlite`（Node 22+ 内置，**无 native 编译**） |
| 哈希 | Node `crypto`（MD5 + SHA1 双哈希） |

**明确不用**：`webdav` 客户端库（写入路径不支持哈希头）、`better-sqlite3`（native）、zstd / tar（无归档需求）。

---

## 关键约束

这些是从 OpenList v4 源码核实出来的硬约束，改动前务必读完：

1. 上传是 **`PUT /api/fs/put`**，不是 POST。
2. 列举目录时 **`per_page` 必须传足够大的值**。`per_page: 0` 会返回**空数组**。
3. **`refresh: true` 需要目标目录的写权限**，否则 403。远端对账依赖它来发现外部删除。
4. 夸克秒传需要 **MD5 + SHA1 同时提供**。缺任一个 → 服务端把整个文件缓存起来再算哈希，既失去秒传，又可能撑爆服务器内存。
5. `As-Task: true` 会强制服务端把整文件落盘，本项目**不使用**。
6. 带宽瓶颈在 **OpenList → 夸克**（按账号共享限速），不在内网段。提高并发不会更快，只会招风控。

---

## 开发

```bash
npm install
npm run dev          # 开发模式
npm run typecheck    # 类型检查
npm run build        # 构建
npm test             # 单元测试
```

---

## 目录结构

```
src/
├── main/                 主进程
│   ├── config/store.ts   配置持久化（safeStorage 加密凭据）
│   ├── db/manifest.ts    SQLite 清单（node:sqlite）
│   ├── hash/hashes.ts    双哈希计算
│   ├── openlist/client.ts OpenList REST 客户端
│   ├── reconcile/        远端对账器
│   └── transfer/         传输执行器（两档路径）
├── preload/              预加载（最小 API 面）
├── renderer/             渲染进程（React）
└── shared/types.ts       主/预/渲染共享的类型定义

ui-prototype/             静态视觉基准（浏览器可直接打开）
```

---

## 免责声明

本程序为**非官方客户端**，通过 OpenList 的标准 HTTP 接口与夸克网盘交互，不包含任何绕过服务端校验的逻辑。

当前处于开发阶段，请勿将其作为唯一的备份手段。
