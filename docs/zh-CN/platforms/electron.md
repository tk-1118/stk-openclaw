---
read_when:
  - 你要在 macOS/Windows/Linux 使用同一套桌面壳
  - 你要调试 OpenClaw 的 Electron 打包与本地联调
summary: OpenClaw Electron 三端桌面壳（内置 Node + 外部 Gateway 子进程）
title: Electron 桌面应用
---

# Electron 桌面应用（跨平台）

本文档描述 OpenClaw 的 Electron 三端桌面壳实现：**Electron 主进程负责桌面容器，Gateway 仍由独立 Node 子进程运行**。

## 架构说明

- Electron 主进程负责窗口、IPC、安全策略、子进程生命周期。
- 主进程启动 `openclaw.mjs gateway`，并等待 `/healthz` 就绪后加载本地 Dashboard。
- 打包产物内置 Node 运行时（按平台目录），避免要求用户系统安装 Node。
- 现有 `apps/macos` 原生实现保持并行，不受本路线影响。

## 目录与关键文件

- `apps/electron/src/main.ts`：窗口与 Gateway 子进程管理。
- `apps/electron/src/preload.ts`：渲染进程最小 IPC 暴露。
- `apps/electron/electron-builder.yml`：三端打包配置。
- `scripts/electron-prepare-runtime.mjs`：准备打包用运行时资源（Node + OpenClaw runtime）。

## 开发与构建

在仓库根目录执行：

```bash
pnpm --dir apps/electron install
pnpm electron:dev
```

打包命令：

```bash
pnpm electron:dist:mac
pnpm electron:dist:win
pnpm electron:dist:linux
```

通用构建（不区分平台目标）：

```bash
pnpm electron:dist
```

## 运行时说明

- 开发态默认直接使用仓库根目录作为 OpenClaw runtime。
- 打包前会执行 `pnpm electron:prepare-runtime`，产出 `apps/electron/.runtime/`：
  - `.runtime/node/<platform-arch>/node(.exe)`
  - `.runtime/openclaw/openclaw.mjs`
  - `.runtime/openclaw/dist/`
  - `.runtime/openclaw/node_modules/`

## 安全基线

- `contextIsolation=true`
- `nodeIntegration=false`
- `sandbox=true`
- 禁止任意新窗口，外链使用系统浏览器打开
- 主窗口只允许导航到本地 loopback 地址

## 验收清单

- 首次安装可直接启动，无需系统 Node。
- 主窗口可正常打开 Dashboard。
- `/healthz` 探测成功后才加载页面。
- 网关异常退出时可通过 IPC 触发重启。
- 退出桌面应用时可优雅停止 Gateway 子进程。

## 故障排查

- 若启动失败，查看用户目录下的 `gateway.log`。
- 若打包阶段缺少 runtime 文件，先执行 `pnpm build && pnpm ui:build` 再运行 Electron 打包命令。
- 若端口冲突，应用会自动寻找可用本地端口。
