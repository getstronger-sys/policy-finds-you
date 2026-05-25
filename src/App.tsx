import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts'
import QRCode from 'qrcode'
import html2canvas from 'html2canvas'
import './App.css'

type Identity = 'citizen' | 'company'
type Step = 'map' | 'profile' | 'result'
type AuthMode = 'wechat' | 'guest'
type MainTab = 'match' | 'todo' | 'favorite' | 'gov'
type CitizenInputMode = 'structured' | 'text' | 'voice' | 'qa'
type GovRange = '7d' | '30d' | 'custom'
const LOGO_SRC = '/logo-main.png'
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() ?? ''

function buildApiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (!API_BASE_URL) {
    return normalizedPath
  }
  let base = API_BASE_URL.replace(/\/$/, '')
  if (base.endsWith('/api') && normalizedPath.startsWith('/api/')) {
    return `${base}${normalizedPath.slice(4)}`
  }
  return `${base}${normalizedPath}`
}

interface ChatReplyContext {
  profile: UserProfile
  selectedProvince: string
  profileTags: string[]
}

function buildLocalChatReply(question: string, ctx?: ChatReplyContext) {
  const text = String(question || '').trim()
  const profile = ctx?.profile
  const tags = ctx?.profileTags ?? []
  const region = ctx?.selectedProvince || profile?.residence || profile?.workPlace || ''

  if (!text) return '你可以告诉我你的地区、身份和想办的事，我会给你下一步建议。'

  if (
    text.includes('读取') ||
    text.includes('能读') ||
    text.includes('看到') ||
    ((text.includes('填') || text.includes('写')) && (text.includes('信息') || text.includes('资料') || text.includes('画像')))
  ) {
    if (tags.length === 0) {
      return '可以读取你在左侧「用户画像」里填写的内容。目前还没检测到有效字段，建议先补全地区、年龄、就业状态等，我就能结合你的情况回答。'
    }
    const regionHint = region ? `已选地区：${region}。` : ''
    return `可以，我已读取你当前画像：${tags.join('、')}。${regionHint}你可以继续问「能申请什么政策」或具体办理问题。`
  }

  const mentionsBeijing = text.includes('北京')
  const mentionsHefei = text.includes('合肥') || region.includes('合肥') || profile?.workPlace?.includes('合肥')
  if (mentionsHefei && (mentionsBeijing || text.includes('去') || text.includes('转'))) {
    const target = mentionsBeijing ? '北京' : '目标城市'
    const from = profile?.workPlace || region || '合肥'
    return `你在${from}工作、想去${target}发展，建议优先确认三件事：①${target}就业/落户或人才政策；②社保公积金是否可转移接续；③补贴申领地以参保地还是工作地为准。可先在本平台匹配「${target}」政策，或拨打${getOfficialPhone(target)}咨询。`
  }

  if (text.includes('户籍') && (text.includes('转') || text.includes('迁'))) {
    const target = mentionsBeijing ? '北京' : region || '迁入地'
    return `户籍迁移要看${target}当年落户政策（学历、社保、住房、就业等）。建议先核对你是否符合人才引进、积分落户等路径，再按公安和政务网流程办理。`
  }
  if (text.includes('社保')) {
    const months = profile?.socialSecurityMonths
    return months
      ? `你已填写社保 ${months}。跨地区就业时记得办理社保转移，并查询就业地人才、租房、补贴类政策。`
      : '建议先确认社保连续缴纳月数，并优先查询就业/人才/租房相关政策。'
  }
  if (text.includes('补贴')) return '补贴类政策通常有申报窗口和截止时间。你可以告诉我具体想办的事，我会结合你的画像帮你筛政策。'
  if (text.includes('电话')) return `可先拨打${getOfficialPhone(region || '全国')}，或查看政策原文中的受理部门电话。`

  if (tags.length > 0) {
    return `结合你当前画像（${tags.slice(0, 6).join('、')}），建议先在「我要找政策」里完成匹配，再查看具体申报条件和材料。你也可以把想办的事说具体一点，例如「租房补贴」「落户」。`
  }
  return '我已收到你的问题。请先在左侧补全地区、身份和就业/家庭信息，或直接说你想办的具体事项（如落户、补贴、创业）。'
}
const SESSION_STORAGE_KEY = 'policy-finds-you.session'
const DRAFT_STORAGE_KEY = 'policy-finds-you.draft'
const TODO_STORAGE_KEY = 'policy-finds-you.todo-list'
const FAVORITE_STORAGE_KEY = 'policy-finds-you.favorite-list'

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
  officialPhone?: string
  confidence?: number
}

