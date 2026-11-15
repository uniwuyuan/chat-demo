import { create } from 'zustand'

/** 一次请求的用量快照：来自 message_delta 的 usage（整轮累计） */
export type UsageRecord = {
  id: string
  at: number
  model: string
  /** 归属会话；旧记录没有这个字段时按「全部」统计 */
  sessionId?: string
  /** 本轮请求耗时（毫秒），用于活跃时长与输出速度 */
  ms?: number
  /** 输入的内容构成（token 估算）：系统提示词 / 用户消息 / 历史回答 / 附件与工具 */
  parts?: { system: number; user: number; assistant: number; other: number }
  /** 未命中缓存的输入 */
  input: number
  /** 命中缓存的输入 */
  cacheRead: number
  /** 写入缓存的输入（按未命中计费） */
  cacheWrite: number
  output: number
}

const STORE_KEY = 'chat-demo:usage'
const LIMIT = 500

/** 官方价（USD / 1M tokens），deepseek-flash：峰谷价差一倍 */
export const PRICES = {
  hit: { peak: 0.006, off: 0.003 },
  miss: { peak: 0.3, off: 0.15 },
  output: { peak: 1.2, off: 0.6 },
} as const

/** 北京时间对应的 UTC 峰时：周一至周五 01:00–04:00 与 06:00–10:00 UTC */
export const isPeak = (at: number): boolean => {
  const date = new Date(at)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

export type Cost = { usd: number; cny: number; peak: boolean }

/** 按官方分项计费：缓存命中、缓存未命中（含缓存写入）、输出 */
export const costOf = (record: UsageRecord, cnyRate: number): Cost => {
  const peak = isPeak(record.at)
  const tier = peak ? 'peak' : 'off'
  const usd =
    record.cacheRead * PRICES.hit[tier] +
    (record.input + record.cacheWrite) * PRICES.miss[tier] +
    record.output * PRICES.output[tier]
  return { usd: usd / 1e6, cny: (usd / 1e6) * cnyRate, peak }
}

export type UsageTotals = {
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  tokens: number
  /** 命中率：命中输入 / 全部输入 */
  hitRate: number
  usd: number
  cny: number
}

export const totalsOf = (records: UsageRecord[], cnyRate: number): UsageTotals => {
  const totals = records.reduce(
    (acc, record) => {
      const cost = costOf(record, cnyRate)
      return {
        requests: acc.requests + 1,
        input: acc.input + record.input,
        cacheRead: acc.cacheRead + record.cacheRead,
        cacheWrite: acc.cacheWrite + record.cacheWrite,
        output: acc.output + record.output,
        usd: acc.usd + cost.usd,
        cny: acc.cny + cost.cny,
      }
    },
    { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, cny: 0 }
  )
  const tokens = totals.input + totals.cacheRead + totals.cacheWrite + totals.output
  const inputTotal = totals.input + totals.cacheRead + totals.cacheWrite
  return { ...totals, tokens, hitRate: inputTotal === 0 ? 0 : totals.cacheRead / inputTotal }
}

const load = (): UsageRecord[] => {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is UsageRecord =>
        typeof item === 'object' && item !== null && typeof (item as UsageRecord).at === 'number'
    )
  } catch {
    return []
  }
}

type UsageState = { records: UsageRecord[]; cnyRate: number }

export const useUsage = create<UsageState>(() => ({
  records: load(),
  // 只用于把美元折算成人民币展示，可随时改
  cnyRate: Number(localStorage.getItem('chat-demo:cny-rate') ?? '') || 7.1,
}))

const persist = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(useUsage.getState().records))
  } catch {
    // 存不下就只留内存
  }
}

export const recordUsage = (record: Omit<UsageRecord, 'id'>) => {
  const entry: UsageRecord = { ...record, id: `${record.at}-${Math.random().toString(36).slice(2, 8)}` }
  useUsage.setState((state) => {
    const records = [...state.records, entry]
    return { records: records.length > LIMIT ? records.slice(records.length - LIMIT) : records }
  })
  persist()
}

export const clearUsage = () => {
  useUsage.setState({ records: [] })
  persist()
}

export const setCnyRate = (rate: number) => {
  const value = Number.isFinite(rate) && rate > 0 ? rate : 7.1
  try {
    localStorage.setItem('chat-demo:cny-rate', String(value))
  } catch {
    // 忽略
  }
  useUsage.setState({ cnyRate: value })
}

/** 按自然日汇总（本地时区），用于柱状趋势 */
export const byDay = (records: UsageRecord[], cnyRate: number, days = 7) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const buckets: { label: string; start: number; totals: UsageTotals }[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const start = today.getTime() - offset * 86_400_000
    const end = start + 86_400_000
    const slice = records.filter((record) => record.at >= start && record.at < end)
    buckets.push({
      label: `${new Date(start).getMonth() + 1}/${new Date(start).getDate()}`,
      start,
      totals: totalsOf(slice, cnyRate),
    })
  }
  return buckets
}

