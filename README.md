# 政策找你 · Policy Finds You

全国惠民政策智能匹配平台。用户通过地图选址、填写画像，系统从本地政策知识库检索并结合 DeepSeek AI 进行匹配与解读，帮助个人和企业快速找到「本该属于自己」的政策权益。

**在线演示：** https://policy-finds-you.onrender.com  
**代码仓库：** https://github.com/getstronger-sys/policy-finds-you

---

## 功能概览

### 用户端

| 模块 | 说明 |
|------|------|
| 地图选址 | 交互式中国地图，按省份筛选政策 |
| 用户画像 | 支持个人 / 企业身份，结构化表单、自由文本、语音、问答等多种录入方式 |
| 智能匹配 | 本地知识库检索 + DeepSeek 语义匹配，展示申报窗口、匹配原因、下一步建议 |
| 政策搜索 | 关键词搜索各省在库政策，支持查看详细解读 |
| 政策解读 | AI 生成通俗办理说明、资格判断、申领路径与材料清单 |
| AI 问一问 | 右下角浮动咨询，结合用户画像回答政策问题 |
| 我的待办 / 收藏 | 本地持久化，跟踪办理进度 |
| 权益分享 | 生成二维码，便于转发给家人或同事 |

### 政府端（`/gov`）

- 数据驾驶舱：地区热度、政策关注结构、新增趋势
- 核心指标：触达率、转化率、资金使用、政策盲区
- 中国地图可视化与图表导出

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 · TypeScript · Vite · Tailwind CSS · ECharts |
| 后端 | Node.js · Express 5 |
| AI | DeepSeek API（匹配、解读、对话） |
| 部署 | Render（单服务同域：静态页 + `/api`） |

---

## 项目结构

```
policy-finds-you/
├── src/                    # React 前端（App.tsx 为主入口）
├── server/index.mjs        # Express API 与生产环境静态资源托管
├── data/knowledge/         # 各省政策 JSON 知识库（31 个省级文件）
├── public/                 # 静态资源（logo、robots.txt 等）
├── scripts/                # 政策抓取等工具脚本
├── render.yaml             # Render Blueprint 部署配置
├── vite.config.ts          # 开发时代理 /api → localhost:8787
└── .env.example            # 环境变量模板
```

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填写：

```env
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
API_PORT=8787
VITE_API_BASE_URL=http://localhost:8787
```

> **注意：** `DEEPSEEK_BASE_URL` 请使用 `https://api.deepseek.com`，不要带 `/anthropic` 后缀。

### 3. 启动开发环境

同时启动前端与 API：

```bash
npm run dev:all
```

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:5173 |
| API | http://localhost:8787 |

也可分别启动：

```bash
npm run dev      # 仅前端
npm run dev:api  # 仅 API
```

### 4. 构建与预览

```bash
npm run build
npm start        # 生产模式：Express 托管 dist + API
```

---

## 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | 是 | DeepSeek API 密钥 |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com` |
| `API_PORT` / `PORT` | 否 | 本地默认 `8787`；Render 自动注入 `PORT` |
| `VITE_API_BASE_URL` | 本地需要 | 开发时指向 API；**生产留空**（同域 `/api`） |
| `API_RATE_LIMIT_MAX` | 否 | 每 IP 每分钟请求上限，默认 `40` |
| `KNOWLEDGE_CACHE_TTL_MS` | 否 | 知识库内存缓存 TTL，默认 `15000` |

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查与配置摘要 |
| GET | `/api/deepseek-probe` | DeepSeek 连通性探测 |
| GET | `/api/policy-search` | 关键词搜索政策 |
| POST | `/api/match-policy` | AI 政策匹配 |
| POST | `/api/policy-interpret` | AI 政策解读 |
| POST | `/api/policy-chat` | AI 政策咨询对话 |
| POST | `/api/gov-track` | 政府端行为埋点 |
| GET | `/api/gov-metrics` | 政府端指标数据 |

---

## 部署（Render）

项目已包含 `render.yaml`，支持 Blueprint 一键部署：

1. 将代码推送到 GitHub
2. 在 Render 选择 **New + → Blueprint**，选中仓库
3. 配置环境变量 `DEEPSEEK_API_KEY`
4. 确认 `DEEPSEEK_BASE_URL=https://api.deepseek.com`
5. 保存并 **Manual Deploy**

部署说明：

- 线上为**单服务同域**结构，前端与 `/api` 共用同一域名
- 生产环境**不要**设置 `VITE_API_BASE_URL`（构建时留空即可）
- 修改 Render 环境变量后需重新部署才能生效
- Free 实例冷启动可能需要数十秒

诊断地址示例：

- `https://你的域名/api/health`
- `https://你的域名/api/deepseek-probe`

---

## 政策知识库

各省政策以 JSON 存储于 `data/knowledge/`，文件名形如 `beijing-policies.json`、`安徽-policies.json` 等。

抓取北京市政策示例：

```bash
npm run crawl:beijing -- --max=80 --discover=800
```

输出：`data/knowledge/beijing-policies.json`

---

## 常用命令

```bash
npm run dev:all      # 开发：前端 + API
npm run build        # 构建前端
npm run start        # 生产启动
npm run lint         # ESLint 检查
npm run preview      # 预览构建产物
```

---

## 许可证

本项目为黑客松演示用途。政策数据来源于各地政府公开信息，使用时请遵守相应网站的转载与使用规定。
