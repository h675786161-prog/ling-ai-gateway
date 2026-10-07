# 玲的统一 AI 入口

一个自用优先的 OpenAI-compatible 网关，登录后首先进入模型检查页面。默认部署使用 GitHub Pages + 已有 Supabase 免费项目；不需要常开电脑。代码公开，管理页有门禁，数据库不允许浏览器直接访问。

## 批量检查模型

1. 用管理访问码进入页面，点击“添加站点”，填名称、API Base URL 和新密钥。仅检查时不用启用线路，也不用填模型映射。
2. 选择站点，点击“读取模型列表”。读取成功只表示得到候选名称，不会标为可用。不提供列表的站点可以“手动添加模型”，每行一个。
3. 点击“一键实测”。最多并行 2 个，每个模型直接请求当前站点的 `/chat/completions`，不通过故障切换；只有收到实际文字才标成可用。流式请求在第一段文字后停止。无视 `stream` 参数的站点可以返回标准 JSON 回复。
4. 可筛选可用、异常、未测结果，单独重试、重试异常项，或复制全部可用名称。结果在服务端保存，换设备后仍能查看。

默认等待 12 秒，可以选 5、20、30 秒。超时表示在该时限内没有收到文字，不是模型永久失效。限流、余额不足、权限问题、模型不存在、空回复和连接故障分别记录，包含耗时、检查时间、HTTP 状态；如果返回了不同的模型名称，会显示上游返回名称。检查不能证明供应商模型标签与真实模型身份一致。

批量检查会消耗真实请求次数和上游 token 额度。它共享站点的每日和每分钟限额，站内速率用完后会等待并继续；上游返回 429、402 或 401 时暂停剩余检查，未测项不会被判为不可用。单个模型的 403 不会阻止检查其他模型。点击停止会保留已经完成的结果，已发出的云端请求可能继续到所选超时时间。

结果按站点和模型分开保存。更换站点地址、类型或密钥后，原结果显示“需重测”，不再计入可用数量。模型目录、角色/推理片段、心跳、成功的 HTTP 头或空回复都不会单独证明可用。OpenRouter 免费站点只检查免费模型；自定义站点可能包含付费模型，请按自己的额度检查。

## 使用

- 管理页：https://h675786161-prog.github.io/ling-ai-gateway/
- Base URL：`https://ibpffxzdjvgydnhmvmvc.supabase.co/functions/v1/ling-ai-gateway/v1`
- 模型：`fast`、`smart`、`rp`、`backup`
- 管理访问码：与现有自用网站相同；不记录在仓库或说明中。
- 在“我的线路”填写一条新的上游密钥、真实模型名称，勾选启用。
- 在“密钥与配额”生成自己的应用密钥，复制到 SillyTavern 的自定义 OpenAI-compatible 连接。
- 应用密钥仅用于模型调用，不能进入管理后台。普通用户需由管理员创建，并手动开启分享。

SillyTavern：选择聊天补全 → 自定义 OpenAI-compatible，API URL 填上述 Base URL，API Key 填网关签发的密钥，模型选择上述别名。上游线路变化不需要修改客户端。

## 行为

