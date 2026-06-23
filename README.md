# KB AI Assistant

Obsidian 插件：基于 DeepSeek 的个人知识库 AI 助手。

## 功能

- **流式聊天** — SSE 逐字输出，实时显示 AI 回复
- **Markdown 渲染** — 表格、列表、代码块、标题全部渲染
- **多会话** — 支持多个对话，重命名、新建、删除
- **上下文切换** — 读取全部笔记或仅当前笔记
- **笔记集成** — AI 回复中的笔记名可点击跳转
- **相关笔记** — AI 回复后自动推荐相关笔记
- **追问建议** — 自动生成 3 个追问按钮
- **对话管理** — 复制、编辑重发、重新生成、导出到笔记
- **AI 创建笔记** — 把 AI 回复直接存为新笔记
- **快捷键** — `Ctrl+Shift+A` 打开 AI 面板
- **右键分析** — 选中文本 → AI 分析选中内容
- **多模型** — 设置页管理多个模型，对话界面下拉切换
- **自定义提示词** — 可编辑 AI 角色和系统提示词
- **Temperature 调节** — 0-1 控制 AI 创造性
- **Token 预估** — 实时显示上下文 token 数
- **笔记缓存** — 30秒缓存 + 清空按钮

## 安装

### 手动安装
1. 下载 `main.js`, `manifest.json`, `styles.css`
2. 放入 Vault 的 `.obsidian/plugins/kb-ai-assistant/` 目录
3. 重启 Obsidian，设置中启用插件

### 社区市场
1. 设置 → 第三方插件 → 关闭安全模式
2. 搜索 "KB AI Assistant" → 安装

## 配置

1. 打开设置 → KB AI Assistant
2. 填入 DeepSeek API Key（获取：[platform.deepseek.com](https://platform.deepseek.com)）
3. 点击「测试」验证连接
4. 可选：调整 Temperature、系统提示词、模型

## 使用

- 点击侧栏 🧠 图标打开 AI 面板
- 点击 📄 图标总结当前笔记
- `Ctrl+Shift+A` 快捷键打开面板
- `Ctrl+P` → "AI 分析选中文本" 分析选中内容
- 从文件树拖拽笔记到聊天区域

## 技术

- 纯 JavaScript，无构建步骤
- 调用 DeepSeek API（OpenAI 兼容格式）
- 支持流式输出（SSE）
- 兼容 Obsidian 1.0.0+
