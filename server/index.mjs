import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'

dotenv.config()

const app = express()
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8787)
const deepseekApiKey = process.env.DEEPSEEK_API_KEY
const deepseekModel = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const appVersion = process.env.APP_VERSION ?? '0.1.0'
const knowledgeDirPath = resolve('data/knowledge')
const distPath = resolve('dist')
const indexHtmlPath = resolve('dist/index.html')
const isProduction = process.env.NODE_ENV === 'production'
const startedAt = Date.now()
let policyCache = null
let policyCacheAt = 0
const policyCacheTtlMs = Number(process.env.KNOWLEDGE_CACHE_TTL_MS ?? 15000)

if (!isProduction) {
  app.use(cors())
}
app.use(express.json({ limit: '1mb' }))

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX ?? 40)
const ipAccessCounter = new Map()

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim()
  }
  return req.ip || 'unknown'
}

function apiRateLimit(req, res, next) {
  const now = Date.now()
  const ip = getClientIp(req)
  const slot = ipAccessCounter.get(ip) ?? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
  if (now > slot.resetAt) {
    slot.count = 0
    slot.resetAt = now + RATE_LIMIT_WINDOW_MS
  }
  slot.count += 1
  ipAccessCounter.set(ip, slot)
  if (slot.count > RATE_LIMIT_MAX) {
    res.status(429).json({
      error: 'Rate limit exceeded, please retry later.',
      retryAfterMs: Math.max(slot.resetAt - now, 0),
    })
    return
  }
  next()
}

app.use('/api', apiRateLimit)

function toSafeDate(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return value
}

function parseJsonFromLLM(content) {
  if (!content) return null
  try {
    return JSON.parse(content)
  } catch {
    const fenced = content.match(/```json\s*([\s\S]*?)```/i)?.[1]
    if (fenced) {
      try {
        return JSON.parse(fenced)
      } catch {
        return null
      }
    }
    return null
  }
}

async function loadPolicies() {
  const now = Date.now()
  if (policyCache && now - policyCacheAt < policyCacheTtlMs) {
    return policyCache
  }

  const files = await readdir(knowledgeDirPath)
  const policyFiles = files.filter((fileName) => {
    return extname(fileName).toLowerCase() === '.json' && fileName.endsWith('-policies.json')
  })

  if (policyFiles.length === 0) {
    throw new Error('No policy knowledge files found.')
  }

  const merged = []
  for (const fileName of policyFiles) {
    const filePath = resolve(knowledgeDirPath, fileName)
    const file = await readFile(filePath, 'utf8')
    const records = JSON.parse(file)
    if (!Array.isArray(records)) {
      continue
    }
    const province = fileName.replace(/-policies\.json$/i, '')
    for (const item of records) {
      if (!item || typeof item !== 'object') continue
      merged.push({
        ...item,
        province: item.province ?? province,
      })
    }
  }

  const dedupMap = new Map()
  for (const item of merged) {
    const key = `${item.url ?? ''}|${item.title ?? ''}`
    if (!dedupMap.has(key)) {
      dedupMap.set(key, item)
    }
  }
  policyCache = Array.from(dedupMap.values())
  policyCacheAt = Date.now()
  return policyCache
}

function policySearchScore(item, query) {
  const title = String(item.title ?? '')
  const snippet = String(item.contentSnippet ?? '')
  const content = String(item.content ?? '')
  const province = String(item.province ?? '')
  const haystack = `${title}\n${snippet}\n${content}\n${province}`.toLowerCase()
  const normalized = query.toLowerCase()
  const tokens = normalized
    .split(/[\s,，。;；、]+/)
    .map((token) => token.trim())
    .filter(Boolean)

  const keywordList = tokens.length > 0 ? tokens : [normalized]
  let score = 0
  for (const token of keywordList) {
    if (title.toLowerCase().includes(token)) score += 6
    if (snippet.toLowerCase().includes(token)) score += 3
    if (content.toLowerCase().includes(token)) score += 1
    if (province.toLowerCase().includes(token)) score += 2
    if (haystack.includes(token)) score += 1
  }
  return score
}