- `GET /v1/models` 与 `POST /v1/chat/completions`，包含 SSE 流式输出。
- 三类官方线路模板：Gemini OpenAI-compatible API、OpenRouter 免费池、Cloudflare Workers AI；也支持自定义 HTTPS OpenAI-compatible 服务。
- Gemini 模板名称是配置起点，不保证当前账号或地区具有免费额度；请按账号实际可用模型修改。OpenRouter 免费类型只允许 `openrouter/free` 或 `:free` 模型。
- 按优先级选择线路；单次最多尝试 3 条。429、401/403/404、5xx、网络故障和首个有效响应前的超时可尝试下一条。请求参数错误（400）直接返回。
- 429 进入至少 60 秒冷却，尊重 Retry-After（上限一天）。连续 3 次网络/服务错误后冷却 30 秒，继续失败则延长，最高 300 秒。401/403/404 冷却 10 分钟。冷却后只允许一个恢复探测；真实调用成功后关闭熔断。模型列表健康检查不会覆盖真实推理熔断。
- 首次响应等待上限 18 秒，整次请求（含故障切换与流式输出）总时长约 110 秒；适合短中等对话。超长推理可能超过免费 Edge Function 的生命周期。已经输出部分内容后不重试，以免重复回答。
- 用户按北京时间每日限额，最多同时 2 个请求。线路按每日调用次数及每分钟调用次数限流，并为管理员预留部分每日容量。管理员默认不限制站内日次数，仍遵守线路限制及厂商额度。
- 调用完全失败退还用户站内次数；线路尝试次数不退还。部分输出中断仍算一次。异常终止超过 5 分钟的挂起记录由定时任务修复。
- 页面显示的“剩余”是站内请求上限，不是厂商真实余额。CF AI 的 Neurons、模型 token 预算等不能换算为准确请求次数。
- 每小时第 17 分钟检查最多 12 条已启用线路的模型列表（普通线路 `/models`，Workers AI `/ai/models/search`），不发送推理请求。管理页也可手动检查。只检查连通性和鉴权，不证明模型可生成。
- 不保存对话正文。日志包含用户 ID、模型别名、每次尝试的线路/status/latency，以及上游报告的 tokens；只保留最近 30 天。页面聊天仅保留在当前页面内存。

## 安全

- 所有网关表启用 RLS，并撤销 anon/authenticated 的表及 RPC 权限；后端 service_role 专用。
- 上游密钥采用 AES-GCM 加密保存，默认从 Supabase 服务端 secret 派生加密密钥。浏览器提交后不会回显；只能看到 has_key。轮换 Supabase secret 前应设置独立的 `LING_GATEWAY_ENCRYPTION_KEY` 并重新录入线路密钥，避免旧密文无法解密。
- 网关应用密钥只存 SHA-256；显示一次，可撤销。管理会话 8 小时有效、仅在当前浏览器会话保存。退出撤销会话。
- 管理登录复用现有门禁的哈希；登录次数通过数据库限制。已有网站的 API 配置没有读取、复制或修改。
- 拒绝非 HTTPS、内网地址、URL 内嵌凭据和重定向；Supabase 运行时检查域名解析结果。域名解析检查不是对恶意 DNS 重绑定的完整网络隔离，只应配置你信任的上游。
- 定时健康检查使用专门的监控密钥，保存在 Supabase Vault；它只能调用 `/internal/health`，没有管理权限。

## 开发与部署

Node.js 22+，运行时无需第三方依赖。

```sh
npm ci
npm run check
npm test
npm run dev
```

数据库结构在 `supabase/schema.sql`，新增模型检查表及并发/配额 RPC 在 `supabase/model-checks.sql`，通过 Supabase migration API 应用并记录迁移历史；不要对已部署数据库重复执行脚本。`src/edge.ts`、`src/gateway.mjs` 和 `src/model-checks.mjs` 一起部署为 `ling-ai-gateway` Edge Function。必须关闭平台 JWT 验证，因为本项目采用自身 API key 验证，所有管理和模型接口均独立鉴权。

GitHub Actions 部署 `public/` 到 Pages。公开文件只有页面程序和公开后端地址。

以后有 Cloudflare 账号时，可将 `wrangler.toml` 部署到 Workers 免费计划，静态资源使用 `public/`，API 转发到现有 Supabase 后端；无需迁移密钥或数据库。Cloudflare Workers AI 模板本身需要 Cloudflare 账号和 API token，未注册时留关闭即可。

## 费用与适用范围

本项目没有启用付费订阅、域名或付费模型。现有 Supabase 项目确认使用 Free 计划，容量与其他网站共享；免费配额、项目暂停政策及上游账号额度仍然适用，不承诺无限或永久免费。

成熟的 [New API](https://github.com/QuantumNous/new-api) 支持更多协议、计费和用户管理，但需要持续运行后端程序。当前方案针对无常开服务器、无需电脑在线的 Supabase 云端部署。以后可把模型别名保持不变，迁移到 New API。

官方接口参考：[Gemini](https://ai.google.dev/gemini-api/docs/openai)、[OpenRouter Free](https://openrouter.ai/docs/guides/routing/model-variants/free)、[Workers AI](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)、[Supabase 定时任务](https://supabase.com/docs/guides/functions/schedule-functions)。
