import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'

dotenv.config()

const app = express()
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8787)
function normalizeDeepSeekBaseUrl(rawUrl) {
  let url = String(rawUrl || 'https://api.deepseek.com').trim()
  url = url.replace(/\/anthropic\/?$/i, '')
  url = url.replace(/\/$/, '')
  if (!url) return 'https://api.deepseek.com'
  return url
}

const deepseekApiKey = String(process.env.DEEPSEEK_API_KEY ?? '').trim()
const deepseekModel = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const deepseekBaseUrl = normalizeDeepSeekBaseUrl(process.env.DEEPSEEK_BASE_URL)
const appVersion = process.env.APP_VERSION ?? '0.1.0'
const knowledgeDirPath = resolve('data/knowledge')
const distPath = resolve('dist')
const indexHtmlPath = resolve('dist/index.html')
const isProduction = process.env.NODE_ENV === 'production'
const startedAt = Date.now()
let policyCache = null
let policyCacheAt = 0
const policyCacheTtlMs = Number(process.env.KNOWLEDGE_CACHE_TTL_MS ?? 15000)
const govMetrics = {
  eventCount: 0,
  amountTotal: 0,
  provinceCount: new Map(),
  policyCount: new Map(),
  dailyCount: new Map(),
  eventHistory: [],
  questionHistory: [],
}

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

function getPolicyCandidateScore(item, context) {
  const title = String(item.title ?? '')
  const snippet = String(item.contentSnippet ?? '')
  const content = String(item.content ?? '')
  const province = String(item.province ?? '')
  const combined = `${title}\n${snippet}\n${content}\n${province}`.toLowerCase()
  let score = 0

  if (context.province) {
    const p = context.province.toLowerCase()
    if (province.toLowerCase().includes(p)) score += 12
    if (combined.includes(p)) score += 4
  }

  for (const token of context.tokens) {
    if (token.length < 2) continue
    if (title.toLowerCase().includes(token)) score += 8
    if (snippet.toLowerCase().includes(token)) score += 4
    if (content.toLowerCase().includes(token)) score += 2
    if (combined.includes(token)) score += 1
  }

  if (context.identity === 'company') {
    if (/企业|公司|法人|经营|税|创业|招商/.test(combined)) score += 3
  } else if (/个人|家庭|居民|人才|就业|生育|养老|社保/.test(combined)) {
    score += 3
  }
  return score
}

