import { useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts'
import QRCode from 'qrcode'
import './App.css'

type Identity = 'citizen' | 'company'
type Step = 'map' | 'profile' | 'result'
type AuthMode = 'wechat' | 'guest'
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() ?? ''
const SESSION_STORAGE_KEY = 'policy-finds-you.session'
const DRAFT_STORAGE_KEY = 'policy-finds-you.draft'

interface PolicyCard {
  name: string
  matchLevel: '完全符合' | '可能符合' | '需确认'
  audience: Identity | 'both'
  scenario: string
  targetGroup: string
  benefit: string
  reason: string
  applyStart: string
  applyEnd: string
  nextStep: string
  sourceUrl?: string
  confidence?: number
}

interface UserProfile {
  identity: Identity
  age: string
  gender: string
  birthPlace: string
  hukou: string
  residence: string
  workPlace: string
  hasSecondChild: boolean
  annualIncome: string
  freeText: string
}

interface PolicyInterpretation {
  summary: string
  eligibility: string[]
  disqualifiers: string[]
  checklist: string[]
  riskTips: string[]
}

interface UserSession {
  mode: AuthMode
  displayName: string
  savedAt: string
}

interface AppDraft {
  step: Step
  selectedProvince: string
  selectedScenario: string
  profile: UserProfile
}

interface KnowledgePolicy {
  title: string
  url: string
  province: string
  publishDate: string
  deadlineHint: string
  contentSnippet: string
  content: string
  source: string
}

interface DailyUpdateBrief {
  dateText: string
  policyCount: number
  delta: number | null
}

function summarizeAudience(title: string, profile: UserProfile) {
  if (title.includes('企业') || title.includes('营商') || title.includes('税')) {
    return '企业主体、个体工商户及经营单位'
  }
  if (title.includes('人才')) {
    return '人才、引进人员及相关单位'
  }
  return profile.identity === 'citizen' ? '普通公民与相关家庭群体' : '企业或法人主体'
}

interface ReviewInputs {
  socialSecurityMonths: string
  familyTag: string
  enterpriseType: string
}

interface EligibilityCheck {
  key: string
  label: string
  status: 'pass' | 'missing' | 'risk'
  detail: string
  options?: string[]
}

function getCheckStatusText(status: EligibilityCheck['status']) {
  if (status === 'pass') return '已满足'
  if (status === 'risk') return '需核验'
  return '待补充'
}

function buildFriendlyPolicyMessage(title: string, snippet: string) {
  const text = `${title} ${snippet}`.replace(/\s+/g, ' ')
  if (text.includes('人才')) return '重点是帮符合条件的人才降低就业和安居成本，尽早申报更稳妥。'
  if (text.includes('补贴')) return '这类政策通常有明确受理窗口，符合条件就能拿到实实在在的补贴。'
  if (text.includes('企业') || text.includes('营商')) return '这条政策主要在给企业减负增效，越早申报越容易赶上窗口期。'
  if (text.includes('住房')) return '这条政策和住房支持有关，建议优先确认资格和申报时间。'
  return '这条政策与你当前身份和地区相关，建议按步骤准备材料并尽快办理。'
}

function buildEligibilityAnalysis(
  profile: UserProfile,
  selectedProvince: string,
  reviewInputs: ReviewInputs,
): EligibilityCheck[] {
  if (profile.identity === 'company') {
    return [
      {
        key: 'company-location',
        label: '注册地/经营地',
        status: profile.workPlace ? 'pass' : 'missing',
        detail: profile.workPlace || '缺少企业注册地或经营地信息',
        options: !profile.workPlace && selectedProvince ? [selectedProvince, `${selectedProvince}本地`] : undefined,
      },
      {
        key: 'enterprise-type',
        label: '企业类型',
        status: reviewInputs.enterpriseType ? 'pass' : 'missing',
        detail: reviewInputs.enterpriseType || '请确认企业是否为小微/高新/科技型主体',
        options: !reviewInputs.enterpriseType ? ['小微企业', '高新技术企业', '科技型中小企业'] : undefined,
      },
      {
        key: 'tax-or-income',
        label: '税务/营收信息',
        status: profile.annualIncome ? 'pass' : 'missing',
        detail: profile.annualIncome || '缺少纳税或营收区间信息',
        options: !profile.annualIncome ? ['0-100万', '100-500万', '500万以上'] : undefined,
      },
    ]
  }

  const age = Number(profile.age)
  const ageStatus: EligibilityCheck['status'] = profile.age ? (age >= 18 ? 'pass' : 'risk') : 'missing'
  return [
    {
      key: 'age',
      label: '年龄条件',
      status: ageStatus,
      detail: !profile.age ? '缺少年龄信息' : age >= 18 ? `当前年龄 ${profile.age}` : `当前年龄 ${profile.age}，需确认政策是否允许未成年人申领`,
      options: !profile.age ? ['18-24', '25-35', '36-50', '50+'] : undefined,
    },
    {
      key: 'hukou-or-residence',
      label: '户籍/常住地',
      status: profile.hukou || profile.residence ? 'pass' : 'missing',
      detail: profile.hukou || profile.residence || '缺少户籍或常住地信息',
      options: !(profile.hukou || profile.residence) && selectedProvince ? [`${selectedProvince}户籍`, `${selectedProvince}常住`] : undefined,
    },
    {
      key: 'social-security',
      label: '社保连续缴纳',
      status: reviewInputs.socialSecurityMonths ? 'pass' : 'missing',
      detail: reviewInputs.socialSecurityMonths
        ? `已补充：连续缴纳 ${reviewInputs.socialSecurityMonths}`
        : '缺少社保连续缴纳月数信息',
      options: !reviewInputs.socialSecurityMonths ? ['6个月', '12个月', '24个月'] : undefined,
    },
    {
      key: 'family-condition',
      label: '家庭情况',
      status: profile.hasSecondChild || reviewInputs.familyTag ? 'pass' : 'missing',
      detail:
        profile.hasSecondChild || reviewInputs.familyTag
          ? profile.hasSecondChild
            ? '已识别：二孩家庭'
            : `已补充：${reviewInputs.familyTag}`
          : '缺少家庭情况标签（如二孩/养老/残疾家庭）',
      options: !(profile.hasSecondChild || reviewInputs.familyTag) ? ['二孩家庭', '赡养老人', '残疾家庭成员'] : undefined,
    },
  ]
}

function buildApplicationSteps(isCompany: boolean) {
  if (isCompany) {
    return [
      { title: '资格核验', desc: '确认企业类型、注册地、行业是否命中政策。' },
      { title: '材料准备', desc: '准备营业执照、税务证明、项目佐证材料。' },
      { title: '系统申报', desc: '在政务平台填报并上传材料，提交回执。' },
      { title: '审核兑付', desc: '关注审核节点，按通知补件并完成兑付。' },
    ]
  }
  return [
    { title: '资格核验', desc: '核对年龄、户籍、社保及家庭条件是否满足。' },
    { title: '材料准备', desc: '准备身份证明、关系证明、社保或收入证明。' },
    { title: '提交申请', desc: '线上填报或窗口提交，确保信息完整准确。' },
    { title: '进度跟踪', desc: '按通知补件/查询审核结果，通过后领取权益。' },
  ]
}

function policyPriorityScore(checks: EligibilityCheck[]) {
  const passCount = checks.filter((item) => item.status === 'pass').length
  const riskCount = checks.filter((item) => item.status === 'risk').length
  const total = Math.max(checks.length, 1)
  const score = Math.round((passCount / total) * 80 + 20 - riskCount * 8)
  return Math.max(20, Math.min(98, score))
}

function getBenefitPreview(policy: KnowledgePolicy) {
  if (policy.deadlineHint?.trim()) return policy.deadlineHint
  const snippet = policy.contentSnippet?.trim() || ''
  if (!snippet) return '请以政策原文公布的补贴标准和支持范围为准。'
  return snippet.slice(0, 56)
}

function buildMaterialList(isCompany: boolean) {
  if (isCompany) {
    return [
      { name: '营业执照副本', url: 'https://gjzwfw.www.gov.cn/', tip: '企业基础主体证明' },
      { name: '纳税/社保缴纳证明', url: 'https://etax.chinatax.gov.cn/', tip: '用于核验经营与缴费情况' },
      { name: '项目实施或费用凭证', url: 'https://www.gov.cn/', tip: '用于证明政策适配场景' },
    ]
  }
  return [
    { name: '身份证明（身份证/户口本）', url: 'https://gjzwfw.www.gov.cn/', tip: '个人主体信息材料' },
    { name: '关系证明（婚育/家庭）', url: 'https://www.mca.gov.cn/', tip: '二孩、家庭类政策常需材料' },
    { name: '社保或收入证明', url: 'https://si.12333.gov.cn/', tip: '就业、补贴政策常用核验材料' },
  ]
}

async function readApiJson(response: Response) {
  const raw = await response.text()
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, any>
  } catch {
    const compact = raw.replace(/\s+/g, ' ').slice(0, 120)
    throw new Error(`接口返回非 JSON（HTTP ${response.status}）：${compact}`)
  }
}