function buildPromptPayload({ profile, scenario, identity, policies }) {
  const compactPolicies = policies.slice(0, 120).map((item) => ({
    title: item.title,
    province: item.province ?? '',
    publishDate: toSafeDate(item.publishDate),
    deadlineHint: item.deadlineHint ?? '',
    contentSnippet: item.contentSnippet ?? '',
    url: item.url,
  }))

  return {
    profile,
    selectedScenario: scenario,
    identity,
    policy_candidates: compactPolicies,
    required_output_example: {
      matched_policies: [
        {
          name: '政策名称',
          match_level: '完全符合|可能符合|需确认',
          target_group: '适用对象描述',
          scenario: '场景',
          reason: '匹配原因',
          benefit: '金额或权益',
          apply_start: 'YYYY-MM-DD或未知',
          apply_end: 'YYYY-MM-DD或未知',
          next_step: '下一步',
          source_url: '政策链接',
          confidence: 0.0,
        },
      ],
    },
  }
}

function buildLocalInterpretation(policy, profile) {
  const status =
    policy.applyStart && policy.applyEnd
      ? `${policy.applyStart} 至 ${policy.applyEnd}`
      : '有效期以政策原文为准'
  return {
    summary: `${policy.name} 面向 ${policy.targetGroup || '相关人群'}，当前建议优先核实申报时间和申请材料后尽快办理。`,
    eligibility: [
      `身份场景：${policy.scenario || '未标注'}，请确认与你的画像一致`,
      `办理对象：${policy.targetGroup || '请以政策原文对象描述为准'}`,
      `申报时段：${status}`,
    ],
    disqualifiers: [
      '缺少必要证明材料（证件、社保、经营资质）',
      '不在政策适用地域或行业范围内',
      '超过政策申报截止时间',
    ],
    checklist: [
      '打开政策原文并确认最新口径',
      '整理身份证明/企业证明材料',
      '核实申报平台或线下窗口',
      '在截止日前提交并留存回执',
    ],
    riskTips: [
      '政策执行口径可能按年度或批次调整',
      '若关键条件待确认，建议先电话咨询受理窗口',
    ],
    profileSnapshot: profile,
  }
}

app.get('/api/health', async (_, res) => {
  let policyCount = 0
  try {
    policyCount = (await loadPolicies()).length
  } catch {
    policyCount = 0
  }
  res.json({
    ok: true,
    hasApiKey: Boolean(deepseekApiKey),
    version: appVersion,
    policyCount,
    policyCacheTtlMs,
    cacheLoadedAt: policyCacheAt || null,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  })
})

