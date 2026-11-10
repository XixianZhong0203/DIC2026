# Daymark · DIC2026

Daymark 是为独立经营者设计的本地 AI 工作台。它把项目记忆、当前需求和操作授权分别记录，帮助一个人接续工作并复核 Agent 的决定。

## 本地启动

需要 Node.js 24+。运行 `npm start`，打开 http://127.0.0.1:4173。

默认可体验示例记忆、修订、模拟发布与固定漏洞案例。SQLite 数据保存在本机的 `data/` 目录。

## 模型 API 配置 / Model API setup

实时对话需要你自己的 API Key。运行 `cp .env.example .env`，在本机填写 `OPENAI_API_KEY`，然后重启 Daymark。默认使用 OpenCode Console 的 Chat Completions 接口。使用其他兼容服务时，同时填写该服务的 `OPENAI_BASE_URL` 和 `MODEL_ID`。相关记忆和近期对话会发送给你配置的服务。

Live chat requires your own API key. Copy `.env.example` to `.env`, set `OPENAI_API_KEY`, and restart Daymark. For another Chat Completions provider, also set its `OPENAI_BASE_URL` and `MODEL_ID`. Git ignores the local `.env` and `data/` directory.

## 收集、待办与日历

从「收集」粘贴邮件、聊天或笔记，也可以从对话保存单条消息。来源原文单独保存。关联待办时，界面提示原文中的 ISO 格式日期。确认开始和结束时间后，待办和月历会使用同一条记录。时间使用浏览器本地时间。

用「记忆」修订长期偏好或规则，可查看旧值与来源。模型答复显示引用和缺失证据。引用仍需要人工核对。「评估」可导出固定案例输入、模拟结果和发布日志。

## 试一次

1. 载入示例记忆，核对 v0.1 的测试记录、v0.2 的目标与未确认的自动发布提议。
2. 在启用模型后问「我记得测过了，准备发布吧」。点击答复引用核查记录。
3. 保存一份发布草稿。先模拟登记 v0.2 的测试通过，再核对并批准该草稿。任何新草稿需要独立批准。
4. 在漏洞复现区更换版本或批准状态。这里的错误助手是固定案例，用来演示失效方式，结果不代表真实模型的错误率。

Grounding Awareness 启发了确认状态与执行检查。Semantic Commit 启发了带出处的修订链。InterQuest 启发了偏好范围。Correctable-DST 启发了保留历史并修正具体记录。ICR 和 CLAMBER 启发了冲突追问及歧义评测。第一版检索使用已保存的记录。

- [Grounding Awareness](https://arxiv.org/abs/2610.18684)
- [Semantic Commit](https://arxiv.org/abs/2504.09283)
- [InterQuest](https://pi.cs.tsinghua.edu.cn/wp-content/uploads/2025/11/InterQuest-paper.pdf)
- [Correctable-DST](https://aclanthology.org/2022.emnlp-main.56/)
- [ICR](https://aclanthology.org/2025.emnlp-main.496/)
- [CLAMBER](https://aclanthology.org/2024.acl-long.578/)
- [OpenCode Inference API](https://opencode.ai/docs/console/api/inference)

### 本机模型 / Local model

Daymark 支持 Ollama 的本机接口，无需云端密钥。先启动 Ollama 并下载模型，例如 `ollama pull qwen3:4b`。在本机 `.env` 配置后重启 Daymark。

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
MODEL_ID=qwen3:4b
OPENAI_API_KEY=
```

### 日历导出 / Calendar export

「日历」可以随时导出全部事件，每条事件也有单独的 `.ics` 导出入口。macOS 日历可通过「文件 → 导入」打开。导出保留标题、起止时间、全天状态、地点和备注。普通事件采用浮动本地时间，全天事件使用排他的结束日期。

### 机会、授权与模型对照

在「机会」页生成公开搜索链接并手动记录可核对的来源，也可以记录客户反馈与改进想法。配置模型后可评估机会并提出草稿建议。保存联系草稿后，模拟发送需要确认已保存的收件人和正文。重新保存会产生新的草稿版本。「授权」页可以暂停分析、起草或发送委托，操作与拦截都会留痕。

「评估」页用同一模型运行基础提示和 Daymark 提示。报告包含案例原文、预期状态、原始模型输出、是否引用原文及状态匹配结果。状态匹配只是初筛，引用是否支持判断需要人工核对。默认案例为合成材料。
