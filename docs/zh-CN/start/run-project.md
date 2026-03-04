---
read_when:
  - 你正在本地拉起 OpenClaw 源码工程
  - 你需要快速确认哪些端口是 UI，哪些端口是受保护 API
summary: 从源码安装依赖并启动开发网关，包含常见问题排查。
title: 本地运行项目（开发）
---

# 本地运行项目（开发）

本文档面向源码仓库（`stk-openclaw`）的本地开发运行。

## 0) 前置条件

- Node.js `>=22.12.0`
- `pnpm`（项目当前使用 `pnpm@10`）

<Note>
如果 Node 版本过低（例如 Node 20），`pnpm install` 可能仍能执行，但会出现 engine 警告，建议升级到 Node 22+ 再运行。
</Note>

## 1) 安装依赖

在仓库根目录执行：

```bash
pnpm i
```

## 2) 启动开发网关

推荐命令：

```bash
pnpm gateway:dev
```

启动成功后通常会看到类似日志：

- `gateway listening on ws://127.0.0.1:19001`
- `Browser control listening on http://127.0.0.1:19003/ (auth=token)`

## 3) 打开可视化入口

- 控制 UI（Dashboard）：`http://127.0.0.1:19001/`
- 快捷打开（自动带 token 并尝试打开浏览器）：

```bash
node scripts/run-node.mjs --dev dashboard
```

## 4) 关于 `19003 Unauthorized`（常见）

`http://127.0.0.1:19003/` 是 Browser Control API，默认启用 token 鉴权。  
直接浏览器访问通常会返回 `Unauthorized`，这是正常行为。

先取 token：

```bash
node scripts/run-node.mjs --dev config get gateway.auth.token
```

再用带 Header 的请求访问：

```bash
curl -H "Authorization: Bearer <你的token>" http://127.0.0.1:19003/
```

## 5) 常见误区

`pnpm dev` 会调用 CLI 入口（`node scripts/run-node.mjs`），默认会显示帮助信息，不会自动常驻启动网关。  
需要常驻开发服务时，请使用 `pnpm gateway:dev`。

## 6) 停止运行

在启动命令所在终端按 `Ctrl + C` 即可停止。
