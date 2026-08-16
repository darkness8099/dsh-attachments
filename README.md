<div align="center">

# 📎 dsh-attachments

**为 DeepSeek Harness 带来直观、持久、低侵入的文件与文件夹附件体验。**

拖放即用 · 保留目录树 · 输入区与历史消息一致展示 ฅ( ̳• ·̫ • ̳ฅ)

[English](README.en.md) · **简体中文**

[![CI](https://github.com/WJZ-P/dsh-attachments/actions/workflows/ci.yml/badge.svg)](https://github.com/WJZ-P/dsh-attachments/actions/workflows/ci.yml)
![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-111827)
![Version](https://img.shields.io/badge/version-1.0.1-2563eb)
![License](https://img.shields.io/badge/license-MIT-22c55e)

</div>

---

## ✨ 功能亮点

| 能力 | 表现 |
| --- | --- |
| 📁 文件夹拖放 | 一个文件夹对应一张附件卡片，同时完整保留内部目录树 |
| 📄 普通文件 | 支持拖入、预览卡片、持久化历史与流式下载 |
| 🖼️ 原生图片共存 | PNG、JPEG、WebP、GIF 继续使用 Harness 原生图片预览、画廊和多模态检查 |
| 🧠 模型可读取 | 提交后写入当前工作区的 `.deepseek-harness/attachments/`，为模型提供明确路径 |
| 🧩 低侵入扩展 | 通过公开的输入附件栏 slot、会话定义与 Host 路由完成集成 |
| 🪶 原布局保持 | 输入区没有插件附件时，页面布局和原版 Harness 保持一致 |

插件自身不设置附件数量或单文件字节上限；实际可用范围由浏览器、运行环境与目标模型共同决定。

## 🖼️ 效果预览

### 拖放界面

拖入文件或文件夹时，只在原界面上方增加清晰的虚线边界，Harness 原生图片接收界面仍然保留。

<p align="center">
  <img src="assets/screenshots/01-drag-drop-overlay.png" alt="拖放附件界面" width="760" />
</p>

### 图片消息历史

原生图片消息继续显示在持久化会话历史中，并可交给支持多模态输入的模型。

<p align="center">
  <img src="assets/screenshots/02-image-conversation.png" alt="图片消息与模型回复" width="700" />
</p>

### 多图片预览

多张原生图片与插件提供的文件、文件夹卡片共用同一条输入附件区域。

<p align="center">
  <img src="assets/screenshots/03-multiple-image-preview.png" alt="多图片输入预览" width="700" />
</p>

## 🚀 安装

当前版本可直接从独立 GitHub 仓库安装到原生 DSH 的 `web` profile：

```bash
dsh plugin --profile web add github:WJZ-P/dsh-attachments
```

> [!IMPORTANT]
> npm 上未带 scope 的 `dsh-attachments` 已属于另一个项目，因此当前安装命令显式指定本 GitHub 仓库。

检查组合后的配置并启动 DSH：

```bash
dsh --profile web --dump-config
dsh --profile web
```

移除插件：

```bash
dsh plugin --profile web remove dsh-attachments
```

## 🧭 工作流程

```mermaid
flowchart LR
  A["拖入文件或文件夹"] --> B["输入区附件卡片"]
  B --> C["提交用户消息"]
  C --> D["持久化附件元数据"]
  D --> E["复制到工作区附件目录"]
  E --> F["模型读取文件或目录树"]
```

- 浏览器端负责拖放识别、上传、输入卡片和历史渲染；
- Host 端负责字节传输、持久化元数据、下载路由与工作区落盘；
- 图片继续走 Harness 原生链路，插件只接管普通文件与文件夹；
- 拖入目录时，内部成员按完整目录树传输，不会拆成大量输入卡片。

## 📦 DSH 插件约定

本仓库是可直接安装的标准 DSH bundle：

- `package.json` 声明 `dsh.bundle.patch`；
- `cordis.patch.yml` 插入 Host 插件行；
- `dsh.client.platform` 设置为 `web`；
- `exports["./client"]` 暴露预构建浏览器 bundle；
- 官方 `@deepseek-ai/*` 包全部使用 `peerDependencies`；
- 插件与 Tauri API 解耦，可用于原生 DSH Web profile。

## 🧪 开发与验证

环境要求：Node.js `^22.19.0 || >=24.0.0`、pnpm。

```bash
pnpm install
pnpm run build
pnpm test
npm pack --dry-run
```

当前版本面向 DeepSeek Harness `0.1.0-rc.5` 的标准 bundle、Web Client 发现、输入附件栏、会话事件与 Host 路由接口。

## 🔐 安全与跨平台

- 文件名、MIME 类型、附件 ID 与目录成员路径均按不可信输入校验；
- Windows 盘符、UNC 路径、绝对路径及目录穿越片段会在写入前被拒绝；
- GitHub CI 同时覆盖 Linux 与 Windows，避免路径语义差异造成回归；
- 安全问题报告方式及支持范围见 [`SECURITY.md`](SECURITY.md)。

## 🛍️ 插件市场

Marketplace 数据模板、截图 URL 和提交前检查项记录在 [`MARKETPLACE.md`](MARKETPLACE.md)，截图源文件位于 [`assets/screenshots/`](assets/screenshots/)。

## 📄 License

[MIT](LICENSE)

<div align="center">

**让附件安安静静待在该在的位置，也让模型更轻松地找到它们。** (｡•̀ᴗ-)✧

</div>