/** 某个会话的累计用量；sessionId 为空时返回全部记录 */
export const totalsForSession = (records: UsageRecord[], sessionId: string | null, cnyRate: number) =>
  totalsOf(
    sessionId === null ? records : records.filter((record) => record.sessionId === sessionId),
    cnyRate
  )

export type UsageRange = 'today' | '7d' | '30d' | 'all'

const RANGE_DAYS: Record<UsageRange, number> = { today: 1, '7d': 7, '30d': 30, all: 3650 }

export const filterByRange = (records: UsageRecord[], range: UsageRange): UsageRecord[] => {
  if (range === 'all') {
    return records
  }
  const start = new Date().setHours(0, 0, 0, 0) - (RANGE_DAYS[range] - 1) * 86_400_000
  return records.filter((record) => record.at >= start)
}

export type SessionUsage = {
  /** null 表示旧记录没有会话归属 */
  sessionId: string | null
  totals: UsageTotals
  lastAt: number
  /** 最近一次请求的输入总量，用于估算该会话的上下文水位 */
  contextTokens: number
}

/** 按会话聚合并按最近使用时间排序 */
export const bySession = (records: UsageRecord[], cnyRate: number): SessionUsage[] => {
  const groups = new Map<string | null, UsageRecord[]>()
  for (const record of records) {
    const key = record.sessionId ?? null
    const list = groups.get(key)
    if (list) {
      list.push(record)
    } else {
      groups.set(key, [record])
    }
  }
  return [...groups.entries()]
    .map(([sessionId, list]) => {
      const sorted = [...list].sort((a, b) => a.at - b.at)
      const last = sorted[sorted.length - 1]
      return {
        sessionId,
        totals: totalsOf(sorted, cnyRate),
        lastAt: last.at,
        contextTokens: last.input + last.cacheRead + last.cacheWrite,
      }
    })
    .sort((a, b) => b.lastAt - a.lastAt)
}

/** 逐日 token 与费用，用于柱状图 */
export const tokensByDay = (records: UsageRecord[], cnyRate: number, days = 7) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const buckets: { label: string; start: number; tokens: number; cny: number }[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const start = today.getTime() - offset * 86_400_000
    const end = start + 86_400_000
    const totals = totalsOf(
      records.filter((record) => record.at >= start && record.at < end),
      cnyRate
    )
    buckets.push({
      label: `${new Date(start).getMonth() + 1}/${new Date(start).getDate()}`,
      start,
      tokens: totals.tokens,
      cny: totals.cny,
    })
  }
  return buckets
}

export type UsageParts = { system: number; user: number; assistant: number; other: number }

/** 汇总输入的内容构成；老记录没有 parts 时按总量归到「用户消息」 */
export const partsOf = (records: UsageRecord[]): UsageParts =>
  records.reduce<UsageParts>(
    (acc, record) => {
      if (record.parts) {
        return {
          system: acc.system + record.parts.system,
          user: acc.user + record.parts.user,
          assistant: acc.assistant + record.parts.assistant,
          other: acc.other + record.parts.other,
        }
      }
      return {
        ...acc,
        user: acc.user + record.input + record.cacheRead + record.cacheWrite,
      }
    },
    { system: 0, user: 0, assistant: 0, other: 0 }
  )

/** 活跃时长与输出速度 */
export const paceOf = (records: UsageRecord[]) => {
  const ms = records.reduce((sum, record) => sum + (record.ms ?? 0), 0)
  const output = records.reduce((sum, record) => sum + record.output, 0)
  return { ms, speed: ms > 0 ? output / (ms / 1000) : 0 }
}

/** 热力图：最近 n 周，按周一起始排列 */
export const heatmapOf = (records: UsageRecord[], weeks = 8) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // 往前找到本周一
  const offsetToMonday = (today.getDay() + 6) % 7
  const start = today.getTime() - offsetToMonday * 86_400_000 - (weeks - 1) * 7 * 86_400_000
  const cells: { start: number; tokens: number; label: string }[] = []
  for (let index = 0; index < weeks * 7; index++) {
    const dayStart = start + index * 86_400_000
    const dayEnd = dayStart + 86_400_000
    const tokens = records
      .filter((record) => record.at >= dayStart && record.at < dayEnd)
      .reduce((sum, record) => sum + record.input + record.cacheRead + record.cacheWrite + record.output, 0)
    cells.push({
      start: dayStart,
      tokens,
      label: `${new Date(dayStart).getMonth() + 1}/${new Date(dayStart).getDate()}`,
    })
  }
  return cells
}
