# 图片视觉理解 Agent

## 处理链路

```text
R2 原始图片
  → Vision Agent（图片理解 + OCR + 结构化事实 + bbox）
  → vision_agent_runs（模型、Prompt、输入哈希、结果、Token、错误）
  → VISION Evidence
  → Fact Agent（与 PDF / Excel / TXT 证据合并）
  → Product Passport
```

视觉 Agent 只报告图片中可见、可读的证据，不使用常识补全。`bbox` 使用归一化的 `0–1000` 坐标，无法局部定位时为空。

## 百炼配置

```dotenv
BAILIAN_API_KEY=
BAILIAN_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
BAILIAN_MODEL=qwen3.8-max
```

视觉理解 Agent 与事实抽取 Agent 共用这一套配置。`qwen3.8-max` 原生支持图片理解和结构化输出，因此只需要一个模型客户端；两个 Agent 仅代表不同的任务 Prompt、输入和审计记录。图片生成仍属于另一类能力，后续需要时再接入图片生成模型。

## API

- `GET /api/tasks/:taskId/analyze-images`：读取配置状态、图片列表、各图片最近一次运行与汇总。
- `POST /api/tasks/:taskId/analyze-images`：顺序处理任务中尚未完成或上次失败的图片，避免重复计费。
- POST JSON `{ "force": true }`：强制重新分析全部图片；正常界面不会默认启用。

单张图片最大 8 MB，每个任务单次最多处理 12 张。图片直接从私有 R2 读取并编码为 Base64 Data URL，不创建公开图片地址。

## 边界

- 图片元数据解析与视觉理解是两个阶段：前者确定格式和尺寸，后者理解语义。
- 单张失败会记录错误并继续下一张，不让批量任务整体中断。
- Vision Agent 不直接修改商品护照；Fact Agent 负责跨来源合并、冲突检测和最终事实写入。
