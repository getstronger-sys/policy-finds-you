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

      const data = await response.json()
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
      const data = await response.json()
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
      setInterpretError(error instanceof Error ? error.message : '解读请求失败')
    } finally {
      setInterpretLoading(false)
    }
  }

  const closeInterpretation = () => {
    setSelectedPolicy(null)
    setPolicyInterpretation(null)
    setInterpretError('')
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
              {!interpretLoading && !interpretError && policyInterpretation && (
                <>
                  <section>
                    <h4>通俗总结</h4>
                    <p>{policyInterpretation.summary}</p>
                  </section>
                  <section>
                    <h4>适用条件</h4>
                    <ul>
                      {policyInterpretation.eligibility.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h4>常见不符合原因</h4>
                    <ul>
                      {policyInterpretation.disqualifiers.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h4>办理清单</h4>
                    <ul>
                      {policyInterpretation.checklist.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h4>风险提醒</h4>
                    <ul>
                      {policyInterpretation.riskTips.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                </>
              )}
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
    </main>
  )
}

export default App
