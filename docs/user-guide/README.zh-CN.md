# darwin 用户指南

[English](README.md) · **简体中文**

本指南集中说明 darwin 的实际使用方式。[根 README](../../README.zh-CN.md)只保留项目简介；维护者需要的设计依据仍放在[架构文档](../architecture/load-bearing-decisions.md)、[研究记录](../research/)、[自省报告](../reflections/)和[迭代日志](../iteration-log.md)中。

## 按任务查阅

| 页面 | 内容 |
|---|---|
| [入门与模型供应商](getting-started.zh-CN.md) | 环境要求、安装、工作目录结构、模型供应商、首次启动、旧版迁移 |
| [使用 darwin](using-darwin.zh-CN.md) | TUI、无头模式、结构化输出、消息队列、本地 shell 命令、后台任务 |
| [配置与上下文](configuration.zh-CN.md) | 全部配置字段、模型切换、缓存、思考强度、system prompt、`AGENTS.md`、工作上下文 |
| [会话与状态](sessions-and-state.zh-CN.md) | 快照、恢复、轨迹、费用、导出/分叉、记忆、诊断、存储路径 |
| [权限](permissions.zh-CN.md) | 四种模式、静态安全判定、分类器、放行规则及撤销 |
| [扩展](extensions.zh-CN.md) | 发现顺序、MCP、skills、内置工作流、子代理、自定义命令、hooks |
| [命令与按键参考](reference.zh-CN.md) | CLI、斜杠命令、输入语法、按键、各命令行为 |
| [限制与开发](development.zh-CN.md) | 已知限制、本地质量门、测试套件、调试 REPL、架构索引 |

## 建议阅读顺序

- **第一次使用：**[入门](getting-started.zh-CN.md) → [配置](configuration.zh-CN.md) → [使用 darwin](using-darwin.zh-CN.md)。
- **检查安全边界：**[权限](permissions.zh-CN.md) → [会话与状态](sessions-and-state.zh-CN.md) → [限制](development.zh-CN.md)。
- **定制功能：**[扩展](extensions.zh-CN.md) → [命令参考](reference.zh-CN.md) → [架构](../architecture/load-bearing-decisions.md)。
