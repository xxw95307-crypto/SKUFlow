# 商品图生视频

模型：wan2.7-i2v，按阿里云万相2.7原生异步API实现。

在Listing全部确认后输入“生成商品视频”，Agent规划一条视频，商家在对话卡片确认后启动。原始商品图片作为首帧，比例跟随首帧。原视频解析、剪辑、视频发布到Shopify尚未实现，生成视频只提供预览与下载。

独立环境配置：
- BAILIAN_VIDEO_API_KEY：对应地域普通百炼视频服务API Key；不回退到比赛文本Key。
- BAILIAN_VIDEO_BASE_URL：对应地域 /api/v1 地址，例如 https://dashscope.aliyuncs.com/api/v1 或业务空间专属域名。
- BAILIAN_VIDEO_MODEL：可省略，使用wan2.7-i2v；支持日期版本。

不配置时仍可策划，生成按钮禁用；需要在本地.env.local及现有Sites运行环境中安全设置密钥，勿提交密钥。时长与清晰度影响费用，不自动生成。

video_jobs保存方案、provider_task_id和结果状态。启动前条件更新状态防重复提交。提交超时或未知错误保留SUBMISSION_UNKNOWN，不自动重发，需核对服务记录。刷新只查询原provider_task_id，不重复提交；成功MP4存入R2，避免供应商临时链接过期。页面打开时15秒刷新进度。关闭页面不会轮询；超过供应商24小时有效期且尚未存储时可能无法恢复。

接口：GET/POST/PATCH /api/tasks/:taskId/videos，GET /api/tasks/:taskId/videos/:videoId/file 支持Range。POST只策划，PATCH start确认调用，PATCH refresh查询及保存结果。

参考：https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference
