# 政策找你（MVP）

一个“政策找你”黑客松项目：地图选址 + 用户画像 + 政策匹配（支持 DeepSeek AI）。

## 1) 安装依赖

```bash
npm install
```

## 2) 配置环境变量

复制一份 `.env.example` 为 `.env`，然后填入你的 key：

```bash
DEEPSEEK_API_KEY=你的key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
API_PORT=8787
VITE_API_BASE_URL=http://localhost:8787
```

## 3) 启动项目

同时启动前端 + AI API：

```bash
npm run dev:all
```

- 前端：`http://localhost:5173`
- AI API：`http://localhost:8787`

## 一键部署（Render Blueprint）

项目已包含 `render.yaml`，可直接导入仓库自动建站：

1. 把代码推到 GitHub 仓库
2. 在 Render 选择 **New +** -> **Blueprint**
3. 选择该仓库，Render 会自动识别 `render.yaml`
4. 在环境变量里填 `DEEPSEEK_API_KEY`
5. 点部署，完成后得到公网 URL

说明：

- 线上是“单服务同域”结构（前端页面 + `/api` 都在同一个域名）
- 不需要额外配置前端 API 地址（默认走同域 `/api`）
- 默认开启 API 限流（每 IP 每分钟 40 次），可用 `API_RATE_LIMIT_MAX` 调整
- 上线后请把 `public/robots.txt` 与 `public/sitemap.xml` 里的域名改成你的真实域名

## 4) 政策数据抓取

抓取北京市政策到本地知识库：

```bash
npm run crawl:beijing -- --max=80 --discover=800
```

输出文件：

- `data/knowledge/beijing-policies.json`
