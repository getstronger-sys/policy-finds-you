import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load } from 'cheerio'

const BASE_URL = 'https://www.beijing.gov.cn'
const DEFAULT_SEED_URLS = [
  'https://www.beijing.gov.cn/zhengce/',
  'https://www.beijing.gov.cn/zhengce/zhengcefagui/',
  'https://www.beijing.gov.cn/zhengce/zcjd/',
  'https://www.beijing.gov.cn/zhengce/zczt/',
  'https://www.beijing.gov.cn/so/zcdh/',
  'https://www.beijing.gov.cn/?database=bj&temp=bnwebzh',
]
const DEFAULT_MAX_ITEMS = 40
const DEFAULT_OUTPUT = 'data/knowledge/beijing-policies.json'
const DEFAULT_DISCOVER_LIMIT = 1200

function getArg(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((item) => item.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

function normalizeText(input) {
  return input.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim()
}

function toAbsoluteUrl(url) {
  if (!url || url.startsWith('javascript:') || url.startsWith('#')) {
    return null
  }
  try {
    return new URL(url, BASE_URL).toString()
  } catch {
    return null
  }
}

function extractDate(text) {
  const match = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (!match) return null
  const year = match[1]
  const month = match[2].padStart(2, '0')
  const day = match[3].padStart(2, '0')
  return `${year}-${month}-${day}`
}

function firstNonEmpty(...values) {
  for (const item of values) {
    if (item && item.trim()) {
      return normalizeText(item)
    }
  }
  return ''
}

function extractDeadlineLine(content) {
  const parts = content
    .split(/[。！？\n]/g)
    .map((item) => normalizeText(item))
    .filter(Boolean)
  return (
    parts.find((line) => /(截止|截至|申报时间|受理时间|报名时间|申报窗口)/.test(line)) ?? ''
  )
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'policy-finds-you-bot/0.1 (+educational-hackathon)',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  return response.text()
}

function collectCandidateLinks(html, seedUrl) {
  const $ = load(html)
  const links = new Set()
  $('a[href]').each((_, element) => {
    const raw = $(element).attr('href')
    const absolute = toAbsoluteUrl(raw)
    if (!absolute) return
    if (!absolute.startsWith(BASE_URL)) return
    if (!absolute.includes('/zhengce/')) return
    if (!/\.html?$/.test(absolute) && !absolute.endsWith('/')) return
    links.add(absolute)
  })
  if (seedUrl.includes('/zhengce/') && !seedUrl.endsWith('/')) {
    links.add(seedUrl)
  }
  return [...links]
}

async function discoverLinks(seedUrls, discoverLimit) {
  const visited = new Set()
  const discovered = new Set()
  const queue = [...seedUrls]
  let depth = 0
  const maxDepth = 2

  while (queue.length > 0 && discovered.size < discoverLimit && depth < maxDepth) {
    const currentBatch = [...queue]
    queue.length = 0
    depth += 1

    for (const url of currentBatch) {
      if (visited.has(url)) continue
      visited.add(url)
      try {
        const html = await fetchHtml(url)
        const links = collectCandidateLinks(html, url)
        for (const link of links) {
          if (!discovered.has(link)) {
            discovered.add(link)
          }
          if (!visited.has(link) && queue.length < discoverLimit) {
            queue.push(link)
          }
        }
        console.log(`[discover:d${depth}] ${url} -> +${links.length} links`)
      } catch (error) {
        console.warn(`[discover-skip] ${url} -> ${error.message}`)
      }
      if (discovered.size >= discoverLimit) {
        break
      }
    }
  }

  return [...discovered]
}

function parsePolicyPage(url, html) {
  const $ = load(html)
  const title = firstNonEmpty(
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="ArticleTitle"]').attr('content'),
    $('h1').first().text(),
    $('title').text(),
  )

  const dateText = firstNonEmpty(
    $('meta[name="PubDate"]').attr('content'),
    $('.pub_time').first().text(),
    $('.time').first().text(),
    $('.u_time').first().text(),
    $('body').text().slice(0, 2000),
  )
  const publishDate = extractDate(dateText)

  const mainText = firstNonEmpty(
    $('.TRS_Editor').text(),
    $('.TRS_UEDITOR').text(),
    $('.article').text(),
    $('.content').text(),
    $('.main').text(),
    $('article').text(),
    $('body').text(),
  )

  if (!title || !mainText) {
    return null
  }

  const content = normalizeText(mainText)
  if (content.length < 80) {
    return null
  }

  return {
    id: Buffer.from(url).toString('base64url').slice(0, 20),
    title,
    url,
    source: '北京市人民政府门户网站',
    publishDate,
    deadlineHint: extractDeadlineLine(content),
    contentSnippet: content.slice(0, 220),
    content,
    crawledAt: new Date().toISOString(),
  }
}

function shouldKeepRecord(policy) {
  const pathname = new URL(policy.url).pathname
  const isPortalTitle = policy.title.includes('_首都之窗_北京市人民政府门户网站')
  const isChannelPage = /\/$|\/index\.html?$/.test(pathname)
  if (isPortalTitle && isChannelPage) {
    return false
  }
  if (pathname.includes('/zhengce/mc/')) {
    return false
  }
  const titleLooksLikeKeyword = policy.title.length < 8
  const policyLikeTitle = /(通知|办法|意见|方案|细则|条例|规定|政策|解读|问答|补贴|申报|工作)/.test(
    policy.title,
  )
  const urlHasArticleDate = /\/20\d{2}\d{2}\/t20\d{6}_\d+\.html$/.test(policy.url)
  if (titleLooksLikeKeyword && !policyLikeTitle && !urlHasArticleDate) {
    return false
  }
  if (!policyLikeTitle && !urlHasArticleDate && !pathname.includes('/zcjd/')) {
    return false
  }
  if (!policy.publishDate && !urlHasArticleDate) {
    return false
  }
  return true
}

async function main() {
  const maxItems = Number(getArg('max', DEFAULT_MAX_ITEMS))
  const discoverLimit = Number(getArg('discover', DEFAULT_DISCOVER_LIMIT))
  const outputPath = resolve(getArg('out', DEFAULT_OUTPUT))
  const seedArg = getArg('seeds', '')
  const seedUrls = seedArg
    ? seedArg
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : DEFAULT_SEED_URLS

  const discovered = await discoverLinks(seedUrls, discoverLimit)
  const candidates = discovered.slice(0, Math.max(maxItems * 8, maxItems))
  console.log(`[discover] total candidates: ${discovered.length}`)

  const records = []
  const seenTitles = new Set()
  for (const url of candidates) {
    if (records.length >= maxItems) break
    try {
      const html = await fetchHtml(url)
      const policy = parsePolicyPage(url, html)
      if (!policy) continue
      if (!shouldKeepRecord(policy)) continue
      if (
        /(政策服务|政策法规|政策解读|首都之窗|更多|汇编)/.test(policy.title) &&
        policy.content.length < 300
      ) {
        continue
      }
      if (seenTitles.has(policy.title)) {
        continue
      }
      seenTitles.add(policy.title)
      records.push(policy)
      console.log(`[ok] ${records.length}/${maxItems} ${policy.title}`)
    } catch (error) {
      console.warn(`[skip] ${url} -> ${error.message}`)
    }
  }

  await mkdir(resolve(outputPath, '..'), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
  console.log(`\nDone. Saved ${records.length} records to: ${outputPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