app.get('/api/policy-search', async (req, res) => {
  try {
    const query = String(req.query.q ?? '').trim()
    const province = String(req.query.province ?? '').trim()
    const limitRaw = Number(req.query.limit ?? 12)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(30, limitRaw)) : 12

    const policies = await loadPolicies()
    let filtered = policies
    if (province) {
      filtered = filtered.filter((item) => String(item.province ?? '').includes(province))
    }

    if (query) {
      filtered = filtered
        .map((item) => ({ item, score: policySearchScore(item, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.item)
    } else {
      filtered = filtered.sort((a, b) => String(b.publishDate ?? '').localeCompare(String(a.publishDate ?? '')))
    }

    const rows = filtered.slice(0, limit).map((item) => ({
      title: item.title ?? '未命名政策',
      url: item.url ?? '',
      province: item.province ?? '',
      publishDate: item.publishDate ?? '未知',
      deadlineHint: item.deadlineHint ?? '',
      contentSnippet: item.contentSnippet ?? '',
      content: item.content ?? '',
      source: item.source ?? '',
    }))

    res.json({
      total: filtered.length,
      rows,
      query,
      province,
    })
  } catch (error) {
    res.status(500).json({
      error: 'Policy search failed.',
      detail: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/match-policy', async (req, res) => {
  try {
    if (!deepseekApiKey) {
      res.status(400).json({
        error: 'Missing DEEPSEEK_API_KEY. Add it to .env first.',
      })
      return
    }

    const { profile, scenario = '全部', identity = 'citizen' } = req.body ?? {}
    if (!profile || typeof profile !== 'object') {
      res.status(400).json({ error: 'Invalid profile payload.' })
      return
    }

    const allPolicies = await loadPolicies()
    const payload = buildPromptPayload({
      profile,
      scenario,
      identity,
      policies: allPolicies,
    })

    const systemPrompt =
      '你是政策匹配助手。只能基于给定政策候选进行匹配，不要虚构政策。返回严格 JSON。'
    const userPrompt = `
请根据用户画像和身份场景，从 policy_candidates 中筛选最相关政策。
输出要求：
1) 只返回 JSON，不要解释。
2) match_level 只能是：完全符合、可能符合、需确认
3) confidence 在 0~1 之间
4) 最多返回 8 条，按相关性排序。
5) apply_start/apply_end 若无法确定，填 "未知"。

输入数据：
${JSON.stringify(payload, null, 2)}
`

    const llmResponse = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: deepseekModel,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    if (!llmResponse.ok) {
      const detail = await llmResponse.text()
      res.status(502).json({
        error: 'DeepSeek API request failed.',
        detail: detail.slice(0, 500),
      })
      return
    }

    const llmJson = await llmResponse.json()
    const content = llmJson?.choices?.[0]?.message?.content ?? ''
    const parsed = parseJsonFromLLM(content)

    if (!parsed || !Array.isArray(parsed.matched_policies)) {
      res.status(502).json({
        error: 'Failed to parse DeepSeek JSON output.',
        detail: content.slice(0, 500),
      })
      return
    }

    res.json({
      sourceCount: allPolicies.length,
      matched_policies: parsed.matched_policies,
    })
  } catch (error) {
    res.status(500).json({
      error: 'Server error during AI matching.',
      detail: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/policy-interpret', async (req, res) => {
  try {
    const { policy, profile = null } = req.body ?? {}
    if (!policy || typeof policy !== 'object') {
      res.status(400).json({ error: 'Invalid policy payload.' })
      return
    }

    if (!deepseekApiKey) {
      res.json({
        interpretation: buildLocalInterpretation(policy, profile),
        mode: 'fallback',
      })
      return
    }

    const systemPrompt =
      '你是政策解读助手，请将政策内容转写为通俗、可执行的办理说明。返回严格 JSON。'
    const userPrompt = `
请解读以下政策，输出 JSON 字段：
{
  "summary": "3句以内通俗总结",
  "eligibility": ["命中条件1","命中条件2","命中条件3"],
  "disqualifiers": ["常见不符合情况1","常见不符合情况2"],
  "checklist": ["办理步骤1","办理步骤2","办理步骤3"],
  "riskTips": ["风险提示1","风险提示2"]
}

政策信息：
${JSON.stringify(policy, null, 2)}

用户画像（可为空）：
${JSON.stringify(profile, null, 2)}
`

    const llmResponse = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: deepseekModel,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    if (!llmResponse.ok) {
      const detail = await llmResponse.text()
      res.status(502).json({
        error: 'DeepSeek policy interpretation failed.',
        detail: detail.slice(0, 500),
      })
      return
    }

    const llmJson = await llmResponse.json()
    const content = llmJson?.choices?.[0]?.message?.content ?? ''
    const parsed = parseJsonFromLLM(content)
    if (!parsed || typeof parsed !== 'object') {
      res.status(502).json({
        error: 'Failed to parse policy interpretation JSON.',
        detail: content.slice(0, 500),
      })
      return
    }

    res.json({ interpretation: parsed, mode: 'llm' })
  } catch (error) {
    res.status(500).json({
      error: 'Server error during policy interpretation.',
      detail: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

if (existsSync(distPath) && existsSync(indexHtmlPath)) {
  app.use(express.static(distPath))
  app.get(/^\/(?!api).*/, (_, res) => {
    res.sendFile(indexHtmlPath)
  })
} else {
  app.get('/', (_, res) => {
    res.json({
      ok: true,
      message: 'API server is running. Build frontend to serve web UI from this server.',
    })
  })
}

app.listen(port, () => {
  console.log(`Policy web/api server running on http://localhost:${port}`)
})