const basePolicies: PolicyCard[] = [
  {
    name: '二孩家庭育儿补贴',
    matchLevel: '完全符合',
    audience: 'citizen',
    scenario: '婚育',
    targetGroup: '普通公民 · 二孩家庭',
    benefit: '一次性补贴 3000 元',
    reason: '家庭信息中存在二孩标签，满足家庭生育支持条件。',
    applyStart: '2026-01-01',
    applyEnd: '2026-12-31',
    nextStep: '准备出生证明和户口簿，前往街道政务服务中心申请。',
  },
  {
    name: '女职工生育津贴',
    matchLevel: '可能符合',
    audience: 'citizen',
    scenario: '就业',
    targetGroup: '普通公民 · 在职女性',
    benefit: '按当地平均工资核算津贴',
    reason: '画像中有在职与女性信息，仍需补充社保连续缴纳证明。',
    applyStart: '2026-02-01',
    applyEnd: '2026-10-31',
    nextStep: '查询社保缴费月份，在线提交生育津贴申请。',
  },
  {
    name: '人才购房补贴',
    matchLevel: '需确认',
    audience: 'citizen',
    scenario: '住房',
    targetGroup: '普通公民 · 引进人才',
    benefit: '最高可申领 100000 元',
    reason: '工作地与居住地命中重点引才区域，需确认居住证年限。',
    applyStart: '2026-03-15',
    applyEnd: '2026-07-31',
    nextStep: '先确认居住证满 1 年，再去人才服务窗口提交材料。',
  },
  {
    name: '小微企业所得税减免',
    matchLevel: '完全符合',
    audience: 'company',
    scenario: '税费减免',
    targetGroup: '法人企业 · 小微主体',
    benefit: '减按 20% 税率缴纳企业所得税',
    reason: '企业身份命中小微企业税收优惠政策范围。',
    applyStart: '2026-01-01',
    applyEnd: '2026-12-31',
    nextStep: '在电子税务局完成企业所得税年度汇算时申报优惠。',
  },
  {
    name: '科技型中小企业研发费用加计扣除',
    matchLevel: '可能符合',
    audience: 'company',
    scenario: '科技创新',
    targetGroup: '法人企业 · 科技型企业',
    benefit: '研发费用按规定比例税前加计扣除',
    reason: '企业画像含技术创新特征，需补充科技型企业评价入库信息。',
    applyStart: '2026-01-01',
    applyEnd: '2026-12-31',
    nextStep: '先完成科技型中小企业评价入库，再在税务申报时享受政策。',
  },
  {
    name: '重点产业人才引进补贴',
    matchLevel: '需确认',
    audience: 'company',
    scenario: '人才引进',
    targetGroup: '法人企业 · 重点产业用人单位',
    benefit: '按人才层级给予用人单位配套补贴',
    reason: '企业在重点产业目录内，需确认岗位与人才层级匹配。',
    applyStart: '2026-04-01',
    applyEnd: '2026-09-30',
    nextStep: '整理劳动合同与社保记录，向区级人才服务窗口提交申请。',
  },
]

const scenariosByIdentity: Record<Identity, string[]> = {
  citizen: ['全部', '婚育', '就业', '住房', '养老', '教育'],
  company: ['全部', '初创支持', '科技创新', '税费减免', '人才引进', '融资服务'],
}

function getPolicyStatus(applyStart: string, applyEnd: string) {
  const now = Date.now()
  const start = new Date(applyStart).getTime()
  const end = new Date(applyEnd).getTime()
  if (now < start) {
    return '未开始'
  }
  if (now > end) {
    return '已截止'
  }
  const days = Math.ceil((end - now) / (24 * 60 * 60 * 1000))
  if (days <= 7) {
    return `即将截止 · 剩余 ${days} 天`
  }
  return '申报中'
}

function getPolicyAlarmText(applyStart: string, applyEnd: string) {
  if (
    !applyStart ||
    !applyEnd ||
    applyStart === '未知' ||
    applyEnd === '未知' ||
    Number.isNaN(new Date(applyStart).getTime()) ||
    Number.isNaN(new Date(applyEnd).getTime())
  ) {
    return '政策闹钟：有效期待确认，请查看政策原文或咨询办理窗口'
  }

  const now = Date.now()
  const start = new Date(applyStart).getTime()
  const end = new Date(applyEnd).getTime()

  if (now < start) {
    const daysUntilStart = Math.ceil((start - now) / (24 * 60 * 60 * 1000))
    return `政策闹钟：${applyStart} 开始受理，距开始还有 ${daysUntilStart} 天`
  }

  if (now > end) {
    return `政策闹钟：本政策已于 ${applyEnd} 截止`
  }

  const daysLeft = Math.ceil((end - now) / (24 * 60 * 60 * 1000))
  return `政策闹钟：当前申报中（${applyStart} 至 ${applyEnd}），剩余 ${daysLeft} 天`
}

