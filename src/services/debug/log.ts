import { create } from 'zustand'
import { useSettings } from '../settings.js'

export type LogLevel = 'info' | 'warn' | 'error'

export type LogEntry = {
  id: number
  at: number
  level: LogLevel
  /** 来源：app / settings / import / shell / request … */
  scope: string
  message: string
  /** 附加信息：错误栈、字段快照等，可空 */
  detail?: string
}

const LIMIT = 400
const STORE_KEY = 'chat-demo:log'
/** 落盘上限，超出时丢最早的 */
const MAX_CHARS = 120_000

const load = (): LogEntry[] => {
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
      (item): item is LogEntry =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as LogEntry).at === 'number' &&
        typeof (item as LogEntry).message === 'string'
    )
  } catch {
    return []
  }
}

type LogState = { entries: LogEntry[] }

export const useLogs = create<LogState>(() => ({ entries: load() }))

let sequence = 0
let flushTimer = 0

const persist = () => {
  window.clearTimeout(flushTimer)
  flushTimer = window.setTimeout(() => {
    try {
      const entries = useLogs.getState().entries
      let text = JSON.stringify(entries)
      while (text.length > MAX_CHARS && entries.length > 1) {
        entries.shift()
        text = JSON.stringify(entries)
      }
      localStorage.setItem(STORE_KEY, text)
    } catch {
      // 存不下就算了，内存里的还能看
    }
  }, 400)
}

const formatDetail = (detail: unknown): string | undefined => {
  if (detail === undefined || detail === null) {
    return undefined
  }
  if (detail instanceof Error) {
    return `${detail.name}: ${detail.message}${detail.stack ? `\n${detail.stack}` : ''}`
  }
  if (typeof detail === 'string') {
    return detail
  }
  try {
    return JSON.stringify(detail, null, 2)
  } catch {
    return String(detail)
  }
}

const append = (level: LogLevel, scope: string, message: string, detail?: unknown) => {
  if (!useSettings.getState().debugLog) {
    return
  }
  const entry: LogEntry = {
    id: ++sequence,
    at: Date.now(),
    level,
    scope,
    message,
    detail: formatDetail(detail),
  }
  useLogs.setState((state) => {
    const entries = [...state.entries, entry]
    return { entries: entries.length > LIMIT ? entries.slice(entries.length - LIMIT) : entries }
  })
  if (level !== 'info') {
    const line = `[${scope}] ${message}`
    if (level === 'error') {
      console.error(line, detail ?? '')
    } else {
      console.warn(line, detail ?? '')
    }
  }
  persist()
}

export const logInfo = (scope: string, message: string, detail?: unknown) =>
  append('info', scope, message, detail)
export const logWarn = (scope: string, message: string, detail?: unknown) =>
  append('warn', scope, message, detail)
export const logError = (scope: string, message: string, detail?: unknown) =>
  append('error', scope, message, detail)

export const clearLogs = () => {
  useLogs.setState({ entries: [] })
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    // 忽略
  }
}

export const logText = (): string =>
  useLogs
    .getState()
    .entries.map((entry) => {
      const time = new Date(entry.at).toISOString()
      const head = `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`
      return entry.detail ? `${head}\n    ${entry.detail.replace(/\n/g, '\n    ')}` : head
    })
    .join('\n')

/** 把原生外壳（文件选择器、录音授权）和全局异常都接进同一份日志 */
export const installLogCapture = (version: string) => {
  window.addEventListener('error', (event) => {
    logError('window', event.message, event.error)
  })
  window.addEventListener('unhandledrejection', (event) => {
    logError('promise', '未处理的 Promise 拒绝', event.reason)
  })
  // 原生壳会调用这个钩子记录文件选择器等事件
  ;(window as unknown as { __chatDemoLog?: (message: string) => void }).__chatDemoLog = (message) =>
    logInfo('shell', message)
  window.addEventListener('pagehide', () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(useLogs.getState().entries))
    } catch {
      // 忽略
    }
  })
  logInfo('app', `启动 v${version}`, {
    origin: location.origin,
    ua: navigator.userAgent.slice(0, 120),
  })
}
