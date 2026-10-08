# 商品图生视频

模型：wan2.7-i2v，按阿里云万相2.7原生异步API实现。

在Listing全部确认后输入“生成商品视频”，Agent规划一条视频，商家在对话卡片确认后启动。原始商品图片作为首帧，比例跟随首帧。原视频解析与剪辑尚未实现；生成的视频可选择、预览、下载，并同图片经媒体编排确认后同步到Shopify商品媒体。

独立环境配置：
- BAILIAN_VIDEO_API_KEY：可选，优先使用；未设置时按用户授权复用BAILIAN_API_KEY。
- BAILIAN_VIDEO_BASE_URL：对应地域 /api/v1 地址，例如 https://dashscope.aliyuncs.com/api/v1 或业务空间专属域名。
- BAILIAN_VIDEO_MODEL：可省略，使用wan2.7-i2v；支持日期版本。

无可用Key时仍可策划，生成按钮禁用；默认北京百炼视频API地址，不使用聊天token-plan endpoint。对应服务权限及计费由百炼决定。时长与清晰度影响费用，不自动生成。

声音：自然音效和背景音乐先由百炼 `qwen-audio-3.1-tts-next` 生成实际 WAV 音频，再作为 `driving_audio` 交给万相图生视频；解说配音使用独立语音合成。不会只在视频提示词里写声音要求而把无音频输入当作完成。生成的声音若短于原计划时长，视频时长缩至完整有声的秒数。音频生成失败会在提交视频前中止，避免为无声视频继续付费。此能力需要视频 API Key 所属账号同时可调用音频生成模型。

video_jobs保存方案、provider_task_id和结果状态。启动前条件更新状态防重复提交。提交超时或未知错误保留SUBMISSION_UNKNOWN，不自动重发，需核对服务记录。刷新只查询原provider_task_id，不重复提交；成功MP4存入R2，避免供应商临时链接过期。页面打开时15秒刷新进度。关闭页面不会轮询；超过供应商24小时有效期且尚未存储时可能无法恢复。

接口：GET/POST/PATCH /api/tasks/:taskId/videos，GET /api/tasks/:taskId/videos/:videoId/file 支持Range。POST只策划，PATCH start确认调用，PATCH refresh查询及保存结果。

参考：https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference

## Shopify 媒体编排

卖家选择成功生成的视频和图片后，Agent根据商品事实、素材用途及图片内容生成封面与顺序方案。每项恰好一次，封面必须第一项图片；对话确认最新方案后才能发布。改选媒体或重新编排须重新确认。媒体安排使用ProductSetInput.files写入；视频先stagedUploadsCreate VIDEO（包含fileSize）并上传。读取商品featuredMedia及media顺序、类型、处理状态核对。如平台顺序有差异则productReorderMedia，保存job ID并在后续核对时查询完成情况。
