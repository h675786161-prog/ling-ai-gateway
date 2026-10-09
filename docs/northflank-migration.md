# 完整网关迁移到 Northflank

Northflank 运行原有网页与 Node.js 网关，独立 PostgreSQL 保存数据。保留模型实测、官方名称归并、所有手动名称、智能/多回复/省额度、中文错误说明、用量和候选回复。数据库模式只包含本项目的 `ling_gateway_*` 表，不复制原 Supabase 中其他网站的数据。

## 部署

使用免费项目内的一项服务和一项 PostgreSQL 17 插件。数据库设为私有网络，通过插件变量连接；服务使用本仓库 Dockerfile、一个实例、端口 8080 HTTP 公网，健康检查 `GET /health`。保持免费计算规格，不添加付费存储、备份计划或域名。

运行时变量通过 Northflank 私有配置提供：

| 名称 | 来源和用途 |
| --- | --- |
| `DATABASE_URL` | 私有 PostgreSQL 的 `POSTGRES_URI`，通过插件变量链接 |
| `GATEWAY_MASTER_KEY` | 新生成的 32 字节随机值，用于包裹数据加密密钥；备份时必须保留 |
| `MIGRATION_IMPORT_TOKEN` | 单独生成的 32 字节随机值，仅用于首次迁移；导入后接口自动退役 |
| `PORT` | `8080` |
| `TRUST_PROXY` | Northflank 前置代理设为 `true`，只取最靠近服务的一跳客户端地址 |
| `NODE_OPTIONS` | `--max-old-space-size=192`，为 256 MB 免费服务保留进程额外内存 |

数据库首次启动仅在全新空库中创建本项目表。发现已有部分表时停止启动，避免覆盖数据。数据库连接值和服务端密钥不写入构建参数、仓库、前端或日志。

## 加密迁移

1. 给原 Supabase 部署管理员专用导出路由和 `ling_gateway_migration_snapshot()`。快照 RPC 只授权服务端角色，所有表仍启用 RLS。
2. 使用迁移凭据从新服务 `GET /migration/key` 取得临时 RSA 公钥。
3. 原网关管理员会话调用 `POST /admin/migration/export`，提交该公钥。原服务在一次数据库快照中读取十张网关表，在服务端解密并重新加密上游密钥，再用 RSA-OAEP + AES-GCM 封装全部迁移内容。原 Supabase 平台密钥不离开原服务。
4. 将密文提交至新服务 `POST /migration/import`。新服务在一个事务中导入、核对行数、验证全部上游密钥可解密，再激活网关。任何失败完整回滚。
5. 核对门禁、应用密钥认证、模型目录、手动归并和配额设置；分别验证流式请求和故障切换。仅在核验通过后更新入口。原库保留作为恢复依据。

所有迁移凭据使用 `Authorization: Bearer ...`，放在内存和私有配置中。加密导出可保存为 `.sealed` 文件，已被 Git 和 Docker 构建忽略。首次导入后 `/migration/*` 返回 410，重启不会重开导入。新服务必须保留 `GATEWAY_MASTER_KEY` 才能解开数据库里的数据加密密钥。

## 运行与检查

`npm start` 启动完整服务。网页自动使用当前域名，酒馆填写 `https://服务域名/v1`，继续使用原应用密钥和原模型名。管理员访问码不变。

独立服务沿用现有 Cloudflare 迁移分支的长流式方案，整次生成最多一小时，不受 Supabase 的 150 秒平台寿命限制。正文等待仍按后台原有设置执行，不修改智能备用的等待时间。

`npm run check` 与 `npm test` 验证原网关及真实 PostgreSQL 内核的迁移、事务回滚、权限、认证、密文、防注入、流式断开取消和 HTTP 服务。测试数据是专用虚构记录，不读取用户聊天。

每小时运行维护和最多 12 条已启用线路的目录连通性检查，不发送模型生成。只修复超过 70 分钟的挂起记录，避免提前结束一小时范围内的生成。真正的模型可用测试仍由用户在页面选择，遵守原 RPM 和日限额。旧库的两个网关定时任务已停用，其他网站不受影响。

当前网页：<https://p01--ling-ai-gateway--vbxqzx898zzq.code.run/>。酒馆 Base URL：`https://p01--ling-ai-gateway--vbxqzx898zzq.code.run/v1`。原应用密钥和管理访问码继续有效；新域名首次访问需重新登录。原 Pages 跳转至新站，原 Supabase API 保留转发兼容；长回复使用新地址。

此容器运行现有自定义网关；New API 的专有协议与 Responses 功能需另行接入和实测，不能由本次迁移推断支持。