function App() {
  const [session, setSession] = useState<UserSession | null>(null)
  const [nicknameInput, setNicknameInput] = useState('')
  const [showLoginPopup, setShowLoginPopup] = useState(true)
  const [showDailyBrief, setShowDailyBrief] = useState(false)
  const [dailyBrief, setDailyBrief] = useState<DailyUpdateBrief | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [step, setStep] = useState<Step>('map')
  const [mapReady, setMapReady] = useState(false)
  const [selectedProvince, setSelectedProvince] = useState('')
  const [profile, setProfile] = useState<UserProfile>({
    identity: 'citizen',
    age: '',
    gender: '女',
    birthPlace: '',
    hukou: '',
    residence: '',
    workPlace: '',
    hasSecondChild: false,
    annualIncome: '',
    freeText: '',
  })
  const [selectedScenario, setSelectedScenario] = useState('全部')
  const [aiMatchedPolicies, setAiMatchedPolicies] = useState<PolicyCard[] | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiSourceCount, setAiSourceCount] = useState<number | null>(null)
  const [selectedPolicy, setSelectedPolicy] = useState<PolicyCard | null>(null)
  const [policyInterpretation, setPolicyInterpretation] = useState<PolicyInterpretation | null>(null)
  const [interpretLoading, setInterpretLoading] = useState(false)
  const [interpretError, setInterpretError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchResults, setSearchResults] = useState<KnowledgePolicy[]>([])
  const [searchHint, setSearchHint] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const [selectedKnowledgePolicy, setSelectedKnowledgePolicy] = useState<KnowledgePolicy | null>(null)
  const [reviewInputs, setReviewInputs] = useState<ReviewInputs>({
    socialSecurityMonths: '',
    familyTag: '',
    enterpriseType: '',
  })
  const [qrPolicy, setQrPolicy] = useState<PolicyCard | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState('')

  useEffect(() => {
    const loadMap = async () => {
      const response = await fetch('/data/china.geo.json')
      const geoJson = await response.json()
      echarts.registerMap('china', geoJson)
      setMapReady(true)
    }
    void loadMap()
  }, [])

  useEffect(() => {
    try {
      const rawSession = localStorage.getItem(SESSION_STORAGE_KEY)
      if (rawSession) {
        const parsedSession = JSON.parse(rawSession) as UserSession
        if (parsedSession?.displayName) {
          setSession(parsedSession)
        }
      }

      const rawDraft = localStorage.getItem(DRAFT_STORAGE_KEY)
      if (rawDraft) {
        const parsedDraft = JSON.parse(rawDraft) as Partial<AppDraft>
        if (parsedDraft.selectedProvince) {
          setSelectedProvince(parsedDraft.selectedProvince)
        }
        if (parsedDraft.selectedScenario) {
          setSelectedScenario(parsedDraft.selectedScenario)
        }
        if (parsedDraft.step) {
          setStep(parsedDraft.step)
        }
        if (parsedDraft.profile) {
          setProfile((prev) => ({
            ...prev,
            ...parsedDraft.profile,
          }))
        }
      }
    } catch (error) {
      console.warn('Failed to restore local session', error)
    } finally {
      setIsHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (!isHydrated || !session) {
      return
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  }, [isHydrated, session])

  useEffect(() => {
    if (!isHydrated || !session) {
      return
    }
    const draft: AppDraft = {
      step,
      selectedProvince,
      selectedScenario,
      profile,
    }
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
  }, [isHydrated, profile, selectedProvince, selectedScenario, session, step])

  useEffect(() => {
    if (session) {
      setShowLoginPopup(false)
    }
  }, [session])

  useEffect(() => {
    if (!session) {
      return
    }
    const loadDailyBrief = async () => {
      try {
        const apiUrl = API_BASE_URL ? `${API_BASE_URL}/api/health` : '/api/health'
        const response = await fetch(apiUrl)
        const data = await readApiJson(response)
        if (!response.ok || typeof data?.policyCount !== 'number') return

        const today = new Date().toISOString().slice(0, 10)
        const storageKey = 'policy-finds-you.daily-brief'
        const raw = localStorage.getItem(storageKey)
        const prev = raw ? (JSON.parse(raw) as { lastSeenDate?: string; lastPolicyCount?: number }) : {}
        const shouldShow = prev?.lastSeenDate !== today
        const prevCount = typeof prev?.lastPolicyCount === 'number' ? prev.lastPolicyCount : null
        const delta = prevCount === null ? null : data.policyCount - prevCount

        if (shouldShow) {
          setDailyBrief({
            dateText: today,
            policyCount: data.policyCount,
            delta,
          })
          setShowDailyBrief(true)
        }
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            lastSeenDate: today,
            lastPolicyCount: data.policyCount,
          }),
        )
      } catch {
        // keep silent for daily brief
      }
    }
    void loadDailyBrief()
  }, [session])

  const mapOption = useMemo(
    () => ({
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'map',
          map: 'china',
          roam: true,
          selectedMode: 'single',
          emphasis: {
            label: { color: '#111827' },
            itemStyle: { areaColor: '#93c5fd' },
          },
          itemStyle: {
            areaColor: '#e5e7eb',
            borderColor: '#9ca3af',
          },
          select: {
            label: { color: '#1d4ed8', fontWeight: 'bold' },
            itemStyle: { areaColor: '#bfdbfe' },
          },
        },
      ],
    }),
    [],
  )

  const matchedPolicies = useMemo(() => {
    return basePolicies.filter((item) => {
      if (item.audience !== 'both' && item.audience !== profile.identity) {
        return false
      }
      if (selectedScenario !== '全部' && item.scenario !== selectedScenario) {
        return false
      }
      if (item.name.includes('二孩') && !profile.hasSecondChild) {
        return false
      }
      return true
    })
  }, [profile.hasSecondChild, profile.identity, selectedScenario])
  const displayPolicies = aiMatchedPolicies ?? matchedPolicies
  const unlockedPolicyCount = Math.min(displayPolicies.length, 10)
  const extraDiscoverableCount = profile.birthPlace.trim() ? 0 : 2
  const unlockHintText =
    extraDiscoverableCount > 0
      ? `你已解锁 ${unlockedPolicyCount}/10 项专属政策，补充出生地可再发现 ${extraDiscoverableCount} 项`
      : `你已解锁 ${unlockedPolicyCount}/10 项专属政策`
  const guessedKeywords = useMemo(() => {
    const keywords: string[] = []
    if (selectedProvince) {
      keywords.push(`${selectedProvince} 补贴`)
      keywords.push(`${selectedProvince} 人才`)
    }
    if (profile.identity === 'citizen') {
      keywords.push('就业创业支持')
      keywords.push('住房与教育')
    } else {
      keywords.push('税费减免')
      keywords.push('科技创新扶持')
    }
    if (profile.hasSecondChild) {
      keywords.push('生育与托育补贴')
    }
    return Array.from(new Set(keywords)).slice(0, 6)
  }, [profile.hasSecondChild, profile.identity, selectedProvince])
  const eligibilityChecks = useMemo(() => {
    if (!selectedKnowledgePolicy && !selectedPolicy) return []
    return buildEligibilityAnalysis(profile, selectedProvince, reviewInputs)
  }, [profile, reviewInputs, selectedKnowledgePolicy, selectedPolicy, selectedProvince])
  const checkScore = useMemo(() => policyPriorityScore(eligibilityChecks), [eligibilityChecks])
  const passCount = useMemo(
    () => eligibilityChecks.filter((item) => item.status === 'pass').length,
    [eligibilityChecks],
  )
  const missingCount = useMemo(
    () => eligibilityChecks.filter((item) => item.status !== 'pass').length,
    [eligibilityChecks],
  )
  const materialList = useMemo(
    () => buildMaterialList(profile.identity === 'company'),
    [profile.identity],
  )

  const handleProvinceSelect = (province: string) => {
    setSelectedProvince(province)
  }

  const handleNextFromMap = () => {
    if (!selectedProvince) {
      return
    }
    setProfile((prev) => ({
      ...prev,
      hukou: prev.hukou || selectedProvince,
      residence: selectedProvince,
      workPlace: prev.workPlace || selectedProvince,
    }))
    setStep('profile')
  }

  const handleQuickLogin = (mode: AuthMode) => {
    const defaultName = mode === 'wechat' ? '微信用户' : '游客'
    const displayName = nicknameInput.trim() || defaultName
    setSession({
      mode,
      displayName,
      savedAt: new Date().toISOString(),
    })
  }

  const handleLogout = () => {
    setSession(null)
    setNicknameInput('')
    setAiMatchedPolicies(null)
    setSelectedPolicy(null)
    setPolicyInterpretation(null)
    setQrPolicy(null)
    setSearchResults([])
    setSearchQuery('')
    setSearchHint('')
    setHasSearched(false)
    setSelectedKnowledgePolicy(null)
    setReviewInputs({ socialSecurityMonths: '', familyTag: '', enterpriseType: '' })
    setShowLoginPopup(true)
    localStorage.removeItem(SESSION_STORAGE_KEY)
  }

  const handleProfileSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAiMatchedPolicies(null)
    setAiError('')
    setAiSourceCount(null)
    setStep('result')
  }

  const runAiMatch = async () => {
    setAiLoading(true)
    setAiError('')
    try {
      const apiUrl = API_BASE_URL ? `${API_BASE_URL}/api/match-policy` : '/api/match-policy'
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile,
          scenario: selectedScenario,
          identity: profile.identity,
        }),
      })

      const data = await readApiJson(response)
      if (!response.ok) {
        throw new Error(data?.error ?? 'AI 匹配请求失败')
      }

      const normalized: PolicyCard[] = (data?.matched_policies ?? []).map((item: any) => ({
        name: item.name ?? '未命名政策',
        matchLevel: item.match_level ?? '需确认',
        audience: profile.identity,
        scenario: item.scenario ?? selectedScenario,
        targetGroup: item.target_group ?? (profile.identity === 'citizen' ? '普通公民' : '法人企业'),
        benefit: item.benefit ?? '请查看政策原文',
        reason: item.reason ?? '模型未返回匹配原因',
        applyStart: item.apply_start ?? '未知',
        applyEnd: item.apply_end ?? '未知',
        nextStep: item.next_step ?? '请进入政策原文查看办理路径',
        sourceUrl: item.source_url ?? '',
        confidence: Number(item.confidence ?? 0),
      }))

      setAiMatchedPolicies(normalized)
      setAiSourceCount(Number(data?.sourceCount ?? 0))
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'AI 匹配失败')
    } finally {
      setAiLoading(false)
    }
  }

  const runPolicySearch = async (keyword?: string) => {
    const query = (keyword ?? searchQuery).trim()
    if (!query) {
      setSearchError('请输入关键词后再搜索')
      return
    }

    setSearchLoading(true)
    setSearchError('')
    setSearchHint('')
    setHasSearched(true)
    setSearchQuery(query)
    try {
      const params = new URLSearchParams({ q: query, limit: '10' })
      if (selectedProvince) {
        params.set('province', selectedProvince)
      }
      const apiUrl = API_BASE_URL
        ? `${API_BASE_URL}/api/policy-search?${params.toString()}`
        : `/api/policy-search?${params.toString()}`
      const response = await fetch(apiUrl)
      const data = await readApiJson(response)
      if (!response.ok) {
        throw new Error(data?.error ?? '政策搜索失败')
      }
      let rows: KnowledgePolicy[] = Array.isArray(data?.rows) ? data.rows : []
      if (rows.length === 0 && selectedProvince) {
        const globalParams = new URLSearchParams({ q: query, limit: '10' })
        const globalApiUrl = API_BASE_URL
          ? `${API_BASE_URL}/api/policy-search?${globalParams.toString()}`
          : `/api/policy-search?${globalParams.toString()}`
        const globalResponse = await fetch(globalApiUrl)
        const globalData = await readApiJson(globalResponse)
        if (globalResponse.ok) {
          rows = Array.isArray(globalData?.rows) ? globalData.rows : []
          if (rows.length > 0) {
            setSearchHint(`在“${selectedProvince}”未命中，已为你展示全国范围的相关政策。`)
          } else {
            setSearchHint(`在“${selectedProvince}”及全国范围都未命中，请尝试更短关键词。`)
          }
        }
      }
      setSearchResults(rows)
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : '政策搜索失败')
    } finally {
      setSearchLoading(false)
    }
  }

  const openPolicyInterpretation = async (policy: PolicyCard) => {
    setSelectedPolicy(policy)
    setPolicyInterpretation(null)
    setInterpretError('')
    setInterpretLoading(true)
    try {
      const apiUrl = API_BASE_URL ? `${API_BASE_URL}/api/policy-interpret` : '/api/policy-interpret'
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy, profile }),
      })
      const data = await readApiJson(response)
      if (!response.ok) {
        throw new Error(data?.error ?? '政策解读生成失败')
      }
      const interpretation = data?.interpretation ?? null
      if (!interpretation || typeof interpretation !== 'object') {
        throw new Error('解读结果格式错误')
      }
      setPolicyInterpretation({
        summary: interpretation.summary ?? '暂无解读摘要',
        eligibility: Array.isArray(interpretation.eligibility) ? interpretation.eligibility : [],
        disqualifiers: Array.isArray(interpretation.disqualifiers) ? interpretation.disqualifiers : [],
        checklist: Array.isArray(interpretation.checklist) ? interpretation.checklist : [],
        riskTips: Array.isArray(interpretation.riskTips) ? interpretation.riskTips : [],
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('接口返回非 JSON')) {
        setInterpretError('政策解读服务当前不可用，请先确认后端服务已启动或线上服务已完成最新部署。')
      } else {
        setInterpretError(error instanceof Error ? error.message : '解读请求失败')
      }
    } finally {
      setInterpretLoading(false)
    }
  }

  const closeInterpretation = () => {
    setSelectedPolicy(null)
    setPolicyInterpretation(null)
    setInterpretError('')
  }

  const closeKnowledgePolicy = () => {
    setSelectedKnowledgePolicy(null)
  }

  const applyQuickOption = (key: string, value: string) => {
    if (key === 'age') {
      const normalized = value.replace('+', '')
      const ageValue = normalized.includes('-') ? normalized.split('-')[0] : normalized
      setProfile((prev) => ({ ...prev, age: ageValue }))
      return
    }
    if (key === 'hukou-or-residence') {
      setProfile((prev) => ({
        ...prev,
        hukou: prev.hukou || value,
        residence: prev.residence || value,
      }))
      return
    }
    if (key === 'social-security') {
      setReviewInputs((prev) => ({ ...prev, socialSecurityMonths: value }))
      return
    }
    if (key === 'family-condition') {
      if (value.includes('二孩')) {
        setProfile((prev) => ({ ...prev, hasSecondChild: true }))
      }
      setReviewInputs((prev) => ({ ...prev, familyTag: value }))
      return
    }
    if (key === 'enterprise-type') {
      setReviewInputs((prev) => ({ ...prev, enterpriseType: value }))
      return
    }
    if (key === 'tax-or-income') {
      setProfile((prev) => ({ ...prev, annualIncome: value }))
      return
    }
    if (key === 'company-location') {
      setProfile((prev) => ({ ...prev, workPlace: value, residence: prev.residence || value }))
    }
  }

  const buildPolicyShareText = (policy: PolicyCard) => {
    const sourceText = policy.sourceUrl ? `政策原文：${policy.sourceUrl}` : '政策原文：请在“政策找你”平台内查看'
    return [
      `【政策权益分享】${policy.name}`,
      `该权益面向：${policy.targetGroup}。`,
      `政策背景：该权益属于“${policy.scenario}”场景，主要为符合条件的对象提供${policy.benefit}。`,
      `适配说明：系统判断其匹配级别为“${policy.matchLevel}”，原因是：${policy.reason}`,
      `政策窗口：${policy.applyStart} 至 ${policy.applyEnd}（状态：${getPolicyStatus(policy.applyStart, policy.applyEnd)}）`,
      `办理建议：${policy.nextStep}`,
      sourceText,
    ].join('\n')
  }

  const openPolicyQrExport = async (policy: PolicyCard) => {
    setQrPolicy(policy)
    setQrDataUrl('')
    setQrError('')
    setQrLoading(true)
    try {
      const shareText = buildPolicyShareText(policy)
      const dataUrl = await QRCode.toDataURL(shareText, {
        width: 320,
        margin: 2,
      })
      setQrDataUrl(dataUrl)
    } catch (error) {
      setQrError(error instanceof Error ? error.message : '二维码生成失败')
    } finally {
      setQrLoading(false)
    }
  }

  return (
    <main className="app-shell">
      <header className="gov-header">
        <div className="top-strip">
          <span className="site-name">
            {session && <span className="user-pill">当前用户：{session.displayName}</span>}
          </span>
          <div className="quick-links auth-links">
            <span>政务公开</span>
            <span>政务服务</span>
            <span>政策解读</span>
            {session && (
              <button type="button" className="mini-btn" onClick={handleLogout}>
                退出登录
              </button>
            )}
          </div>
        </div>
        <div className="brand-row">
          <div>
            <h1>政策找你</h1>
          </div>
          <p className="brand-description">让“本该属于你”的政策权益不再错过</p>
        </div>
        <nav className="main-nav" aria-label="主导航">
          <span className="active">我要找政策</span>
          <span>个人办事</span>
          <span>企业办事</span>
          <span>政策兑现</span>
          <span>政策解读</span>
        </nav>
      </header>

      {!session ? (
        <section className="card login-card">
          {showLoginPopup && (
            <aside className="login-popover" role="status" aria-live="polite">
              <div className="login-popover-head">
                <strong>新功能提示</strong>
                <button type="button" className="ghost mini-btn" onClick={() => setShowLoginPopup(false)}>
                  关闭
                </button>
              </div>
              <p>你现在可以先搜索政策，再看匹配结果；详细页支持分步办理指引与材料清单。</p>
            </aside>
          )}
          <div className="login-hero">
            <h2>欢迎进入政策找你</h2>
            <p className="hint">
              智能匹配个人与企业可享权益，一次登录即可持续记录进度，减少重复填写。
            </p>
            <div className="login-feature-list">
              <span>自动记住画像信息</span>
              <span>支持政策解读与分享</span>
              <span>可随时游客进入</span>
            </div>
          </div>
          <div className="login-panel">
            <p className="login-panel-title">快捷进入</p>
            <label className="login-name-field">
              微信昵称（可选）
              <input
                value={nicknameInput}
                onChange={(event) => setNicknameInput(event.target.value)}
                placeholder="不填则默认显示“微信用户”"
              />
            </label>
            <div className="login-actions">
              <button type="button" onClick={() => handleQuickLogin('wechat')}>
                微信快捷登录（演示）
              </button>
              <button type="button" className="ghost" onClick={() => handleQuickLogin('guest')}>
                游客直接进入
              </button>
            </div>
            <p className="login-footnote">提示：当前为演示登录，不收集手机号和密码。</p>
          </div>
        </section>
      ) : (
        <>
          <section className="step-indicator">
            <span className={step === 'map' ? 'active' : ''}>1. 地图选址</span>
            <span className={step === 'profile' ? 'active' : ''}>2. 用户画像</span>
            <span className={step === 'result' ? 'active' : ''}>3. 匹配结果</span>
          </section>

          {step === 'map' && (
            <section className="card">
              <h2>请选择你的地区</h2>
              <p className="hint">点击中国地图中的省份即可，系统将按省份进行政策属地判断。</p>
              <div className="map-layout">
                <div className="map-panel">
                  {mapReady ? (
                    <ReactECharts
                      style={{ height: '460px', width: '100%' }}
                      option={mapOption}
                      onEvents={{
                        click: (params: { name: string }) => handleProvinceSelect(params.name),
                      }}
                    />
                  ) : (
                    <div className="loading">地图加载中...</div>
                  )}
                </div>
                <aside className="select-panel">
                  <label>
                    省份
                    <input value={selectedProvince} readOnly placeholder="点击地图省份自动填充" />
                  </label>
                  <p className="selection-summary">已选择：{selectedProvince || '暂未完成'}</p>
                  <button onClick={handleNextFromMap} disabled={!selectedProvince}>
                    下一步：完善画像
                  </button>
                </aside>
              </div>
            </section>
          )}

          {step === 'profile' && (
            <section className="card">
              <h2>完善用户画像</h2>
              <form className="profile-form" onSubmit={handleProfileSubmit}>
            <label>
              身份类型
              <select
                value={profile.identity}
                onChange={(event) => {
                  const nextIdentity = event.target.value as Identity
                  setProfile((prev) => ({ ...prev, identity: nextIdentity }))
                  setSelectedScenario('全部')
                  setAiMatchedPolicies(null)
                }}
              >
                <option value="citizen">普通公民</option>
                <option value="company">法人 / 企业</option>
              </select>
            </label>
            <div className="full-row scene-block">
              <p className="scene-title">场景选择（按身份区分）</p>
              <div className="scene-list">
                {scenariosByIdentity[profile.identity].map((scenario) => (
                  <button
                    key={scenario}
                    type="button"
                    className={`scene-chip ${selectedScenario === scenario ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedScenario(scenario)
                      setAiMatchedPolicies(null)
                    }}
                  >
                    {scenario}
                  </button>
                ))}
              </div>
            </div>
            <label>
              年龄
              <input
                value={profile.age}
                onChange={(event) => setProfile((prev) => ({ ...prev, age: event.target.value }))}
                placeholder="例如 35"
              />
            </label>
            <label>
              性别
              <select
                value={profile.gender}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, gender: event.target.value }))
                }
              >
                <option value="女">女</option>
                <option value="男">男</option>
                <option value="其他">其他</option>
              </select>
            </label>
            <label>
              出生地
              <input
                value={profile.birthPlace}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, birthPlace: event.target.value }))
                }
                placeholder="例如 北京市朝阳区"
              />
            </label>
            <label>
              户籍地
              <input
                value={profile.hukou}
                onChange={(event) => setProfile((prev) => ({ ...prev, hukou: event.target.value }))}
              />
            </label>
            <label>
              常住地
              <input
                value={profile.residence}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, residence: event.target.value }))
                }
              />
            </label>
            <label>
              工作地 / 注册地
              <input
                value={profile.workPlace}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, workPlace: event.target.value }))
                }
              />
            </label>
            <label>
              年收入区间
              <input
                value={profile.annualIncome}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, annualIncome: event.target.value }))
                }
                placeholder="例如 10-20 万"
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={profile.hasSecondChild}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, hasSecondChild: event.target.checked }))
                }
              />
              是否有二孩
            </label>
            <label className="full-row">
              自我描述（可选）
              <textarea
                rows={4}
                value={profile.freeText}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, freeText: event.target.value }))
                }
                placeholder="例如：上海户籍，有两个孩子，目前在苏州工作。"
              />
            </label>
            <div className="action-row">
              <button type="button" className="ghost" onClick={() => setStep('map')}>
                返回地图
              </button>
              <button type="submit">生成政策匹配结果</button>
            </div>
              </form>
            </section>
          )}

          {step === 'result' && (
            <>
              <section className="card">
                <h2>猜你想搜什么</h2>
                <p className="hint">结合你的画像和地区，推荐你优先关注这些政策主题。</p>
                <section className="policy-search-zone">
                  <div className="guess-chip-list">
                    {guessedKeywords.map((keyword) => (
                      <button
                        key={keyword}
                        type="button"
                        className="ghost guess-chip"
                        onClick={() => void runPolicySearch(keyword)}
                      >
                        {keyword}
                      </button>
                    ))}
                  </div>
                  <div className="policy-search-row">
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="搜索政策关键词，例如：人才补贴、创业、税费减免"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void runPolicySearch()
                        }
                      }}
                    />
                    <button type="button" onClick={() => void runPolicySearch()} disabled={searchLoading}>
                      {searchLoading ? '搜索中...' : '搜索政策'}
                    </button>
                  </div>
                  {searchError && <p className="empty-tip">{searchError}</p>}
                  {searchHint && <p className="search-hint">{searchHint}</p>}
                  {hasSearched && !searchLoading && !searchError && searchResults.length === 0 && (
                    <p className="empty-tip">暂无匹配结果，建议换更短的关键词（如“人才”“补贴”“创业”）。</p>
                  )}
                  {searchResults.length > 0 && (
                    <div className="search-result-list">
                      {searchResults.map((item) => (
                        <article key={`${item.url}-${item.title}`} className="search-result-card">
                          <div>
                            <h4>{item.title}</h4>
                            <p>
                              {item.province || '全国'} · 发布于 {item.publishDate || '未知'}
                            </p>
                          </div>
                          <p>{item.contentSnippet || '暂无摘要，请点击查看详细解读。'}</p>
                          <div className="policy-actions">
                            <button type="button" onClick={() => setSelectedKnowledgePolicy(item)}>
                              查看详细解读
                            </button>
                            {item.url && (
                              <a href={item.url} target="_blank" rel="noreferrer" className="policy-link-button">
                                政策原文
                              </a>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </section>

              <section className="card">
                <h2>你可享受的政策权益</h2>
                <p className="hint">
                  已按
                  {profile.identity === 'citizen' ? '个人' : '法人'}
                  身份和
                  {selectedScenario}
                  场景筛选，每条结果展示申报窗口和下一步办理建议。
                </p>
                <div className="unlock-banner">{unlockHintText}</div>
                <div className="ai-toolbar">
                  <button
                    type="button"
                    onClick={runAiMatch}
                    disabled={aiLoading}
                    className={aiLoading ? 'is-loading' : ''}
                  >
                    {aiLoading ? 'AI 匹配中...' : '使用 DeepSeek 智能匹配'}
                  </button>
                  {aiSourceCount !== null && <span>已基于 {aiSourceCount} 条本地政策知识匹配</span>}
                  {aiMatchedPolicies && <span className="ai-badge">当前展示 AI 结果</span>}
                </div>
                {aiError && <p className="empty-tip">{aiError}</p>}
                <div className="result-list">
                  {displayPolicies.map((policy, index) => (
                    <article
                      key={policy.name}
                      className="result-card"
                      style={{ animationDelay: `${index * 60}ms` }}
                    >
                <div className="result-head">
                  <h3>{policy.name}</h3>
                  <span className={`tag ${policy.matchLevel}`}>{policy.matchLevel}</span>
                </div>
                <p className="policy-alarm">{getPolicyAlarmText(policy.applyStart, policy.applyEnd)}</p>
                <div className="policy-meta">
                  <span>
                    <strong>适用对象：</strong>
                    {policy.targetGroup}
                  </span>
                  <span className="scenario-tag">{policy.scenario}</span>
                </div>
                <div className="policy-grid">
                  <div className="policy-item">
                    <p className="policy-label">可获得</p>
                    <p className="policy-value">{policy.benefit}</p>
                  </div>
                  <div className="policy-item">
                    <p className="policy-label">当前状态</p>
                    <p className="policy-value">{getPolicyStatus(policy.applyStart, policy.applyEnd)}</p>
                  </div>
                  <div className="policy-item">
                    <p className="policy-label">申报窗口</p>
                    <p className="policy-value">
                      {policy.applyStart} 至 {policy.applyEnd}
                    </p>
                  </div>
                  <div className="policy-item">
                    <p className="policy-label">下一步</p>
                    <p className="policy-value">{policy.nextStep}</p>
                  </div>
                </div>
                <div className="policy-reason">
                  <p className="policy-label">匹配原因</p>
                  <p className="policy-value">{policy.reason}</p>
                </div>
                <div className="policy-actions">
                  <button
                    type="button"
                    onClick={() => openPolicyInterpretation(policy)}
                    disabled={interpretLoading && selectedPolicy?.name === policy.name}
                    className={interpretLoading && selectedPolicy?.name === policy.name ? 'is-loading' : ''}
                  >
                    {interpretLoading && selectedPolicy?.name === policy.name ? '解读生成中...' : '查看政策解读'}
                  </button>
                  <button
                    type="button"
                    className={`ghost ${qrLoading && qrPolicy?.name === policy.name ? 'is-loading' : ''}`}
                    onClick={() => openPolicyQrExport(policy)}
                    disabled={qrLoading && qrPolicy?.name === policy.name}
                  >
                    {qrLoading && qrPolicy?.name === policy.name ? '二维码生成中...' : '导出二维码'}
                  </button>
                  {policy.sourceUrl && (
                    <a href={policy.sourceUrl} target="_blank" rel="noreferrer" className="policy-link-button">
                      政策原文
                    </a>
                  )}
                </div>
                {typeof policy.confidence === 'number' && (
                  <p className="confidence-tag">模型置信度 {(policy.confidence * 100).toFixed(0)}%</p>
                )}
                    </article>
                  ))}
                </div>
                {displayPolicies.length === 0 && (
                  <p className="empty-tip">当前身份与场景下暂无直接命中政策，请切换场景或补充画像信息。</p>
                )}
                <div className="action-row">
                  <button className="ghost" onClick={() => setStep('profile')}>
                    返回修改画像
                  </button>
                  <button onClick={() => setStep('map')}>重新选择地区</button>
                </div>
              </section>
            </>
          )}
        </>
      )}
      <section
        className={`interpret-modal ${selectedPolicy ? 'open' : ''}`}
        onClick={closeInterpretation}
      >
        <div className="interpret-panel" onClick={(event) => event.stopPropagation()}>
          <div className="interpret-header">
            <h3>政策解读</h3>
            <button type="button" className="ghost" onClick={closeInterpretation}>
              关闭
            </button>
          </div>
          {selectedPolicy && (
            <div className="interpret-body">
              <p className="interpret-policy-name">{selectedPolicy.name}</p>
              {interpretLoading && <p>解读生成中...</p>}
              {interpretError && <p className="empty-tip">{interpretError}</p>}
              {!interpretLoading && !interpretError && (
                <>
                  <div className="detail-quick-grid">
                    <div className="detail-quick-item">
                      <p className="policy-label">申请对象</p>
                      <p className="policy-value">{selectedPolicy.targetGroup}</p>
                    </div>
                    <div className="detail-quick-item">
                      <p className="policy-label">办理渠道</p>
                      <p className="policy-value">优先线上办理；无法线上提交时前往本地政务服务窗口。</p>
                    </div>
                    <div className="detail-quick-item">
                      <p className="policy-label">可享权益</p>
                      <p className="policy-value">{selectedPolicy.benefit}</p>
                    </div>
                    <div className="detail-quick-item">
                      <p className="policy-label">时间信息</p>
                      <p className="policy-value">
                        申报窗口：{selectedPolicy.applyStart} 至 {selectedPolicy.applyEnd}（{getPolicyStatus(selectedPolicy.applyStart, selectedPolicy.applyEnd)}）
                      </p>
                    </div>
                  </div>
                  <section>
                    <h4>政策说明</h4>
                    <p>
                      {policyInterpretation?.summary ||
                        buildFriendlyPolicyMessage(selectedPolicy.name, selectedPolicy.reason)}
                    </p>
                  </section>
                  <section className="progress-section">
                    <h4>资格判断结果</h4>
                    <div className="apply-score-row">
                      <span>当前匹配度</span>
                      <div className="heat-bar" aria-hidden="true">
                        <span style={{ width: `${checkScore}%` }} />
                      </div>
                      <strong>{checkScore}分</strong>
                    </div>
                    <div className="score-dial-wrap">
                      <div
                        className="score-dial"
                        style={{ ['--score' as string]: `${checkScore}` }}
                        aria-label={`当前匹配度${checkScore}分`}
                      >
                        <span>{checkScore}</span>
                      </div>
                    </div>
                    <p className="search-hint">
                      已满足 {passCount} 项，待补充 {missingCount} 项。补齐后可直接进入申报环节。
                    </p>
                    <div className="eligibility-list">
                      {eligibilityChecks.map((check) => (
                        <article key={`interpret-${check.key}`} className={`eligibility-item ${check.status}`}>
                          <div className="eligibility-head">
                            <p className="policy-label">{check.label}</p>
                            <span className={`status-chip ${check.status}`}>{getCheckStatusText(check.status)}</span>
                          </div>
                          <p className="policy-value">{check.detail}</p>
                          {check.options && check.options.length > 0 && (
                            <div className="quick-option-row">
                              {check.options.map((option) => (
                                <button
                                  key={`interpret-${check.key}-${option}`}
                                  type="button"
                                  className="ghost quick-option-btn"
                                  onClick={() => applyQuickOption(check.key, option)}
                                >
                                  选“{option}”
                                </button>
                              ))}
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>
                  <section className="progress-section">
                    <h4>申领路径</h4>
                    <div className="step-track">
                      {(policyInterpretation?.checklist?.length
                        ? policyInterpretation.checklist.map((item) => ({ title: `步骤`, desc: item }))
                        : buildApplicationSteps(profile.identity === 'company')
                      ).map((step, idx) => (
                        <article key={`interpret-step-${idx}-${step.desc}`} className="step-node">
                          <span className="step-index">{idx + 1}</span>
                          <div>
                            <p className="policy-label">{step.title || `步骤 ${idx + 1}`}</p>
                            <p className="policy-value">{step.desc}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h4>材料准备与模板</h4>
                    <div className="material-list">
                      {materialList.map((item) => (
                        <article key={`interpret-${item.name}`} className="material-card">
                          <p className="policy-label">{item.name}</p>
                          <p className="policy-value">{item.tip}</p>
                          <a href={item.url} target="_blank" rel="noreferrer" className="policy-link-button">
                            查看办理入口
                          </a>
                        </article>
                      ))}
                    </div>
                    <p className="template-preview">
                      模板示例：本人/本企业拟申请《{selectedPolicy.name}》，已确认身份为“
                      {profile.identity === 'company' ? '企业/法人主体' : '个人'}”，
                      所在地区“{selectedProvince || profile.residence || '待补充'}”，现提交申请材料并承诺信息真实有效。
                    </p>
                  </section>
                  <section>
                    <h4>可享福利提示</h4>
                    <p>{selectedPolicy.benefit}</p>
                    {selectedPolicy.sourceUrl && (
                      <a href={selectedPolicy.sourceUrl} target="_blank" rel="noreferrer" className="policy-link-button">
                        打开官网原文
                      </a>
                    )}
                  </section>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      <section
        className={`knowledge-modal ${selectedKnowledgePolicy ? 'open' : ''}`}
        onClick={closeKnowledgePolicy}
      >
        <div className="knowledge-panel" onClick={(event) => event.stopPropagation()}>
          <div className="interpret-header">
            <h3>政策详情可视化解读</h3>
            <button type="button" className="ghost" onClick={closeKnowledgePolicy}>
              关闭
            </button>
          </div>
          {selectedKnowledgePolicy && (
            <div className="interpret-body">
              <p className="interpret-policy-name">{selectedKnowledgePolicy.title}</p>
              <div className="detail-quick-grid">
                <div className="detail-quick-item">
                  <p className="policy-label">申请对象</p>
                  <p className="policy-value">
                    {summarizeAudience(selectedKnowledgePolicy.title, profile)}
                  </p>
                </div>
                <div className="detail-quick-item">
                  <p className="policy-label">办理渠道</p>
                  <p className="policy-value">
                    线上政务服务网可申报；材料复杂时建议去本地政务服务中心窗口提交。
                  </p>
                </div>
                <div className="detail-quick-item">
                  <p className="policy-label">可享权益</p>
                  <p className="policy-value">
                    {getBenefitPreview(selectedKnowledgePolicy)}
                  </p>
                </div>
                <div className="detail-quick-item">
                  <p className="policy-label">时间信息</p>
                  <p className="policy-value">
                    发布日期：{selectedKnowledgePolicy.publishDate || '未知'}
                    {selectedKnowledgePolicy.deadlineHint ? `；${selectedKnowledgePolicy.deadlineHint}` : ''}
                  </p>
                </div>
              </div>
              <section>
                <h4>政策说明</h4>
                <p>{buildFriendlyPolicyMessage(selectedKnowledgePolicy.title, selectedKnowledgePolicy.contentSnippet)}</p>
              </section>
              <section className="progress-section">
                <h4>资格判断结果</h4>
                <div className="apply-score-row">
                  <span>当前匹配度</span>
                  <div className="heat-bar" aria-hidden="true">
                    <span style={{ width: `${checkScore}%` }} />
                  </div>
                  <strong>{checkScore}分</strong>
                </div>
                <div className="score-dial-wrap">
                  <div
                    className="score-dial"
                    style={{ ['--score' as string]: `${checkScore}` }}
                    aria-label={`当前匹配度${checkScore}分`}
                  >
                    <span>{checkScore}</span>
                  </div>
                </div>
                <p className="search-hint">
                  已满足 {passCount} 项，待补充 {missingCount} 项。补齐后可直接进入申报环节。
                </p>
                <div className="eligibility-list">
                  {eligibilityChecks.map((check) => (
                    <article key={check.key} className={`eligibility-item ${check.status}`}>
                      <div className="eligibility-head">
                        <p className="policy-label">{check.label}</p>
                        <span className={`status-chip ${check.status}`}>{getCheckStatusText(check.status)}</span>
                      </div>
                      <p className="policy-value">{check.detail}</p>
                      {check.options && check.options.length > 0 && (
                        <div className="quick-option-row">
                          {check.options.map((option) => (
                            <button
                              key={`${check.key}-${option}`}
                              type="button"
                              className="ghost quick-option-btn"
                              onClick={() => applyQuickOption(check.key, option)}
                            >
                              选“{option}”
                            </button>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
              <section className="progress-section">
                <h4>申领路径</h4>
                <div className="step-track">
                  {buildApplicationSteps(profile.identity === 'company').map((step, idx) => (
                    <article key={step.title} className="step-node">
                      <span className="step-index">{idx + 1}</span>
                      <div>
                        <p className="policy-label">{step.title}</p>
                        <p className="policy-value">{step.desc}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              <section>
                <h4>材料准备与模板</h4>
                <div className="material-list">
                  {materialList.map((item) => (
                    <article key={item.name} className="material-card">
                      <p className="policy-label">{item.name}</p>
                      <p className="policy-value">{item.tip}</p>
                      <a href={item.url} target="_blank" rel="noreferrer" className="policy-link-button">
                        查看办理入口
                      </a>
                    </article>
                  ))}
                </div>
                <p className="template-preview">
                  模板示例：本人/本企业拟申请《{selectedKnowledgePolicy.title}》，已确认身份为“
                  {profile.identity === 'company' ? '企业/法人主体' : '个人'}”，
                  所在地区“{selectedProvince || profile.residence || '待补充'}”，现提交申请材料并承诺信息真实有效。
                </p>
              </section>
              <section>
                <h4>可享福利提示</h4>
                <p>{getBenefitPreview(selectedKnowledgePolicy)}</p>
                {selectedKnowledgePolicy.url && (
                  <a href={selectedKnowledgePolicy.url} target="_blank" rel="noreferrer" className="policy-link-button">
                    打开官网原文
                  </a>
                )}
              </section>
            </div>
          )}
        </div>
      </section>
      <section className={`share-modal ${qrPolicy ? 'open' : ''}`}>
        <div className="share-panel">
          <div className="interpret-header">
            <h3>权益二维码分享</h3>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setQrPolicy(null)
                setQrDataUrl('')
                setQrError('')
              }}
            >
              关闭
            </button>
          </div>
          {qrPolicy && (
            <div className="share-content">
              <p className="interpret-policy-name">{qrPolicy.name}</p>
              <p>二维码内容已转为第三人称描述，适合直接分享给家人或朋友。</p>
              {qrLoading && <p>二维码生成中...</p>}
              {qrError && <p className="empty-tip">{qrError}</p>}
              {!qrLoading && !qrError && qrDataUrl && (
                <>
                  <img src={qrDataUrl} alt={`${qrPolicy.name} 分享二维码`} className="qr-image" />
                  <p className="share-tip">扫码后可查看该权益说明文本（含背景、条件与办理建议）。</p>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      <section className={`daily-brief-modal ${showDailyBrief && dailyBrief ? 'open' : ''}`}>
        {dailyBrief && (
          <div className="daily-brief-panel">
            <p className="policy-label">今日政策更新</p>
            <h3>{dailyBrief.policyCount} 条在库政策</h3>
            <p className="policy-value">
              日期：{dailyBrief.dateText}
              {dailyBrief.delta !== null &&
                (dailyBrief.delta >= 0
                  ? `，较上次 +${dailyBrief.delta} 条`
                  : `，较上次 ${dailyBrief.delta} 条`)}
            </p>
            <button type="button" onClick={() => setShowDailyBrief(false)}>
              我知道了
            </button>
          </div>
        )}
      </section>
    </main>
  )
}

export default App