interface UserProfile {
  identity: Identity
  age: string
  gender: string
  maritalStatus: string
  educationLevel: string
  birthPlace: string
  hukou: string
  residence: string
  workPlace: string
  childrenCount: string
  employmentStatus: string
  housingNeed: string
  policyNeed: string
  socialSecurityMonths: string
  providentFundMonths: string
  familyTag: string
  disabilityStatus: string
  veteranStatus: string
  lowIncomeStatus: string
  companyIndustry: string
  employeeCount: string
  companyStage: string
  annualTaxBracket: string
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

interface TodoItem {
  id: string
  title: string
  ownerDisplayName: string
  sourceUrl?: string
  steps: string[]
  currentStep: number
  materials: string[]
  benefitHint: string
  provinceHint: string
  updatedAt: string
}

interface FavoriteItem {
  id: string
  title: string
  sourceUrl?: string
  summary: string
  provinceHint: string
  createdAt: string
}

interface GovMetricsPayload {
  totalEvents: number
  amountTotal: number
  activeUserCount?: number
  feedbackUserCount?: number
  feedbackReachRate?: number
  questionTotal?: number
  provinceTop: Array<{ name: string; value: number }>
  policyTop: Array<{ name: string; value: number }>
  dailyTrend?: Array<{ date: string; value: number }>
  questionTop?: Array<{ name: string; value: number }>
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
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
        status: profile.companyStage || reviewInputs.enterpriseType ? 'pass' : 'missing',
        detail: profile.companyStage || reviewInputs.enterpriseType || '请确认企业是否为小微/高新/科技型主体',
        options:
          !(profile.companyStage || reviewInputs.enterpriseType)
            ? ['小微企业', '高新技术企业', '科技型中小企业']
            : undefined,
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
        status: profile.socialSecurityMonths || reviewInputs.socialSecurityMonths ? 'pass' : 'missing',
        detail: profile.socialSecurityMonths || reviewInputs.socialSecurityMonths
          ? `已补充：连续缴纳 ${profile.socialSecurityMonths || reviewInputs.socialSecurityMonths}`
        : '缺少社保连续缴纳月数信息',
      options:
        !(profile.socialSecurityMonths || reviewInputs.socialSecurityMonths)
          ? ['6个月', '12个月', '24个月']
          : undefined,
    },
    {
      key: 'family-condition',
      label: '家庭情况',
        status: profile.hasSecondChild || profile.familyTag || reviewInputs.familyTag ? 'pass' : 'missing',
      detail:
        profile.hasSecondChild || profile.familyTag || reviewInputs.familyTag
          ? profile.hasSecondChild
            ? '已识别：二孩家庭'
            : `已补充：${profile.familyTag || reviewInputs.familyTag}`
          : '缺少家庭情况标签（如二孩/养老/残疾家庭）',
      options:
        !(profile.hasSecondChild || profile.familyTag || reviewInputs.familyTag)
          ? ['二孩家庭', '赡养老人', '残疾家庭成员']
          : undefined,
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

function buildTodoStepsByIdentity(isCompany: boolean) {
  return isCompany
    ? ['确认企业资质', '准备企业材料', '完成线上申报', '等待审核兑付']
    : ['核对个人资格', '准备证明材料', '提交申请', '跟踪审核结果']
}

function pickMaterialsByIdentity(isCompany: boolean) {
  return isCompany
    ? ['营业执照副本', '纳税/社保缴纳证明', '项目费用或实施凭证']
    : ['身份证明', '关系证明（婚育/家庭）', '社保或收入证明']
}

function toBenefitHintFromPolicy(policy: PolicyCard) {
  return policy.benefit || '以政策原文公布的权益标准为准'
}

function toBenefitHintFromKnowledge(policy: KnowledgePolicy) {
  return policy.deadlineHint || policy.contentSnippet || '以政策原文公布的权益标准为准'
}

function normalizeProvinceKey(name: string) {
  const trimmed = String(name ?? '').trim()
  const lower = trimmed.toLowerCase()
  const dict: Record<string, string> = {
    beijing: '北京',
    tianjin: '天津',
    hebei: '河北',
    shanxi: '山西',
    neimenggu: '内蒙古',
    liaoning: '辽宁',
    jilin: '吉林',
    heilongjiang: '黑龙江',
    shanghai: '上海',
    jiangsu: '江苏',
    zhejiang: '浙江',
    anhui: '安徽',
    fujian: '福建',
    jiangxi: '江西',
    shandong: '山东',
    henan: '河南',
    hubei: '湖北',
    hunan: '湖南',
    guangdong: '广东',
    guangxi: '广西',
    hainan: '海南',
    chongqing: '重庆',
    sichuan: '四川',
    guizhou: '贵州',
    yunnan: '云南',
    xizang: '西藏',
    shaanxi: '陕西',
    gansu: '甘肃',
    qinghai: '青海',
    ningxia: '宁夏',
    xinjiang: '新疆',
  }
  if (dict[lower]) return dict[lower]
  return trimmed
    .replace(/省|市|自治区|壮族|回族|维吾尔|特别行政区/g, '')
    .replace(/\s+/g, '')
}

/** 各省政务咨询示例电话（演示用，按属地展示不同号码） */
const OFFICIAL_PHONE_BY_PROVINCE: Record<string, string> = {
  北京: '010-66007070',
  天津: '022-88908890',
  河北: '0311-963889',
  山西: '0351-963889',
  内蒙古: '0471-4826794',
  辽宁: '024-22825000',
  吉林: '0431-82752800',
  黑龙江: '0451-82620000',
  上海: '021-62510000',
  江苏: '025-85335555',
  浙江: '0571-87012600',
  安徽: '0551-63699556',
  福建: '0591-87557770',
  江西: '0791-963889',
  山东: '0531-82330000',
  河南: '0371-65566666',
  湖北: '027-87125678',
  湖南: '0731-82212600',
  广东: '020-83125000',
  广西: '0771-963889',
  海南: '0898-65203000',
  重庆: '023-63899888',
  四川: '028-86912600',
  贵州: '0851-963889',
  云南: '0871-63112600',
  西藏: '0891-6328777',
  陕西: '029-87212600',
  甘肃: '0931-963889',
  青海: '0971-963889',
  宁夏: '0951-963889',
  新疆: '0991-963889',
}

function getOfficialPhone(provinceHint?: string) {
  if (!provinceHint || provinceHint.includes('全国')) {
    return '全国平台咨询 400-670-0606'
  }
  const key = normalizeProvinceKey(provinceHint)
  const phone = OFFICIAL_PHONE_BY_PROVINCE[key]
  if (phone) {
    return `${key}政务咨询 ${phone}`
  }
  return `${provinceHint}政务咨询（请查看政策原文联系电话）`
}

const citizenProfileSamples = [
  {
    id: 'mother',
    label: '二孩购房',
    profilePatch: {
      age: '32',
      gender: '女',
      childrenCount: '2',
      hasSecondChild: true,
      employmentStatus: '在职',
      housingNeed: '购房',
      policyNeed: '生育/育儿',
      socialSecurityMonths: '24个月',
      familyTag: '二孩家庭',
    } as Partial<UserProfile>,
    scenario: '婚育',
  },
  {
    id: 'graduate',
    label: '毕业生就业',
    profilePatch: {
      age: '23',
      educationLevel: '本科',
      employmentStatus: '待业',
      policyNeed: '毕业生就业',
      housingNeed: '租房',
      socialSecurityMonths: '6个月',
    } as Partial<UserProfile>,
    scenario: '就业',
  },
  {
    id: 'medical',
    label: '医疗救助',
    profilePatch: {
      age: '58',
      employmentStatus: '退休',
      policyNeed: '医疗救助',
      lowIncomeStatus: '是',
      familyTag: '慢病家庭',
    } as Partial<UserProfile>,
    scenario: '养老',
  },
]

const NATIONAL_PROVINCES = [
  '北京',
  '天津',
  '河北',
  '山西',
  '内蒙古',
  '辽宁',
  '吉林',
  '黑龙江',
  '上海',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '广西',
  '海南',
  '重庆',
  '四川',
  '贵州',
  '云南',
  '西藏',
  '陕西',
  '甘肃',
  '青海',
  '宁夏',
  '新疆',
]

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
  const isGovStandalone = typeof window !== 'undefined' && window.location.pathname.startsWith('/gov')
  const [session, setSession] = useState<UserSession | null>(null)
  const [mainTab, setMainTab] = useState<MainTab>('match')
  const [nicknameInput, setNicknameInput] = useState('')
  const [showDailyBrief, setShowDailyBrief] = useState(false)
  const [dailyBrief, setDailyBrief] = useState<DailyUpdateBrief | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [step, setStep] = useState<Step>('map')
  const [mapReady, setMapReady] = useState(false)
  const [mapLoadError, setMapLoadError] = useState('')
  const [selectedProvince, setSelectedProvince] = useState('')
  const [profile, setProfile] = useState<UserProfile>({
    identity: 'citizen',
    age: '',
    gender: '女',
    maritalStatus: '',
    educationLevel: '',
    birthPlace: '',
    hukou: '',
    residence: '',
    workPlace: '',
    childrenCount: '',
    employmentStatus: '',
    housingNeed: '',
    policyNeed: '',
    socialSecurityMonths: '',
    providentFundMonths: '',
    familyTag: '',
    disabilityStatus: '',
    veteranStatus: '',
    lowIncomeStatus: '',
    companyIndustry: '',
    employeeCount: '',
    companyStage: '',
    annualTaxBracket: '',
    hasSecondChild: false,
    annualIncome: '',
    freeText: '',
  })
  const [selectedScenario, setSelectedScenario] = useState('全部')
  const [citizenInputMode, setCitizenInputMode] = useState<CitizenInputMode>('structured')
  const [qaIndex, setQaIndex] = useState(0)
  const [voiceError, setVoiceError] = useState('')
  const [isVoiceListening, setIsVoiceListening] = useState(false)
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
  const [todoList, setTodoList] = useState<TodoItem[]>([])
  const [favoriteList, setFavoriteList] = useState<FavoriteItem[]>([])
  const [govMetrics, setGovMetrics] = useState<GovMetricsPayload | null>(null)
  const [govRange, setGovRange] = useState<GovRange>('7d')
  const [govStartDate, setGovStartDate] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() - 6)
    return date.toISOString().slice(0, 10)
  })
  const [govEndDate, setGovEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [govExporting, setGovExporting] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: '你好，我是政策小助手。可以直接问我“我这个情况能申请什么？”',
      createdAt: new Date().toISOString(),
    },
  ])
  const [qrPolicy, setQrPolicy] = useState<PolicyCard | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState('')
  const voiceRecognitionRef = useRef<any>(null)
  const govChartsRef = useRef<HTMLDivElement | null>(null)
  const resultSectionRef = useRef<HTMLElement | null>(null)

  const loadChinaMap = useCallback(async () => {
    const sources = ['/data/china.geo.json', 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json']
    for (const url of sources) {
      try {
        const response = await fetch(url)
        if (!response.ok) {
          continue
        }
        const geoJson = await response.json()
        if (!geoJson || !Array.isArray(geoJson.features) || geoJson.features.length === 0) {
          continue
        }
        echarts.registerMap('china', geoJson)
        setMapReady(true)
        setMapLoadError('')
        return
      } catch {
        // Try next source.
      }
    }
    setMapReady(false)
    setMapLoadError('中国地图底图加载失败，请检查网络后重试。')
  }, [])

  useEffect(() => {
    void loadChinaMap()
  }, [loadChinaMap])

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
        if (parsedDraft.profile) {
          setProfile((prev) => ({
            ...prev,
            ...parsedDraft.profile,
          }))
        }
      }

      const rawTodo = localStorage.getItem(TODO_STORAGE_KEY)
      if (rawTodo) {
        const parsedTodo = JSON.parse(rawTodo) as TodoItem[]
        if (Array.isArray(parsedTodo)) {
          setTodoList(parsedTodo)
        }
      }

      const rawFavorite = localStorage.getItem(FAVORITE_STORAGE_KEY)
      if (rawFavorite) {
        const parsedFavorite = JSON.parse(rawFavorite) as FavoriteItem[]
        if (Array.isArray(parsedFavorite)) {
          setFavoriteList(parsedFavorite)
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
    if (!isHydrated) return
    localStorage.setItem(TODO_STORAGE_KEY, JSON.stringify(todoList))
  }, [isHydrated, todoList])

  useEffect(() => {
    if (!isHydrated) return
    localStorage.setItem(FAVORITE_STORAGE_KEY, JSON.stringify(favoriteList))
  }, [favoriteList, isHydrated])

  useEffect(() => {
    if (!isGovStandalone && (!session || mainTab !== 'gov')) return
    const range = buildGovDateRange(govRange, govStartDate, govEndDate)
    if (!range.startDate || !range.endDate) return
    void loadGovMetrics(range.startDate, range.endDate)
  }, [govEndDate, govRange, govStartDate, isGovStandalone, mainTab, session])

  useEffect(() => {
    return () => {
      const recognition = voiceRecognitionRef.current
      if (recognition) {
        recognition.stop()
      }
    }
  }, [])

  useEffect(() => {
    if (citizenInputMode !== 'voice' && isVoiceListening) {
      stopVoiceInput()
    }
  }, [citizenInputMode, isVoiceListening])

  useEffect(() => {
    if (!isHydrated) {
      return
    }
    const loadDailyBrief = async () => {
      try {
        const apiUrl = buildApiUrl('/api/health')
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
  }, [isHydrated])

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
      if (profile.policyNeed) keywords.push(profile.policyNeed)
      if (profile.employmentStatus === '待业') keywords.push('失业与就业援助')
      if (profile.housingNeed) keywords.push(profile.housingNeed.includes('购房') ? '购房支持' : '租房补贴')
      if (profile.lowIncomeStatus === '是') keywords.push('低保与社会救助')
      if (profile.disabilityStatus === '是') keywords.push('残疾人补贴')
    } else {
      keywords.push('税费减免')
      keywords.push('科技创新扶持')
      if (profile.companyIndustry) keywords.push(`${profile.companyIndustry} 扶持`)
      if (profile.companyStage) keywords.push(profile.companyStage)
    }
    if (profile.hasSecondChild) {
      keywords.push('生育与托育补贴')
    }
    return Array.from(new Set(keywords)).slice(0, 6)
  }, [
    profile.companyIndustry,
    profile.companyStage,
    profile.disabilityStatus,
    profile.employmentStatus,
    profile.hasSecondChild,
    profile.housingNeed,
    profile.identity,
    profile.lowIncomeStatus,
    profile.policyNeed,
    selectedProvince,
  ])
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
  const profileTags = useMemo(() => {
    const tags: string[] = []
    if (profile.identity === 'citizen') {
      if (profile.residence) tags.push(profile.residence)
      if (profile.age) tags.push(`${profile.age}岁`)
      if (profile.gender) tags.push(profile.gender)
      if (profile.childrenCount) tags.push(`子女${profile.childrenCount}人`)
      if (profile.employmentStatus) tags.push(profile.employmentStatus)
      if (profile.housingNeed) tags.push(profile.housingNeed)
      if (profile.policyNeed) tags.push(profile.policyNeed)
      if (profile.socialSecurityMonths) tags.push(`社保${profile.socialSecurityMonths}`)
      if (profile.providentFundMonths) tags.push(`公积金${profile.providentFundMonths}`)
      if (profile.familyTag) tags.push(profile.familyTag)
      if (profile.lowIncomeStatus === '是') tags.push('低保/困难群体')
      if (profile.disabilityStatus === '是') tags.push('残疾人家庭')
      if (profile.veteranStatus === '是') tags.push('退役军人')
      if (profile.hasSecondChild) tags.push('二孩家庭')
    } else {
      if (profile.workPlace) tags.push(profile.workPlace)
      if (profile.companyIndustry) tags.push(profile.companyIndustry)
      if (profile.employeeCount) tags.push(`员工${profile.employeeCount}人`)
      if (profile.companyStage) tags.push(profile.companyStage)
      if (profile.annualIncome) tags.push(`营收${profile.annualIncome}`)
      if (profile.annualTaxBracket) tags.push(`纳税${profile.annualTaxBracket}`)
      if (profile.policyNeed) tags.push(profile.policyNeed)
    }
    return Array.from(new Set(tags)).slice(0, 14)
  }, [profile])

  const resetProfileFields = () => {
    clearStructuredProfileForNaturalLanguage(false)
  }

  const clearStructuredProfileForNaturalLanguage = (keepFreeText = false) => {
    setProfile((prev) => ({
      ...prev,
      age: '',
      gender: prev.identity === 'citizen' ? '' : prev.gender,
      maritalStatus: '',
      educationLevel: '',
      birthPlace: '',
      hukou: selectedProvince || prev.hukou || '',
      residence: selectedProvince || prev.residence || '',
      workPlace: selectedProvince || prev.workPlace || '',
      childrenCount: '',
      employmentStatus: '',
      housingNeed: '',
      policyNeed: '',
      socialSecurityMonths: '',
      providentFundMonths: '',
      familyTag: '',
      disabilityStatus: '',
      veteranStatus: '',
      lowIncomeStatus: '',
      companyIndustry: '',
      employeeCount: '',
      companyStage: '',
      annualTaxBracket: '',
      hasSecondChild: false,
      annualIncome: '',
      freeText: keepFreeText ? prev.freeText : '',
    }))
    setReviewInputs({ socialSecurityMonths: '', familyTag: '', enterpriseType: '' })
    setSelectedScenario('全部')
    setAiMatchedPolicies(null)
  }

  const switchCitizenInputMode = (mode: CitizenInputMode) => {
    if (mode === 'text' || mode === 'voice') {
      const keepFreeText =
        (citizenInputMode === 'text' || citizenInputMode === 'voice') &&
        (mode === 'text' || mode === 'voice')
      clearStructuredProfileForNaturalLanguage(keepFreeText)
    }
    if (mode === 'qa') {
      setQaIndex(0)
    }
    if (mode !== 'voice') {
      stopVoiceInput()
    }
    setCitizenInputMode(mode)
  }

  const parseNaturalLanguageProfile = (text: string, base: UserProfile): UserProfile => {
    const next: UserProfile = { ...base, freeText: text }
    const ageMatch = text.match(/(\d{1,3})\s*岁/)
    if (ageMatch) next.age = ageMatch[1]
    const cityMatch = text.match(/在([^，,。；;\s]{2,10}?)(工作|生活|居住|上班)/)
    if (cityMatch) {
      next.workPlace = cityMatch[1]
      next.residence = cityMatch[1]
    }
    const socialSecurityMatch = text.match(/社保(?:连续)?(?:缴纳|已缴)?(\d+(?:\.\d+)?)\s*(年|个月)/)
    if (socialSecurityMatch) {
      const amount = Number(socialSecurityMatch[1])
      next.socialSecurityMonths =
        socialSecurityMatch[2] === '年' && Number.isFinite(amount)
          ? `${Math.round(amount * 12)}个月`
          : `${socialSecurityMatch[1]}个月`
    } else if (text.includes('社保')) {
      next.socialSecurityMonths = '已缴纳'
    }
    const providentFundMatch = text.match(/公积金(?:连续)?(?:缴纳|已缴)?(\d+(?:\.\d+)?)\s*(年|个月)/)
    if (providentFundMatch) {
      const amount = Number(providentFundMatch[1])
      next.providentFundMonths =
        providentFundMatch[2] === '年' && Number.isFinite(amount)
          ? `${Math.round(amount * 12)}个月`
          : `${providentFundMatch[1]}个月`
    } else if (text.includes('公积金')) {
      next.providentFundMonths = '已缴纳'
    }
    if (text.includes('在职')) next.employmentStatus = '在职'
    if (text.includes('待业') || text.includes('失业')) next.employmentStatus = '待业'
    if (text.includes('创业')) next.employmentStatus = '创业'
    if (text.includes('退休')) next.employmentStatus = '退休'
    if (text.includes('购房')) next.housingNeed = '购房'
    if (text.includes('租房')) next.housingNeed = '租房'
    if (text.includes('已婚')) next.maritalStatus = '已婚'
    if (text.includes('未婚')) next.maritalStatus = '未婚'
    if (text.includes('二孩') || text.includes('两个孩子')) {
      next.hasSecondChild = true
      next.childrenCount = '2'
      next.familyTag = '二孩家庭'
    }
    if (text.includes('低保')) next.lowIncomeStatus = '是'
    if (text.includes('残疾')) next.disabilityStatus = '是'
    if (text.includes('退役')) next.veteranStatus = '是'
    if (text.includes('生育') || text.includes('育儿')) next.policyNeed = '生育/育儿'
    if (text.includes('就业')) next.policyNeed = '毕业生就业'
    if (text.includes('医疗')) next.policyNeed = '医疗救助'
    if (text.includes('租房补贴')) next.policyNeed = '租房补贴'
    if (text.includes('创业补贴')) next.policyNeed = '创业补贴'
    return next
  }

  const applyCitizenSample = (sampleId: string) => {
    const sample = citizenProfileSamples.find((item) => item.id === sampleId)
    if (!sample) return
    setProfile((prev) => ({
      ...prev,
      identity: 'citizen',
      residence: prev.residence || selectedProvince || '',
      workPlace: prev.workPlace || selectedProvince || '',
      ...sample.profilePatch,
    }))
    setCitizenInputMode('structured')
    setSelectedScenario(sample.scenario)
  }
  const updateProfileField = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setProfile((prev) => ({ ...prev, [key]: value }))
  }
  const citizenQaQuestions = useMemo(
    () => [
      {
        key: 'residence' as keyof UserProfile,
        label: '常住地区',
        type: 'select' as const,
        options: ['', `${selectedProvince || '本省'}常住`, `${selectedProvince || '本省'}户籍`, '异地就业'],
      },
      {
        key: 'age' as keyof UserProfile,
        label: '年龄',
        type: 'input' as const,
        placeholder: '例如 35',
      },
      {
        key: 'employmentStatus' as keyof UserProfile,
        label: '就业状况',
        type: 'select' as const,
        options: ['', '在职', '待业', '创业', '退休'],
      },
      {
        key: 'annualIncome' as keyof UserProfile,
        label: '月收入（元）/年收入区间',
        type: 'input' as const,
        placeholder: '例如 月收入8000 或 年收入10-20万',
      },
      {
        key: 'policyNeed' as keyof UserProfile,
        label: '重点政策需求',
        type: 'select' as const,
        options: ['', '生育/育儿', '社保补贴', '毕业生就业', '创业补贴', '医疗救助', '低保/社会救助'],
      },
      {
        key: 'familyTag' as keyof UserProfile,
        label: '特殊身份（可多选可写）',
        type: 'input' as const,
        placeholder: '例如 二孩家庭 / 残疾人家庭 / 退役军人',
      },
    ],
    [selectedProvince],
  )
  const currentQaQuestion = citizenQaQuestions[Math.min(qaIndex, citizenQaQuestions.length - 1)]

  const applyNaturalLanguageToProfile = () => {
    const text = profile.freeText.trim()
    if (!text) return
    setProfile((prev) => {
      const base: UserProfile = {
        ...prev,
        age: '',
        gender: '',
        maritalStatus: '',
        educationLevel: '',
        birthPlace: '',
        hukou: selectedProvince || prev.hukou || '',
        residence: selectedProvince || prev.residence || '',
        workPlace: selectedProvince || prev.workPlace || '',
        childrenCount: '',
        employmentStatus: '',
        housingNeed: '',
        policyNeed: '',
        socialSecurityMonths: '',
        providentFundMonths: '',
        familyTag: '',
        disabilityStatus: '',
        veteranStatus: '',
        lowIncomeStatus: '',
        hasSecondChild: false,
        annualIncome: '',
        freeText: text,
      }
      return parseNaturalLanguageProfile(text, base)
    })
    setReviewInputs({ socialSecurityMonths: '', familyTag: '', enterpriseType: '' })
    setSelectedScenario('全部')
    setAiMatchedPolicies(null)
  }

  const stopVoiceInput = () => {
    const recognition = voiceRecognitionRef.current
    if (recognition) {
      recognition.stop()
      voiceRecognitionRef.current = null
    }
    setIsVoiceListening(false)
  }

  const startVoiceInput = () => {
    setVoiceError('')
    if (typeof window === 'undefined') {
      setVoiceError('当前环境不支持语音输入。')
      return
    }
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognitionCtor) {
      setVoiceError('当前浏览器不支持语音识别，请改用自然语言描述。')
      return
    }
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = true
    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript
      }
      updateProfileField('freeText', transcript.trim())
    }
    recognition.onerror = () => {
      setVoiceError('语音识别失败，请检查麦克风权限或改用文本输入。')
      setIsVoiceListening(false)
    }
    recognition.onend = () => {
      setIsVoiceListening(false)
      voiceRecognitionRef.current = null
    }
    recognition.start()
    voiceRecognitionRef.current = recognition
    setIsVoiceListening(true)
  }
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
    setMainTab('match')
    setStep('map')
    setAiMatchedPolicies(null)
    setAiError('')
    setAiSourceCount(null)
    setSession({
      mode,
      displayName,
      savedAt: new Date().toISOString(),
    })
  }

  const handleLogout = () => {
    stopVoiceInput()
    setSession(null)
    setMainTab('match')
    setStep('map')
    setCitizenInputMode('structured')
    setQaIndex(0)
    setVoiceError('')
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
    localStorage.removeItem(SESSION_STORAGE_KEY)
  }

  const parseAmountEstimate = (text: string) => {
    const matched = text.match(/(\d[\d,]*)\s*元/)
    if (!matched) return 0
    const numeric = Number(matched[1].replace(/,/g, ''))
    return Number.isFinite(numeric) ? numeric : 0
  }

  const trackGovernmentEvent = async (payload: {
    province: string
    policyTitle: string
    amountText?: string
    userName?: string
  }) => {
    try {
      await fetch(buildApiUrl('/api/gov-track'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          province: payload.province || '未标注',
          userName: payload.userName || session?.displayName || '匿名用户',
          policyTitle: payload.policyTitle,
          amountEstimate: parseAmountEstimate(payload.amountText || ''),
        }),
      })
    } catch {
      // Ignore telemetry failures to avoid blocking user actions.
    }
  }

  const buildGovDateRange = (range: GovRange, startDate: string, endDate: string) => {
    const today = new Date()
    const end = endDate || today.toISOString().slice(0, 10)
    if (range === 'custom') {
      if (!startDate || !endDate) return { startDate: '', endDate: '' }
      return { startDate, endDate }
    }
    const days = range === '7d' ? 7 : 30
    const start = new Date(today)
    start.setDate(today.getDate() - (days - 1))
    return { startDate: start.toISOString().slice(0, 10), endDate: end }
  }

  const isDateWithinRange = (isoDate: string, startDate: string, endDate: string) => {
    if (!startDate || !endDate) return true
    if (!isoDate) return false
    const d = isoDate.slice(0, 10)
    return d >= startDate && d <= endDate
  }

  const loadGovMetrics = async (startDate: string, endDate: string) => {
    try {
      const params = new URLSearchParams()
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)
      const response = await fetch(buildApiUrl(`/api/gov-metrics?${params.toString()}`))
      const data = (await readApiJson(response)) as GovMetricsPayload
      if (response.ok) {
        setGovMetrics(data)
      }
    } catch {
      // Keep local metrics if remote API is unavailable.
    }
  }

  const addPolicyToTodoFromCard = (policy: PolicyCard) => {
    const id = policy.name
    setTodoList((prev) => {
      if (prev.some((item) => item.id === id)) return prev
      return [
        {
          id,
          title: policy.name,
          ownerDisplayName: session?.displayName || '游客',
          sourceUrl: policy.sourceUrl,
          steps: buildTodoStepsByIdentity(profile.identity === 'company'),
          currentStep: 0,
          materials: pickMaterialsByIdentity(profile.identity === 'company'),
          benefitHint: toBenefitHintFromPolicy(policy),
          provinceHint: selectedProvince || profile.residence || '全国',
          updatedAt: new Date().toISOString(),
        },
        ...prev,
      ]
    })
    void trackGovernmentEvent({
      province: selectedProvince || profile.residence || '全国',
      policyTitle: policy.name,
      amountText: policy.benefit,
    })
  }

  const addPolicyToTodoFromKnowledge = (policy: KnowledgePolicy) => {
    const id = policy.url || policy.title
    setTodoList((prev) => {
      if (prev.some((item) => item.id === id)) return prev
      return [
        {
          id,
          title: policy.title,
          ownerDisplayName: session?.displayName || '游客',
          sourceUrl: policy.url,
          steps: buildTodoStepsByIdentity(profile.identity === 'company'),
          currentStep: 0,
          materials: pickMaterialsByIdentity(profile.identity === 'company'),
          benefitHint: toBenefitHintFromKnowledge(policy),
          provinceHint: policy.province || selectedProvince || '全国',
          updatedAt: new Date().toISOString(),
        },
        ...prev,
      ]
    })
    void trackGovernmentEvent({
      province: policy.province || selectedProvince || '全国',
      policyTitle: policy.title,
      amountText: policy.deadlineHint || policy.contentSnippet,
    })
  }

  const addPolicyToFavoriteFromCard = (policy: PolicyCard) => {
    const id = policy.name
    setFavoriteList((prev) => {
      if (prev.some((item) => item.id === id)) return prev
      return [
        {
          id,
          title: policy.name,
          sourceUrl: policy.sourceUrl,
          summary: policy.reason || policy.benefit,
          provinceHint: selectedProvince || profile.residence || '全国',
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]
    })
    void trackGovernmentEvent({
      province: selectedProvince || profile.residence || '全国',
      policyTitle: policy.name,
      amountText: policy.benefit,
    })
  }

  const addPolicyToFavoriteFromKnowledge = (policy: KnowledgePolicy) => {
    const id = policy.url || policy.title
    setFavoriteList((prev) => {
      if (prev.some((item) => item.id === id)) return prev
      return [
        {
          id,
          title: policy.title,
          sourceUrl: policy.url,
          summary: policy.contentSnippet || policy.deadlineHint || '收藏政策',
          provinceHint: policy.province || selectedProvince || '全国',
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]
    })
    void trackGovernmentEvent({
      province: policy.province || selectedProvince || '全国',
      policyTitle: policy.title,
      amountText: policy.deadlineHint || policy.contentSnippet,
    })
  }

  const updateTodoStep = (id: string, nextStep: number) => {
    const target = todoList.find((item) => item.id === id)
    setTodoList((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              currentStep: Math.max(0, Math.min(nextStep, item.steps.length)),
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    )
    if (target) {
      void trackGovernmentEvent({
        province: target.provinceHint,
        policyTitle: target.title,
        amountText: target.benefitHint,
      })
    }
  }

  const handleProfileSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAiMatchedPolicies(null)
    setAiError('')
    setAiSourceCount(null)
    setStep('result')
  }

  const requestAiMatch = async (targetProfile: UserProfile, targetScenario: string) => {
    const apiUrl = buildApiUrl('/api/match-policy')
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: targetProfile,
        scenario: targetScenario,
        identity: targetProfile.identity,
      }),
    })
    const data = await readApiJson(response)
    if (!response.ok) {
      throw new Error(data?.error ?? 'AI 匹配请求失败')
    }
    const provinceHint = selectedProvince || targetProfile.residence || targetProfile.workPlace || '全国'
    const normalized: PolicyCard[] = (data?.matched_policies ?? []).map((item: any) => ({
      name: item.name ?? '未命名政策',
      matchLevel: item.match_level ?? '需确认',
      audience: targetProfile.identity,
      scenario: item.scenario ?? targetScenario,
      targetGroup: item.target_group ?? (targetProfile.identity === 'citizen' ? '普通公民' : '法人企业'),
      benefit: item.benefit ?? '请查看政策原文',
      reason: item.reason ?? '模型未返回匹配原因',
      applyStart: item.apply_start ?? '未知',
      applyEnd: item.apply_end ?? '未知',
      nextStep: item.next_step ?? '请进入政策原文查看办理路径',
      sourceUrl: item.source_url ?? '',
      officialPhone: item.official_phone ?? getOfficialPhone(provinceHint),
      confidence: Number(item.confidence ?? 0),
    }))

    return {
      rows: normalized,
      sourceCount: Number(data?.sourceCount ?? 0),
    }
  }

  const runAiMatch = async () => {
    setAiLoading(true)
    setAiError('')
    try {
      const result = await requestAiMatch(profile, selectedScenario)
      setAiMatchedPolicies(result.rows)
      setAiSourceCount(result.sourceCount)
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
      const apiUrl = buildApiUrl(`/api/policy-search?${params.toString()}`)
      const response = await fetch(apiUrl)
      const data = await readApiJson(response)
      if (!response.ok) {
        throw new Error(data?.error ?? '政策搜索失败')
      }
      let rows: KnowledgePolicy[] = Array.isArray(data?.rows) ? data.rows : []
      if (rows.length === 0 && selectedProvince) {
        const globalParams = new URLSearchParams({ q: query, limit: '10' })
        const globalApiUrl = buildApiUrl(`/api/policy-search?${globalParams.toString()}`)
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
      const apiUrl = buildApiUrl('/api/policy-interpret')
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy, profile }),
      })
      let data: Record<string, any> = {}
      const raw = await response.text()
      if (raw) {
        try {
          data = JSON.parse(raw)
        } catch {
          throw new Error('政策解读服务返回异常，请确认线上已完成最新部署。')
        }
      }
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : '政策解读生成失败')
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
      setProfile((prev) => ({ ...prev, socialSecurityMonths: value }))
      setReviewInputs((prev) => ({ ...prev, socialSecurityMonths: value }))
      return
    }
    if (key === 'family-condition') {
      if (value.includes('二孩')) {
        setProfile((prev) => ({ ...prev, hasSecondChild: true }))
      }
      setProfile((prev) => ({ ...prev, familyTag: value }))
      setReviewInputs((prev) => ({ ...prev, familyTag: value }))
      return
    }
    if (key === 'enterprise-type') {
      setProfile((prev) => ({ ...prev, companyStage: value }))
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

  const sendChatMessage = async () => {
    const question = chatInput.trim()
    if (!question || chatLoading) return
    const chatContext: ChatReplyContext = { profile, selectedProvince, profileTags }
    const userMessage: ChatMessage = { role: 'user', content: question, createdAt: new Date().toISOString() }
    setChatMessages((prev) => [...prev, userMessage])
    setChatInput('')
    setChatLoading(true)
    try {
      const response = await fetch(buildApiUrl('/api/policy-chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          province: selectedProvince || profile.residence || profile.workPlace || '全国',
          userName: session?.displayName || '匿名用户',
          profile,
          profileSummary: profileTags.join('、'),
        }),
      })
      let data: Record<string, any> = {}
      const raw = await response.text()
      if (raw) {
        try {
          data = JSON.parse(raw)
        } catch {
          throw new Error('AI 服务未连接成功')
        }
      }
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'AI 对话暂时不可用')
      }
      const answer =
        typeof data?.answer === 'string' && data.answer.trim()
          ? data.answer
          : buildLocalChatReply(question, chatContext)
      setChatMessages((prev) => [...prev, { role: 'assistant', content: answer, createdAt: new Date().toISOString() }])
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: buildLocalChatReply(question, chatContext),
          createdAt: new Date().toISOString(),
        },
      ])
    } finally {
      setChatLoading(false)
    }
  }

  const exportGovChartsImage = async () => {
    if (!govChartsRef.current) return
    setGovExporting(true)
    try {
      const canvas = await html2canvas(govChartsRef.current, {
        useCORS: true,
        backgroundColor: '#fffdf9',
        scale: 2,
      })
      const dataUrl = canvas.toDataURL('image/png')
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = `gov-charts-${new Date().toISOString().slice(0, 10)}.png`
      link.click()
    } finally {
      setGovExporting(false)
    }
  }

  const todoCompletedCount = todoList.filter((item) => item.currentStep >= item.steps.length).length
  const todoOverallProgress = todoList.length
    ? Math.round(
        (todoList.reduce((acc, item) => acc + item.currentStep / Math.max(item.steps.length, 1), 0) /
          todoList.length) *
          100,
      )
    : 0
  const activeGovRange = buildGovDateRange(govRange, govStartDate, govEndDate)
  const filteredTodoForGov = useMemo(
    () =>
      todoList.filter((item) =>
        isDateWithinRange(item.updatedAt, activeGovRange.startDate, activeGovRange.endDate),
      ),
    [activeGovRange.endDate, activeGovRange.startDate, todoList],
  )
  const filteredFavoriteForGov = useMemo(
    () =>
      favoriteList.filter((item) =>
        isDateWithinRange(item.createdAt, activeGovRange.startDate, activeGovRange.endDate),
      ),
    [activeGovRange.endDate, activeGovRange.startDate, favoriteList],
  )
  const govStepBottlenecks = useMemo(() => {
    const total = filteredTodoForGov.length || 1
    const bucket = new Map<string, number>()
    for (const item of filteredTodoForGov) {
      if (item.currentStep >= item.steps.length) continue
      const stepLabel = item.steps[item.currentStep] || '待推进'
      bucket.set(stepLabel, (bucket.get(stepLabel) ?? 0) + 1)
    }
    return Array.from(bucket.entries())
      .map(([step, count]) => ({
        step,
        count,
        ratio: Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  }, [filteredTodoForGov])
  const govOptimizationAdvice = useMemo(() => {
    const top = govStepBottlenecks[0]
    if (!top) {
      return '当前暂无明显卡点，可继续跟踪新增待办。'
    }
    if (top.step.includes('资格')) {
      return `当前最卡在「${top.step}」（${top.ratio}%）。建议政府侧统一资格口径，提供自动资格预审工具，减少群众反复咨询。`
    }
    if (top.step.includes('材料')) {
      return `当前最卡在「${top.step}」（${top.ratio}%）。建议优先优化材料清单模板、增加可下载样例与线上材料预校验。`
    }
    if (top.step.includes('提交') || top.step.includes('申报')) {
      return `当前最卡在「${top.step}」（${top.ratio}%）。建议优化填报页面与字段说明，并减少重复录入项。`
    }
    if (top.step.includes('审核') || top.step.includes('兑付')) {
      return `当前最卡在「${top.step}」（${top.ratio}%）。建议压缩审核流转时长，并公开节点进度与预计时限。`
    }
    return `当前最卡在「${top.step}」（${top.ratio}%）。建议针对该步骤做专项流程梳理与用户回访。`
  }, [govStepBottlenecks])
  const localProvinceStatsForGov = useMemo(() => {
    const bucket = new Map<string, number>()
    for (const item of [...filteredTodoForGov, ...filteredFavoriteForGov]) {
      const key = item.provinceHint || selectedProvince || '未标注'
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
    }
    return Array.from(bucket.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
  }, [filteredFavoriteForGov, filteredTodoForGov, selectedProvince])
  const localPolicyStatsForGov = useMemo(() => {
    const bucket = new Map<string, number>()
    for (const item of [...filteredTodoForGov, ...filteredFavoriteForGov]) {
      const key = item.title.slice(0, 12)
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
    }
    return Array.from(bucket.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [filteredFavoriteForGov, filteredTodoForGov])
  const localAmountForGov = useMemo(() => {
    const text = filteredTodoForGov.map((item) => item.benefitHint).join(' ')
    const matches = text.match(/(\d[\d,]*)\s*元/g) ?? []
    return matches.reduce((acc, token) => {
      const value = Number(token.replace(/[^\d]/g, ''))
      return Number.isFinite(value) ? acc + value : acc
    }, 0)
  }, [filteredTodoForGov])
  const displayedProvinceStats = govMetrics?.provinceTop?.length ? govMetrics.provinceTop : localProvinceStatsForGov
  const displayedPolicyStats = govMetrics?.policyTop?.length ? govMetrics.policyTop : localPolicyStatsForGov
  const displayedAmountTotal = govMetrics?.amountTotal ?? localAmountForGov
  const localTrend = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of filteredTodoForGov) {
      const key = new Date(item.updatedAt).toISOString().slice(0, 10)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    for (const item of filteredFavoriteForGov) {
      const key = new Date(item.createdAt).toISOString().slice(0, 10)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [filteredFavoriteForGov, filteredTodoForGov])
  const displayedDailyTrend =
    govMetrics?.dailyTrend && govMetrics.dailyTrend.length > 0 ? govMetrics.dailyTrend : localTrend
  const normalizeProvinceForMap = (name: string) => {
    const lower = name.trim().toLowerCase()
    const dict: Record<string, string> = {
      beijing: '北京',
      tianjin: '天津',
      hebei: '河北',
      shanxi: '山西',
      neimenggu: '内蒙古',
      liaoning: '辽宁',
      jilin: '吉林',
      heilongjiang: '黑龙江',
      shanghai: '上海',
      jiangsu: '江苏',
      zhejiang: '浙江',
      anhui: '安徽',
      fujian: '福建',
      jiangxi: '江西',
      shandong: '山东',
      henan: '河南',
      hubei: '湖北',
      hunan: '湖南',
      guangdong: '广东',
      guangxi: '广西',
      hainan: '海南',
      chongqing: '重庆',
      sichuan: '四川',
      guizhou: '贵州',
      yunnan: '云南',
      xizang: '西藏',
      shaanxi: '陕西',
      gansu: '甘肃',
      qinghai: '青海',
      ningxia: '宁夏',
      xinjiang: '新疆',
      hongkong: '香港',
      macau: '澳门',
      taiwan: '台湾',
    }
    if (dict[lower]) return dict[lower]
    return name
      .replace(/省|市|自治区|壮族|回族|维吾尔|特别行政区/g, '')
      .replace(/\s+/g, '')
  }
  const mapSeriesData = displayedProvinceStats.map((item) => ({
    name: normalizeProvinceForMap(item.name),
    value: item.value,
  }))
  const govFeedbackReachRate =
    typeof govMetrics?.feedbackReachRate === 'number' ? govMetrics.feedbackReachRate : 0
  const govConversionRate = filteredTodoForGov.length
    ? Math.round(
        (filteredTodoForGov.filter((item) => item.currentStep >= item.steps.length).length /
          filteredTodoForGov.length) *
          100,
      )
    : 0
  const GOV_FUND_BUDGET_BASE = 10_000_000
  const govFundUsageRate = Math.min(100, Math.round((displayedAmountTotal / GOV_FUND_BUDGET_BASE) * 100))
  const coveredProvinceSet = new Set(mapSeriesData.map((item) => item.name))
  const policyBlindSpots = NATIONAL_PROVINCES.filter((name) => !coveredProvinceSet.has(name))
  const policyBlindSpotText = policyBlindSpots.length
    ? `盲区 ${policyBlindSpots.length} 个：${policyBlindSpots.slice(0, 6).join('、')}${policyBlindSpots.length > 6 ? '…' : ''}`
    : '当前已覆盖主要省份'
  const govHeatmapOption = {
    tooltip: { trigger: 'item' },
    visualMap: {
      min: 0,
      max: Math.max(...mapSeriesData.map((item) => item.value), 1),
      left: 16,
      bottom: 16,
      text: ['高', '低'],
      calculable: true,
      inRange: {
        color: ['#fcead9', '#f6b582', '#e87d45', '#b20c2a'],
      },
    },
    series: [
      {
        name: '政策关注热力',
        type: 'map',
        map: 'china',
        roam: true,
        emphasis: { label: { show: true } },
        data: mapSeriesData,
      },
    ],
  }
  const govTrendOption = {
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: displayedDailyTrend.map((item) => item.date.slice(5)),
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.14 },
        lineStyle: { width: 3, color: '#b20c2a' },
        itemStyle: { color: '#b20c2a' },
        data: displayedDailyTrend.map((item) => item.value),
      },
    ],
    grid: { left: 36, right: 12, top: 18, bottom: 28 },
  }
  const govFocusOption = {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        data: displayedPolicyStats,
        label: { formatter: '{b}: {d}%' },
      },
    ],
  }

  const govDashboardContent = (
    <section className="card">
      <h2>政府驾驶舱（数据分析页）</h2>
      <p className="hint">汇总用户侧待办与收藏行为，形成地区热度、政策关注度与资金规模的分析视图。</p>
      <div className="gov-toolbar">
        <div className="gov-range-switch" role="group" aria-label="时间范围筛选">
          <button
            type="button"
            className={govRange === '7d' ? 'active' : ''}
            onClick={() => setGovRange('7d')}
          >
            近7天
          </button>
          <button
            type="button"
            className={govRange === '30d' ? 'active' : ''}
            onClick={() => setGovRange('30d')}
          >
            近30天
          </button>
          <button
            type="button"
            className={govRange === 'custom' ? 'active' : ''}
            onClick={() => setGovRange('custom')}
          >
            自定义
          </button>
        </div>
        {govRange === 'custom' && (
          <div className="gov-custom-range">
            <label>
              开始日期
              <input type="date" value={govStartDate} onChange={(event) => setGovStartDate(event.target.value)} />
            </label>
            <label>
              结束日期
              <input type="date" value={govEndDate} onChange={(event) => setGovEndDate(event.target.value)} />
            </label>
          </div>
        )}
        <div className="policy-actions gov-export-actions">
          <button type="button" onClick={() => void exportGovChartsImage()} disabled={govExporting}>
            {govExporting ? '导出中...' : '导出导图（PNG）'}
          </button>
        </div>
      </div>
      <div className="gov-kpi-grid">
        <article className="detail-quick-item">
          <p className="policy-label">覆盖地区（Top）</p>
          <p className="policy-value">{displayedProvinceStats.length} 个</p>
        </article>
        <article className="detail-quick-item">
          <p className="policy-label">政策关注总量</p>
          <p className="policy-value">{govMetrics?.totalEvents ?? filteredTodoForGov.length + filteredFavoriteForGov.length} 次</p>
        </article>
        <article className="detail-quick-item">
          <p className="policy-label">待办完成率</p>
          <p className="policy-value">{govConversionRate}%</p>
        </article>
        <article className="detail-quick-item">
          <p className="policy-label">涉及金额估算</p>
          <p className="policy-value">{displayedAmountTotal.toLocaleString()} 元</p>
        </article>
        <article className="detail-quick-item">
          <p className="policy-label">政府数据反馈触达率</p>
          <p className="policy-value">{govFeedbackReachRate}%</p>
          <p className="search-hint">反馈用户 / 活跃办理用户</p>
        </article>
        <article className="detail-quick-item">
          <p className="policy-label">政策转化率</p>
          <p className="policy-value">{govConversionRate}%</p>
          <p className="search-hint">完成待办 / 全部待办</p>
        </article>
        <article className="detail-quick-item">
          <p className="policy-label">资金使用进度</p>
          <p className="policy-value">{govFundUsageRate}%</p>
          <p className="search-hint">按 1000 万预算基线估算</p>
        </article>
        <article className="detail-quick-item">
          <p className="policy-label">政策盲区</p>
          <p className="policy-value">{policyBlindSpots.length} 个省份</p>
          <p className="search-hint">{policyBlindSpotText}</p>
        </article>
      </div>
      <section className="progress-section">
        <h4>用户高频问题（政府可见）</h4>
        {govMetrics?.questionTop && govMetrics.questionTop.length > 0 ? (
          <div className="material-chip-row">
            {govMetrics.questionTop.slice(0, 8).map((item) => (
              <span key={`q-${item.name}`} className="material-chip">
                {item.name}（{item.value}）
              </span>
            ))}
          </div>
        ) : (
          <p className="search-hint">当前时间范围内暂无用户问题数据。</p>
        )}
      </section>
      <section className="progress-section">
        <h4>政府数据反馈与盲区研判</h4>
        <div className="material-list">
          <article className="material-card">
            <p className="policy-label">反馈触达率</p>
            <p className="policy-value">{govFeedbackReachRate}%</p>
            <p className="search-hint">
              当前有 {govMetrics?.feedbackUserCount ?? 0} 位用户提交反馈，活跃办理用户 {govMetrics?.activeUserCount ?? 0} 位。
            </p>
          </article>
          <article className="material-card">
            <p className="policy-label">资金使用进度</p>
            <p className="policy-value">{displayedAmountTotal.toLocaleString()} 元（{govFundUsageRate}%）</p>
            <p className="search-hint">可结合财政分配节奏，动态调整重点政策投放强度。</p>
          </article>
          <article className="material-card">
            <p className="policy-label">政策盲区提示</p>
            <p className="policy-value">{policyBlindSpotText}</p>
            <p className="search-hint">建议在盲区省份加大宣讲和线上触达，优先补齐首批高需求政策。</p>
          </article>
        </div>
      </section>
      <section className="progress-section">
        <h4>待办卡点统计（政府优化重点）</h4>
        {govStepBottlenecks.length > 0 ? (
          <div className="material-list">
            {govStepBottlenecks.map((item) => (
              <article key={`bottleneck-${item.step}`} className="material-card">
                <p className="policy-label">{item.step}</p>
                <p className="policy-value">卡住人数：{item.count}（占比 {item.ratio}%）</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="search-hint">当前时间范围内暂无进行中的待办。</p>
        )}
        <p className="template-preview">优化建议：{govOptimizationAdvice}</p>
      </section>
      <div className="gov-chart-grid" ref={govChartsRef}>
        <article className="gov-chart-card wide">
          <h3>全国政策关注热力图</h3>
          {mapReady ? (
            <ReactECharts option={govHeatmapOption} style={{ height: 360, width: '100%' }} />
          ) : (
            <div className="loading">
              {mapLoadError || '地图加载中...'}
              {mapLoadError && (
                <button type="button" className="ghost mini-btn" onClick={() => void loadChinaMap()}>
                  重试加载
                </button>
              )}
            </div>
          )}
        </article>
        <article className="gov-chart-card">
          <h3>按天新增关注趋势</h3>
          <ReactECharts option={govTrendOption} style={{ height: 280, width: '100%' }} />
        </article>
        <article className="gov-chart-card">
          <h3>政策关注结构</h3>
          <ReactECharts option={govFocusOption} style={{ height: 280, width: '100%' }} />
        </article>
      </div>
      <div className="todo-list">
        {filteredTodoForGov.slice(0, 5).map((item) => (
          <article key={`gov-${item.id}`} className="todo-card">
            <div className="result-head">
              <h3>{item.title}</h3>
              <span className="scenario-tag">{item.provinceHint}</span>
            </div>
            <p className="policy-value">办理人：{item.ownerDisplayName || '匿名用户'}</p>
            <p className="policy-value">
              当前进度：{item.currentStep}/{item.steps.length}，最近更新时间：{new Date(item.updatedAt).toLocaleString()}
            </p>
            <p className="search-hint">提醒：{item.currentStep < item.steps.length ? item.steps[item.currentStep] : '进入兑付与反馈阶段'}</p>
          </article>
        ))}
      </div>
    </section>
  )


  const appOverlays =
    !isGovStandalone && session
      ? createPortal(
          <>
          <button type="button" className="ai-fab" onClick={() => setChatOpen((prev) => !prev)}>
            {chatOpen ? '收起咨询' : 'AI 问一问'}
          </button>
          {chatOpen && (
            <aside className="ai-chat-panel" role="dialog" aria-label="政策AI咨询">
              <div className="ai-chat-head">
                <strong>政策AI咨询</strong>
                <button type="button" className="ghost mini-btn" onClick={() => setChatOpen(false)}>
                  关闭
                </button>
              </div>
              <div className="ai-chat-body">
                {chatMessages.map((message) => (
                  <article key={`${message.role}-${message.createdAt}-${message.content.slice(0, 10)}`} className={`ai-msg ${message.role}`}>
                    <p>{message.content}</p>
                  </article>
                ))}
              </div>
              <div className="ai-chat-input">
                <textarea
                  rows={2}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="例如：我在合肥工作，社保一年，能申请什么补贴？"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendChatMessage()
                    }
                  }}
                />
                <button type="button" onClick={() => void sendChatMessage()} disabled={chatLoading}>
                  {chatLoading ? '发送中...' : '发送'}
                </button>
              </div>
            </aside>
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
                    <div className="detail-quick-item">
                      <p className="policy-label">官方咨询</p>
                      <p className="policy-value">{selectedPolicy.officialPhone || getOfficialPhone(selectedProvince || profile.residence || '全国')}</p>
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
                    <span className="official-phone-tag">
                      {selectedPolicy.officialPhone || getOfficialPhone(selectedProvince || profile.residence || '全国')}
                    </span>
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
                <div className="detail-quick-item">
                  <p className="policy-label">官方咨询</p>
                  <p className="policy-value">{getOfficialPhone(selectedKnowledgePolicy.province)}</p>
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
                <span className="official-phone-tag">
                  {getOfficialPhone(selectedKnowledgePolicy.province)}
                </span>
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

          </>,
          document.body,
        )
      : null

  useEffect(() => {
    const modalOpen =
      Boolean(selectedPolicy) ||
      Boolean(selectedKnowledgePolicy) ||
      Boolean(qrPolicy) ||
      Boolean(showDailyBrief && dailyBrief)
    if (!modalOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [dailyBrief, qrPolicy, selectedKnowledgePolicy, selectedPolicy, showDailyBrief])

  if (isGovStandalone) {
  return (
      <main className="app-shell logged-shell">
        <header className="gov-header">
          <div className="top-strip">
            <span className="site-name">
              <img src={LOGO_SRC} alt="政策找你 logo" className="site-logo" />
              政策找你 · 政府端数据驾驶舱
            </span>
            <div className="quick-links auth-links service-meta">
              <span>服务热线：{getOfficialPhone('全国')}</span>
              <span>数据视图：政府端专用</span>
            </div>
          </div>
          <div className="brand-row">
            <div className="brand-title-row">
              <div className="brand-logo-row">
                <img src={LOGO_SRC} alt="政策找你 logo" className="brand-logo" />
              </div>
              <h1>政府驾驶舱</h1>
            </div>
            <p className="brand-description">地区热度、政策关注与资金规模分析</p>
          </div>
          <nav className="main-nav" aria-label="政府端导航">
            <button type="button" className="active">
              政府驾驶舱
            </button>
            <button type="button" onClick={() => window.location.assign('/')}>
              返回用户端
            </button>
          </nav>
        </header>
        {govDashboardContent}
        <footer className="gov-footer">
          <p>主办：全国政策服务协同平台（演示） ｜ 联系电话：{getOfficialPhone('全国')}</p>
          <p>政府端地址：/gov</p>
        </footer>
      </main>
    )
  }

  return (
    <>
    <main className={`app-shell ${session ? 'logged-shell' : ''}`}>
      <header className={`gov-header ${session ? '' : 'guest-header'}`}>
        {session ? (
          <>
            <div className="top-strip">
              <span className="site-name">
                <img src={LOGO_SRC} alt="政策找你 logo" className="site-logo" />
                政策找你 · 全国惠民政策智能匹配平台
              </span>
              <div className="quick-links auth-links service-meta">
                <span>服务热线：{getOfficialPhone('全国')}</span>
                <span className="user-pill">当前用户：{session.displayName}</span>
                <button type="button" className="mini-btn" onClick={handleLogout}>
                  退出登录
                </button>
              </div>
            </div>
            <div className="brand-row">
              <div className="brand-title-row">
                <div className="brand-logo-row">
                  <img src={LOGO_SRC} alt="政策找你 logo" className="brand-logo" />
                </div>
                <h1>政策找你</h1>
              </div>
              <p className="brand-description">让“本该属于你”的政策权益不再错过</p>
            </div>
          </>
        ) : (
          <div className="guest-brand-strip">
            <div className="guest-brand-main">
              <img src={LOGO_SRC} alt="政策找你 logo" className="brand-logo" />
              <div>
                <h1 className="brand-emphasis">政策找你</h1>
                <p className="brand-description">让“本该属于你”的政策权益不再错过</p>
              </div>
            </div>
            <span className="guest-hotline">服务热线：{getOfficialPhone('全国')}</span>
          </div>
        )}
        <nav className="main-nav" aria-label="主导航">
          <button
            type="button"
            className={mainTab === 'match' ? 'active' : ''}
            onClick={() => setMainTab('match')}
          >
            我要找政策
          </button>
          <button
            type="button"
            className={mainTab === 'todo' ? 'active' : ''}
            onClick={() => setMainTab('todo')}
          >
            我的待办
          </button>
          <button
            type="button"
            className={mainTab === 'favorite' ? 'active' : ''}
            onClick={() => setMainTab('favorite')}
          >
            我的收藏
          </button>
          <button
            type="button"
            onClick={() => window.location.assign('/gov')}
          >
            政府驾驶舱
          </button>
        </nav>
      </header>

      {!session ? (
        <section className="card login-card">
          <div className="login-hero">
            <span className="login-mark">
              CHINA · <strong className="brand-emphasis-inline">政策找你</strong>
            </span>
            <h2 className="login-title">
              <span className="login-title-prefix">欢迎进入</span>
              <span className="brand-emphasis">政策找你</span>
            </h2>
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
          <div className="login-decor left" aria-hidden="true" />
          <div className="login-decor right" aria-hidden="true" />
        </section>
      ) : (
        <>
          {mainTab === 'match' && (
            <section className="step-indicator">
              <span className={step === 'map' ? 'active' : ''}>1. 地图选址</span>
              <span className={step === 'profile' ? 'active' : ''}>2. 用户画像</span>
              <span className={step === 'result' ? 'active' : ''}>3. 匹配结果</span>
            </section>
          )}

          {mainTab === 'match' && step === 'map' && (
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
                    <div className="loading">
                      {mapLoadError || '地图加载中...'}
                      {mapLoadError && (
                        <button type="button" className="ghost mini-btn" onClick={() => void loadChinaMap()}>
                          重试加载
                        </button>
                      )}
                    </div>
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

          {mainTab === 'match' && step === 'profile' && (
            <section className="card">
              <div className="profile-head-inline">
                <h2>完善用户画像</h2>
                <button type="button" className="ghost mini-btn" onClick={resetProfileFields}>
                  重置
                </button>
              </div>
              <p className="hint">填得越完整，推荐越准确。你只需要选一种你最顺手的填写方式。</p>
              <form className="profile-form" onSubmit={handleProfileSubmit}>
            <label>
              身份类型
              <select
                value={profile.identity}
                onChange={(event) => {
                  const nextIdentity = event.target.value as Identity
                  setProfile((prev) => ({ ...prev, identity: nextIdentity }))
                  if (nextIdentity === 'citizen') {
                    setCitizenInputMode('structured')
                    setQaIndex(0)
                  }
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
            {profile.identity === 'citizen' ? (
              <>
                <div className="full-row profile-input-tabs">
                  <button
                    type="button"
                    className={citizenInputMode === 'structured' ? 'active' : ''}
                    onClick={() => switchCitizenInputMode('structured')}
                  >
                    快速填表
                  </button>
                  <button
                    type="button"
                    className={citizenInputMode === 'text' ? 'active' : ''}
                    onClick={() => switchCitizenInputMode('text')}
                  >
                    一句话描述
                  </button>
                  <button
                    type="button"
                    className={citizenInputMode === 'voice' ? 'active' : ''}
                    onClick={() => switchCitizenInputMode('voice')}
                  >
                    我来说你来填
                  </button>
                  <button
                    type="button"
                    className={citizenInputMode === 'qa' ? 'active' : ''}
                    onClick={() => switchCitizenInputMode('qa')}
                  >
                    一步步问我
                  </button>
                </div>
                {(citizenInputMode === 'structured' || citizenInputMode === 'qa') && (
                <div className="full-row quick-row">
                  {citizenProfileSamples.map((sample) => (
                    <button key={sample.id} type="button" className="ghost chip-button" onClick={() => applyCitizenSample(sample.id)}>
                      {sample.label}
                    </button>
                  ))}
                </div>
                )}
                {citizenInputMode === 'structured' && (
                  <>
                <label>
                  户籍/常住地类型
                  <select
                    value={profile.residence}
                    onChange={(event) => setProfile((prev) => ({ ...prev, residence: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value={`${selectedProvince || '本省'}户籍`}>{selectedProvince || '本省'}户籍</option>
                    <option value={`${selectedProvince || '本省'}常住`}>{selectedProvince || '本省'}常住</option>
                    <option value="异地就业">异地就业</option>
                  </select>
                </label>
                <label>
                  性别
                  <select
                    value={profile.gender}
                    onChange={(event) => setProfile((prev) => ({ ...prev, gender: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value="女">女</option>
                    <option value="男">男</option>
                    <option value="其他">其他</option>
                  </select>
                </label>
                <label>
                  年龄
                  <input
                    value={profile.age}
                    onChange={(event) => setProfile((prev) => ({ ...prev, age: event.target.value }))}
                    placeholder="例如 35"
                  />
                </label>
                <label>
                  子女数量
                  <input
                    value={profile.childrenCount}
                    onChange={(event) => setProfile((prev) => ({ ...prev, childrenCount: event.target.value }))}
                    placeholder="例如 2"
                  />
                </label>
                <label>
                  婚姻状态
                  <select
                    value={profile.maritalStatus}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, maritalStatus: event.target.value }))
                    }
                  >
                    <option value="">未填写</option>
                    <option value="未婚">未婚</option>
                    <option value="已婚">已婚</option>
                    <option value="离异">离异</option>
                  </select>
                </label>
                <label>
                  学历
                  <select
                    value={profile.educationLevel}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, educationLevel: event.target.value }))
                    }
                  >
                    <option value="">未填写</option>
                    <option value="高中及以下">高中及以下</option>
                    <option value="专科">专科</option>
                    <option value="本科">本科</option>
                    <option value="硕士及以上">硕士及以上</option>
                  </select>
                </label>
                <label>
                  就业状态
                  <select
                    value={profile.employmentStatus}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, employmentStatus: event.target.value }))
                    }
                  >
                    <option value="">未填写</option>
                    <option value="在职">在职</option>
                    <option value="待业">待业</option>
                    <option value="创业">创业</option>
                    <option value="退休">退休</option>
                  </select>
                </label>
                <label>
                  购房/租房需求
                  <select
                    value={profile.housingNeed}
                    onChange={(event) => setProfile((prev) => ({ ...prev, housingNeed: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value="购房">购房</option>
                    <option value="租房">租房</option>
                    <option value="暂无">暂无</option>
                  </select>
                </label>
                <label>
                  重点政策需求
                  <select
                    value={profile.policyNeed}
                    onChange={(event) => setProfile((prev) => ({ ...prev, policyNeed: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value="生育/育儿">生育/育儿</option>
                    <option value="社保补贴">社保补贴</option>
                    <option value="毕业生就业">毕业生就业</option>
                    <option value="创业补贴">创业补贴</option>
                    <option value="医疗救助">医疗救助</option>
                    <option value="低保/社会救助">低保/社会救助</option>
                    <option value="养老服务补贴">养老服务补贴</option>
                    <option value="残疾人补贴">残疾人补贴</option>
                    <option value="公租房/租金补贴">公租房/租金补贴</option>
                  </select>
                </label>
                <label>
                  出生地
                  <input
                    value={profile.birthPlace}
                    onChange={(event) => setProfile((prev) => ({ ...prev, birthPlace: event.target.value }))}
                    placeholder="例如 湖北省武汉市"
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
                  工作地
                  <input
                    value={profile.workPlace}
                    onChange={(event) => setProfile((prev) => ({ ...prev, workPlace: event.target.value }))}
                    placeholder="例如 上海市浦东新区"
                  />
                </label>
                <label>
                  社保连续缴纳
                  <select
                    value={profile.socialSecurityMonths}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, socialSecurityMonths: event.target.value }))
                    }
                  >
                    <option value="">未填写</option>
                    <option value="6个月">6个月</option>
                    <option value="12个月">12个月</option>
                    <option value="24个月">24个月</option>
                    <option value="36个月以上">36个月以上</option>
                  </select>
                </label>
                <label>
                  公积金连续缴纳
                  <select
                    value={profile.providentFundMonths}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, providentFundMonths: event.target.value }))
                    }
                  >
                    <option value="">未填写</option>
                    <option value="6个月">6个月</option>
                    <option value="12个月">12个月</option>
                    <option value="24个月">24个月</option>
                    <option value="36个月以上">36个月以上</option>
                  </select>
                </label>
                <label>
                  家庭标签
                  <input
                    value={profile.familyTag}
                    onChange={(event) => setProfile((prev) => ({ ...prev, familyTag: event.target.value }))}
                    placeholder="例如 赡养老人 / 单亲家庭"
                  />
                </label>
                <label>
                  是否残疾人家庭
                  <select
                    value={profile.disabilityStatus}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, disabilityStatus: event.target.value }))
                    }
                  >
                    <option value="">未填写</option>
                    <option value="是">是</option>
                    <option value="否">否</option>
                  </select>
                </label>
                <label>
                  是否退役军人
                  <select
                    value={profile.veteranStatus}
                    onChange={(event) => setProfile((prev) => ({ ...prev, veteranStatus: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value="是">是</option>
                    <option value="否">否</option>
                  </select>
                </label>
                <label>
                  是否低保/困难群体
                  <select
                    value={profile.lowIncomeStatus}
                    onChange={(event) => setProfile((prev) => ({ ...prev, lowIncomeStatus: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value="是">是</option>
                    <option value="否">否</option>
                  </select>
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
                  </>
                )}
                {citizenInputMode === 'text' && (
                  <div className="full-row profile-mode-panel">
                    <p className="hint">不会填表就写一句话：你在哪、做什么、家庭情况、你想申请什么，系统会自动帮你拆成表单。</p>
                    <textarea
                      rows={5}
                      value={profile.freeText}
                      onChange={(event) => updateProfileField('freeText', event.target.value)}
                      placeholder="例如：我在杭州工作，32岁，已婚有二孩，社保连续缴纳两年，想申请租房补贴。"
                    />
                    <div className="policy-actions">
                      <button type="button" onClick={applyNaturalLanguageToProfile}>
                        帮我自动填写
                      </button>
                    </div>
                  </div>
                )}
                {citizenInputMode === 'voice' && (
                  <div className="full-row profile-mode-panel">
                    <p className="hint">点“开始说话”后直接讲你的情况，系统会转成文字并自动填写关键信息。</p>
                    <div className="policy-actions">
                      <button type="button" onClick={isVoiceListening ? stopVoiceInput : startVoiceInput}>
                        {isVoiceListening ? '先停一下' : '开始说话'}
                      </button>
                      <button type="button" className="ghost" onClick={applyNaturalLanguageToProfile}>
                        自动整理成表单
                      </button>
                    </div>
                    {voiceError && <p className="empty-tip">{voiceError}</p>}
                    <textarea
                      rows={5}
                      value={profile.freeText}
                      onChange={(event) => updateProfileField('freeText', event.target.value)}
                      placeholder="你说的话会显示在这里，也可以自己改。"
                    />
                  </div>
                )}
                {citizenInputMode === 'qa' && currentQaQuestion && (
                  <div className="full-row profile-mode-panel qa-panel">
                    <p className="hint">
                      系统一步步问你：第 {Math.min(qaIndex + 1, citizenQaQuestions.length)} / {citizenQaQuestions.length} 题
                    </p>
                    <p className="scene-title">{currentQaQuestion.label}</p>
                    {currentQaQuestion.type === 'select' ? (
                      <select
                        value={(profile[currentQaQuestion.key] as string) || ''}
                        onChange={(event) =>
                          updateProfileField(currentQaQuestion.key, event.target.value as any)
                        }
                      >
                        {(currentQaQuestion.options ?? []).map((option) => (
                          <option key={`${currentQaQuestion.key}-${option || 'empty'}`} value={option}>
                            {option || '请选择'}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={(profile[currentQaQuestion.key] as string) || ''}
                        onChange={(event) =>
                          updateProfileField(currentQaQuestion.key, event.target.value as any)
                        }
                        placeholder={currentQaQuestion.placeholder || '请输入'}
                      />
                    )}
                    <div className="policy-actions">
                      <button type="button" className="ghost" onClick={() => setQaIndex((prev) => Math.max(prev - 1, 0))}>
                        上一题
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setQaIndex((prev) => Math.min(prev + 1, citizenQaQuestions.length - 1))
                        }
                      >
                        下一题
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <label>
                  企业注册地
                  <input
                    value={profile.workPlace}
                    onChange={(event) => setProfile((prev) => ({ ...prev, workPlace: event.target.value }))}
                    placeholder="例如 广东省深圳市"
                  />
                </label>
                <label>
                  行业
                  <input
                    value={profile.companyIndustry}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, companyIndustry: event.target.value }))
                    }
                    placeholder="例如 光伏 / 专精特新 / 住房租赁 / 农业"
                  />
                </label>
                <label>
                  员工规模
                  <input
                    value={profile.employeeCount}
                    onChange={(event) => setProfile((prev) => ({ ...prev, employeeCount: event.target.value }))}
                    placeholder="例如 50"
                  />
                </label>
                <label>
                  企业阶段
                  <select
                    value={profile.companyStage}
                    onChange={(event) => setProfile((prev) => ({ ...prev, companyStage: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value="专精特新/小巨人">专精特新/小巨人</option>
                    <option value="中小企业融资">中小企业融资</option>
                    <option value="房地产开发">房地产开发</option>
                    <option value="住房租赁">住房租赁</option>
                    <option value="科技型中小企业">科技型中小企业</option>
                  </select>
                </label>
                <label>
                  企业类型
                  <select
                    value={reviewInputs.enterpriseType}
                    onChange={(event) => {
                      setReviewInputs((prev) => ({ ...prev, enterpriseType: event.target.value }))
                      setProfile((prev) => ({ ...prev, companyStage: prev.companyStage || event.target.value }))
                    }}
                  >
                    <option value="">未填写</option>
                    <option value="小微企业">小微企业</option>
                    <option value="高新技术企业">高新技术企业</option>
                    <option value="科技型中小企业">科技型中小企业</option>
                    <option value="规模以上企业">规模以上企业</option>
                  </select>
                </label>
                <label>
                  年营收区间
                  <input
                    value={profile.annualIncome}
                    onChange={(event) => setProfile((prev) => ({ ...prev, annualIncome: event.target.value }))}
                    placeholder="例如 100-500 万"
                  />
                </label>
                <label>
                  年纳税区间
                  <input
                    value={profile.annualTaxBracket}
                    onChange={(event) =>
                      setProfile((prev) => ({ ...prev, annualTaxBracket: event.target.value }))
                    }
                    placeholder="例如 10-50 万"
                  />
                </label>
                <label>
                  重点政策需求
                  <select
                    value={profile.policyNeed}
                    onChange={(event) => setProfile((prev) => ({ ...prev, policyNeed: event.target.value }))}
                  >
                    <option value="">未填写</option>
                    <option value="税费减免">税费减免</option>
                    <option value="科技创新扶持">科技创新扶持</option>
                    <option value="人才引进">人才引进</option>
                    <option value="融资服务">融资服务</option>
                    <option value="稳岗补贴">稳岗补贴</option>
                  </select>
                </label>
              </>
            )}
            {(profile.identity === 'company' || citizenInputMode === 'structured' || citizenInputMode === 'qa') && (
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
            )}
            <div className="full-row profile-summary">
              <div className="summary-title">画像标签（实时更新）</div>
              <div className="tag-list">
                {profileTags.length > 0 ? (
                  profileTags.map((tag) => (
                    <span key={tag} className="tag-chip">
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="search-hint">还未生成标签，填写字段后会自动出现。</span>
                )}
              </div>
            </div>
            <div className="action-row">
              <button type="button" className="ghost" onClick={() => setStep('map')}>
                返回地图
              </button>
              <button type="submit">看看我能领哪些政策</button>
            </div>
              </form>
            </section>
          )}

          {mainTab === 'match' && step === 'result' && (
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
                          <p className="search-hint">官方咨询：{getOfficialPhone(item.province)}</p>
                          <div className="policy-actions">
                            <button type="button" onClick={() => setSelectedKnowledgePolicy(item)}>
                              查看详细解读
                            </button>
                            <span className="official-phone-tag">
                              {getOfficialPhone(item.province)}
                            </span>
                            <button type="button" className="ghost" onClick={() => addPolicyToTodoFromKnowledge(item)}>
                              加入我的待办
                            </button>
        <button
          type="button"
                              className="ghost"
                              onClick={() => addPolicyToFavoriteFromKnowledge(item)}
        >
                              加入我的收藏
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

              <section className="card" ref={resultSectionRef}>
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
                  <div className="policy-item">
                    <p className="policy-label">官方咨询电话</p>
                    <p className="policy-value">{policy.officialPhone || getOfficialPhone(selectedProvince || profile.residence || '全国')}</p>
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
                  <button type="button" className="ghost" onClick={() => addPolicyToTodoFromCard(policy)}>
                    加入我的待办
                  </button>
                  <button type="button" className="ghost" onClick={() => addPolicyToFavoriteFromCard(policy)}>
                    加入我的收藏
                  </button>
                  <span className="official-phone-tag">
                    {policy.officialPhone || getOfficialPhone(selectedProvince || profile.residence || '全国')}
                  </span>
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

          {mainTab === 'todo' && (
            <section className="card">
              <h2>我的待办</h2>
              <p className="hint">按步骤推进政策办理，系统会告诉你下一步该做什么、该准备什么材料。</p>
              <div className="todo-overview">
                <span>待办总数：{todoList.length}</span>
                <span>已完成：{todoCompletedCount}</span>
                <span>整体进度：{todoOverallProgress}%</span>
              </div>
              {todoList.length === 0 && <p className="empty-tip">还没有待办任务，可在政策卡片点击“加入我的待办”。</p>}
              <div className="todo-list">
                {todoList.map((item) => {
                  const progress = Math.round((item.currentStep / Math.max(item.steps.length, 1)) * 100)
                  const nextTip =
                    item.currentStep < item.steps.length
                      ? `下一步：${item.steps[item.currentStep]}`
                      : '已完成全部步骤，可留意资金拨付和复核通知。'
                  return (
                    <article key={item.id} className="todo-card">
                      <div className="result-head">
                        <h3>{item.title}</h3>
                        <span className={`tag ${progress >= 100 ? '完全符合' : '可能符合'}`}>
                          {progress >= 100 ? '已完成' : `进行中 ${progress}%`}
                        </span>
                      </div>
                      <p className="policy-value">地区：{item.provinceHint}</p>
                      <p className="policy-value">预计权益：{item.benefitHint}</p>
                      <div className="todo-progress-track" aria-hidden="true">
                        <span style={{ width: `${progress}%` }} />
                      </div>
                      <p className="search-hint">{nextTip}</p>
                      <div className="material-chip-row">
                        {item.materials.map((material) => (
                          <span key={`${item.id}-${material}`} className="material-chip">
                            {material}
                          </span>
                        ))}
                      </div>
                      <div className="todo-step-row">
                        {item.steps.map((stepName, index) => (
                          <button
                            key={`${item.id}-${stepName}`}
                            type="button"
                            className={index < item.currentStep ? '' : 'ghost'}
                            onClick={() => updateTodoStep(item.id, index + 1)}
                          >
                            完成：{stepName}
                          </button>
                        ))}
                        <button type="button" className="ghost" onClick={() => updateTodoStep(item.id, 0)}>
                          重置进度
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          )}

          {mainTab === 'favorite' && (
            <section className="card">
              <h2>我的收藏</h2>
              <p className="hint">收藏你重点关注的政策，后续可快速回看并转入待办。</p>
              {favoriteList.length === 0 && (
                <p className="empty-tip">还没有收藏内容，可在政策结果或搜索结果中点击“加入我的收藏”。</p>
              )}
              <div className="todo-list">
                {favoriteList.map((item) => (
                  <article key={item.id} className="todo-card">
                    <div className="result-head">
                      <h3>{item.title}</h3>
                      <span className="scenario-tag">{item.provinceHint}</span>
                    </div>
                    <p className="policy-value">{item.summary}</p>
                    <p className="search-hint">
                      收藏时间：{new Date(item.createdAt).toLocaleDateString()} {new Date(item.createdAt).toLocaleTimeString()}
                    </p>
                    <div className="policy-actions">
                      <button type="button" onClick={() => addPolicyToTodoFromCard({
                        name: item.title,
                        matchLevel: '可能符合',
                        audience: profile.identity,
                        targetGroup: profile.identity === 'company' ? '企业主体' : '个人用户',
                        scenario: selectedScenario || '全部',
                        benefit: item.summary,
                        applyStart: '请查看原文',
                        applyEnd: '请查看原文',
                        reason: '由用户收藏后转入待办',
                        nextStep: '先阅读政策原文，再准备申报材料',
                        sourceUrl: item.sourceUrl,
                      })}>
                        转入我的待办
                      </button>
                      {item.sourceUrl && (
                        <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="policy-link-button">
                          政策原文
                        </a>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {mainTab === 'gov' && govDashboardContent}
        </>
      )}
      <footer className="gov-footer">
        <div className="footer-links">
          <a href="#" onClick={(event) => event.preventDefault()}>
            关于我们
          </a>
          <a href="#" onClick={(event) => event.preventDefault()}>
            联系我们
          </a>
          <a href="#" onClick={(event) => event.preventDefault()}>
            网站声明
          </a>
          <a href="#" onClick={(event) => event.preventDefault()}>
            隐私政策
          </a>
          <a href="#" onClick={(event) => event.preventDefault()}>
            使用帮助
          </a>
        </div>
        <p>主办：全国政策服务协同平台（演示） ｜ 联系电话：{getOfficialPhone('全国')}</p>
        <p>建议使用 Chrome / Edge 最新版浏览器访问本平台</p>
      </footer>
    </main>
    {appOverlays}
    </>
  )
}

export default App