function toTokenList(input) {
  return String(input ?? '')
    .toLowerCase()
    .split(/[\s,，。;；、\/|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildMatchContext(profile, scenario, identity) {
  const p = profile ?? {}
  const tokenSource = [
    scenario,
    p.needPolicy,
    p.needPolicyDetail,
    p.personalDescription,
    p.companyIndustry,
    p.jobTitle,
    p.housingNeed,
    p.employmentStatus,
    p.familyTag,
    p.residence,
    p.workPlace,
  ]
    .filter(Boolean)
    .join(' ')
  const tokens = Array.from(new Set(toTokenList(tokenSource))).slice(0, 40)
  const province = String(p.residence || p.workPlace || '').trim()
  return {
    tokens,
    province,
    identity: identity === 'company' ? 'company' : 'citizen',
  }
}

function buildLocalMatchRows(candidates, scenario, identity) {
  return candidates.slice(0, 8).map((item, idx) => ({
    name: item.title ?? '未命名政策',
    match_level: idx < 3 ? '可能符合' : '需确认',
    target_group: identity === 'company' ? '相关企业主体' : '相关居民群体',
    scenario: scenario || '综合场景',
    reason: '基于地区与关键词命中进行智能检索，建议进一步核对申报条件。',
    benefit: item.contentSnippet ? String(item.contentSnippet).slice(0, 60) : '请查看政策原文',
    apply_start: item.publishDate ?? '未知',
    apply_end: item.deadlineHint ?? '未知',
    next_step: '点击查看政策详情并按材料清单准备申报。',
    source_url: item.url ?? '',
    confidence: Number((0.62 - idx * 0.04).toFixed(2)),
  }))
}

function buildPromptPayload({ profile, scenario, identity, policies }) {
  const compactPolicies = policies.slice(0, 80).map((item) => ({
    title: item.title,
    province: item.province ?? '',
    publishDate: toSafeDate(item.publishDate),
    deadlineHint: item.deadlineHint ?? '',
    contentSnippet: String(item.contentSnippet ?? '').slice(0, 120),
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

function deepseekKeyHint() {
  if (!deepseekApiKey) return { configured: false, length: 0, suffix: '' }
  return {
    configured: true,
    length: deepseekApiKey.length,
    suffix: deepseekApiKey.slice(-4),
    prefix: deepseekApiKey.slice(0, 3),
  }
}

async function probeDeepSeek() {
  if (!deepseekApiKey) {
    return { ok: false, reason: 'missing_key' }
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    const llmResponse = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: deepseekModel,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    clearTimeout(timer)
    const detail = await llmResponse.text()
    return {
      ok: llmResponse.ok,
      httpStatus: llmResponse.status,
      detail: detail.slice(0, 500),
      error: llmResponse.ok ? null : mapDeepSeekError(detail),
    }
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      detail: '',
      error: error instanceof Error ? error.message : 'Unknown fetch error',
    }
  }
}

function mapDeepSeekError(detailText) {
  const detail = String(detailText || '')
  try {
    const parsed = JSON.parse(detail)
    const message = String(parsed?.error?.message || parsed?.message || '')
    if (message.includes('Insufficient Balance') || message.includes('余额')) {
      return 'DeepSeek 账户余额不足，请在 Render 环境变量更新有效 API Key 并重新部署。'
    }
    if (message.includes('Authentication') || message.includes('invalid')) {
      return 'DeepSeek API Key 无效，请检查 Render 中 DEEPSEEK_API_KEY 是否正确。'
    }
    if (message) return message
  } catch {
    // ignore parse errors
  }
  if (detail.includes('Insufficient Balance')) {
    return 'DeepSeek 账户余额不足，请在 Render 环境变量更新有效 API Key 并重新部署。'
  }
  return 'DeepSeek 政策解读调用失败，请稍后重试。'
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

function increaseMapCount(map, key, delta = 1) {
  const normalized = String(key || '未标注').trim() || '未标注'
  map.set(normalized, (map.get(normalized) ?? 0) + delta)
}

function buildLocalChatReply(question, profile, province, profileSummary) {
  const text = String(question || '').trim()
  const summary = String(profileSummary || '').trim()
  const region = province || profile?.residence || profile?.workPlace || ''

  if (!text) return '你可以告诉我你的地区、身份和想办的事，我会给你下一步建议。'

  if (
    text.includes('读取') ||
    text.includes('能读') ||
    text.includes('看到') ||
    ((text.includes('填') || text.includes('写')) && (text.includes('信息') || text.includes('资料') || text.includes('画像')))
  ) {
    if (!summary) {
      return '可以读取你在左侧「用户画像」里填写的内容。目前还没检测到有效字段，建议先补全地区、年龄、就业状态等。'
    }
    const regionHint = region ? `已选地区：${region}。` : ''
    return `可以，我已读取你当前画像：${summary}。${regionHint}你可以继续问具体政策或办理问题。`
  }

  const mentionsBeijing = text.includes('北京')
  const mentionsHefei = text.includes('合肥') || region.includes('合肥') || profile?.workPlace?.includes('合肥')
  if (mentionsHefei && (mentionsBeijing || text.includes('去') || text.includes('转'))) {
    const target = mentionsBeijing ? '北京' : '目标城市'
    const from = profile?.workPlace || region || '合肥'
    return `你在${from}工作、想去${target}发展，建议先确认：①${target}就业/落户政策；②社保公积金转移；③补贴申领地规则。可在本平台匹配${target}相关政策。`
  }

  if (text.includes('社保')) {
    const months = profile?.socialSecurityMonths
    return months
      ? `你已填写社保 ${months}。跨地区就业时记得办理社保转移，并查询就业地人才、租房、补贴类政策。`
      : '建议先确认社保连续缴纳月数，并优先查询就业/人才/租房相关政策。'
  }
  if (text.includes('补贴')) return '补贴类政策通常有申报窗口和截止时间。结合你的画像，可在平台里直接匹配相关政策。'
  if (text.includes('电话')) return '可先查看政策卡片上的官方咨询电话，或政策原文受理部门电话。'
  if (summary) {
    return `结合你当前画像（${summary}），建议先在平台完成政策匹配，再把想办的具体事项告诉我（如落户、租房补贴）。`
  }
  return '我已收到你的问题。请先在左侧补全地区、身份和就业/家庭信息，或直接说你想办的具体事项。'
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
    keyHint: deepseekKeyHint(),
    version: appVersion,
    policyCount,
    policyCacheTtlMs,
    cacheLoadedAt: policyCacheAt || null,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  })
})

app.get('/api/deepseek-probe', async (_, res) => {
  const probe = await probeDeepSeek()
  res.json({
    ...probe,
    keyHint: deepseekKeyHint(),
    model: deepseekModel,
    baseUrl: deepseekBaseUrl,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  })
})

app.post('/api/gov-track', (req, res) => {
  const body = req.body ?? {}
  const province = String(body.province ?? '未标注')
  const policyTitle = String(body.policyTitle ?? '未标注政策').slice(0, 30)
  const userName = String(body.userName ?? '匿名用户').slice(0, 30)
  const amountEstimateRaw = Number(body.amountEstimate ?? 0)
  const amountEstimate = Number.isFinite(amountEstimateRaw) ? Math.max(amountEstimateRaw, 0) : 0
  const date = new Date().toISOString().slice(0, 10)

  govMetrics.eventCount += 1
  govMetrics.amountTotal += amountEstimate
  increaseMapCount(govMetrics.provinceCount, province)
  increaseMapCount(govMetrics.policyCount, policyTitle)
  increaseMapCount(govMetrics.dailyCount, date)
  govMetrics.eventHistory.push({
    date,
    province,
    userName,
    policyTitle,
    amountEstimate,
  })
  if (govMetrics.eventHistory.length > 5000) {
    govMetrics.eventHistory.splice(0, govMetrics.eventHistory.length - 5000)
  }

  res.json({ ok: true })
})

app.get('/api/gov-metrics', (req, res) => {
  const startDate = String(req.query.startDate ?? '')
  const endDate = String(req.query.endDate ?? '')
  const hasRange = Boolean(startDate && endDate)
  const events = hasRange
    ? govMetrics.eventHistory.filter((item) => item.date >= startDate && item.date <= endDate)
    : govMetrics.eventHistory
  const questions = hasRange
    ? govMetrics.questionHistory.filter((item) => item.date >= startDate && item.date <= endDate)
    : govMetrics.questionHistory

  const provinceMap = new Map()
  const policyMap = new Map()
  const dailyMap = new Map()
  const questionMap = new Map()
  const activeUsers = new Set()
  const feedbackUsers = new Set()
  let amountTotal = 0
  for (const event of events) {
    increaseMapCount(provinceMap, event.province)
    increaseMapCount(policyMap, event.policyTitle)
    increaseMapCount(dailyMap, event.date)
    activeUsers.add(event.userName || '匿名用户')
    amountTotal += Number(event.amountEstimate) || 0
  }
  for (const item of questions) {
    increaseMapCount(questionMap, item.question)
    feedbackUsers.add(item.userName || '匿名用户')
  }

  const provinceTop = Array.from(provinceMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
  const policyTop = Array.from(policyMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
  const dailyTrend = Array.from(dailyMap.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const questionTop = Array.from(questionMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
  const questionTotal = Array.from(questionMap.values()).reduce((sum, n) => sum + n, 0)
  const activeUserCount = activeUsers.size
  const feedbackUserCount = feedbackUsers.size
  const feedbackReachRate = activeUserCount > 0 ? Math.round((feedbackUserCount / activeUserCount) * 100) : 0
  res.json({
    totalEvents: events.length,
    amountTotal,
    activeUserCount,
    feedbackUserCount,
    feedbackReachRate,
    questionTotal,
    provinceTop,
    policyTop,
    dailyTrend,
    questionTop,
    startDate: hasRange ? startDate : null,
    endDate: hasRange ? endDate : null,
  })
})

app.post('/api/policy-chat', async (req, res) => {
  try {
    const question = String(req.body?.question ?? '').trim()
    const province = String(req.body?.province ?? '全国')
    const userName = String(req.body?.userName ?? '匿名用户')
    const profile = req.body?.profile ?? null
    const profileSummary = String(req.body?.profileSummary ?? '').trim()
    if (!question) {
      res.status(400).json({ error: '问题不能为空。' })
      return
    }
    const date = new Date().toISOString().slice(0, 10)
    govMetrics.questionHistory.push({
      date,
      province,
      userName,
      question: question.slice(0, 80),
    })
    if (govMetrics.questionHistory.length > 5000) {
      govMetrics.questionHistory.splice(0, govMetrics.questionHistory.length - 5000)
    }

    const localAnswer = () => buildLocalChatReply(question, profile, province, profileSummary)

    if (!deepseekApiKey) {
      res.json({ answer: localAnswer(), mode: 'fallback' })
      return
    }

    const profileJson = profile ? JSON.stringify(profile) : '{}'
    const userPrompt = `用户问题：${question}
当前地区：${province}
用户画像摘要：${profileSummary || '（尚未填写）'}
用户画像详情：${profileJson}
请结合用户已填信息作答。若用户问能否读取信息，请明确列出已读取字段。回答简洁中文，不超过150字。`
    const llmResponse = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: deepseekModel,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: '你是政务政策咨询助手。必须结合用户画像作答，不要重复同一句套话，回答清晰、简洁、可执行。',
          },
          { role: 'user', content: userPrompt },
        ],
      }),
    })
    if (!llmResponse.ok) {
      res.json({ answer: localAnswer(), mode: 'fallback', error: 'DeepSeek unavailable' })
      return
    }
    const llmJson = await llmResponse.json()
    const answer = String(llmJson?.choices?.[0]?.message?.content ?? '').trim()
    res.json({ answer: answer || localAnswer(), mode: 'llm' })
  } catch (error) {
    res.status(500).json({
      error: '政策AI对话服务异常。',
      detail: error instanceof Error ? error.message : 'Unknown error',
    })
  }
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
    const { profile, scenario = '全部', identity = 'citizen' } = req.body ?? {}
    if (!profile || typeof profile !== 'object') {
      res.status(400).json({ error: 'Invalid profile payload.' })
      return
    }

    const allPolicies = await loadPolicies()
    const matchContext = buildMatchContext(profile, scenario, identity)
    const rankedCandidates = allPolicies
      .map((item) => ({
        item,
        score: getPolicyCandidateScore(item, matchContext),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
    const selectedCandidates = rankedCandidates.slice(0, 80)
    const payload = buildPromptPayload({
      profile,
      scenario,
      identity,
      policies: selectedCandidates,
    })

    if (!deepseekApiKey) {
      res.json({
        sourceCount: allPolicies.length,
        matched_policies: buildLocalMatchRows(selectedCandidates, scenario, identity),
        mode: 'fallback',
        error: 'Missing DEEPSEEK_API_KEY. Using local matcher.',
      })
      return
    }

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
      res.json({
        sourceCount: allPolicies.length,
        matched_policies: buildLocalMatchRows(selectedCandidates, scenario, identity),
        mode: 'fallback',
        error: 'DeepSeek API request failed.',
        detail: detail.slice(0, 500),
      })
      return
    }

    const llmJson = await llmResponse.json()
    const content = llmJson?.choices?.[0]?.message?.content ?? ''
    const parsed = parseJsonFromLLM(content)

    if (!parsed || !Array.isArray(parsed.matched_policies)) {
      res.json({
        sourceCount: allPolicies.length,
        matched_policies: buildLocalMatchRows(selectedCandidates, scenario, identity),
        mode: 'fallback',
        detail: 'Failed to parse DeepSeek JSON output.',
      })
      return
    }

    const rows = parsed.matched_policies.filter((item) => item && typeof item === 'object')
    const safeRows = rows.length > 0 ? rows : buildLocalMatchRows(selectedCandidates, scenario, identity)
    res.json({
      sourceCount: allPolicies.length,
      matched_policies: safeRows,
      mode: rows.length > 0 ? 'llm' : 'fallback',
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
      res.status(400).json({
        error: '未配置 DEEPSEEK_API_KEY，请在 Render 环境变量设置后重新部署。',
      })
      return
    }

    const systemPrompt =
      '你是政策解读助手，请将政策内容转写为通俗、可执行的办理说明。只返回 JSON 对象，不要输出其它文字。'
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
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    if (!llmResponse.ok) {
      const detail = await llmResponse.text()
      res.status(502).json({
        error: mapDeepSeekError(detail),
        detail: detail.slice(0, 500),
        httpStatus: llmResponse.status,
        keyHint: deepseekKeyHint(),
      })
      return
    }

    const llmJson = await llmResponse.json()
    const content = llmJson?.choices?.[0]?.message?.content ?? ''
    const parsed = parseJsonFromLLM(content)
    if (!parsed || typeof parsed !== 'object') {
      res.status(502).json({
        error: '政策解读结果解析失败，请重试。',
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
