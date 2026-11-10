# Daymark · DIC2026

Daymark 是为独立经营者设计的本地 AI 工作台。它把项目记忆、当前需求和操作授权分别记录，帮助一个人接续工作并复核 Agent 的决定。

## 本地启动

需要 Node.js 24+。运行 `npm start`，打开 http://127.0.0.1:4173。

默认可体验示例记忆、修订、模拟发布与固定漏洞案例。要启用实时对话，复制 `.env.example` 为 `.env` 并填写新的 OpenCode API Key。模型端点和模型 ID 可配置，应用使用 Chat Completions。相关记忆和近期对话会发送给配置的模型服务。SQLite 数据在被 Git 忽略的 `data/` 中。

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
