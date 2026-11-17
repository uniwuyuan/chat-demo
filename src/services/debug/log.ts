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

const LIMIT = 1200
const STORE_KEY = 'chat-demo:log'
/** 落盘上限，超出时丢最早的 */
const MAX_CHARS = 512_000

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
  // info 跟随开关；warn/error 无条件记录——出问题时用户往往没开日志开关
  if (level === 'info' && !useSettings.getState().debugLog) {
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

/** 最近 n 行的纯文本，用于错误提示里直接贴给开发者 */
export const logSnapshot = (n = 40): string =>
  useLogs
    .getState()
    .entries.slice(-n)
    .map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 23)
      const head = `${time} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}`
      return entry.detail ? `${head} :: ${entry.detail.replace(/\n/g, ' | ')}` : head
    })
    .join('\n')

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

const describe = (value: unknown): string => {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  }
  if (typeof value === 'string') {
    return value.slice(0, 2000)
  }
  try {
    return JSON.stringify(value, null, 2).slice(0, 2000)
  } catch {
    return String(value)
  }
}

const trimBody = (text: string, max = 600): string =>
  text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字）` : text

/** 把 console / fetch / XHR / 存储 / 资源加载全部接进同一份日志 */
const installDeepCapture = () => {
  // console：第三方库的报错也收
  const levels: Array<'warn' | 'error'> = ['warn', 'error']
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        const text = args.map((item) => describe(item)).join(' ')
        append(level, 'console', trimBody(text, 400))
      } catch {
        // 记录失败不能反过来影响业务
      }
      original(...args)
    }
  }

  // fetch：每个请求的方法、状态、耗时、失败原因、错误体
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const startedAt = Date.now()
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
      const quiet = /\/v1\/tools\/tts|\/files$/.test(url)
      try {
        const response = await originalFetch(input, init)
        const ms = Date.now() - startedAt
        if (!quiet) {
          logInfo('http', `${method} ${url} → ${response.status} · ${ms}ms`)
        }
        if (!response.ok && !quiet) {
          // 错误响应体对定位最有用，用 clone 读，不消费原流
          response
            .clone()
            .text()
            .then((body) => logError('http', `${method} ${url} → ${response.status}`, trimBody(body)))
            .catch(() => undefined)
        }
        return response
      } catch (error) {
        logError('http', `${method} ${url} 请求未发出`, describe(error))
        throw error
      }
    }
  }

  // XHR：原生壳或旧代码可能走这条
  if (typeof XMLHttpRequest !== 'undefined') {
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string) {
      ;(this as unknown as { __logMethod?: string; __logUrl?: string }).__logMethod = method
      ;(this as unknown as { __logUrl?: string }).__logUrl = url
      return originalOpen.apply(this, arguments as never)
    } as typeof XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest) {
      const meta = this as unknown as { __logMethod?: string; __logUrl?: string }
      const startedAt = Date.now()
      this.addEventListener('loadend', () => {
        const ms = Date.now() - startedAt
        const line = `${meta.__logMethod ?? 'GET'} ${meta.__logUrl ?? ''} → ${this.status} · ${ms}ms`
        if (this.status >= 400 || this.status === 0) {
          logError('xhr', line, trimBody(this.responseText ?? ''))
        } else {
          logInfo('xhr', line)
        }
      })
      return originalSend.apply(this, arguments as never)
    } as typeof XMLHttpRequest.prototype.send
  }

  // 存储写入失败（配额满 / 隐私模式）会导致“数据损坏”类误判，必须留痕
  try {
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      try {
        return originalSetItem.call(this, key, value)
      } catch (error) {
        logError('storage', `写入失败 ${key}（${Math.round(value.length / 1024)}KB）`, describe(error))
        throw error
      }
    }
  } catch (error) {
    logWarn('storage', '无法包装 localStorage', describe(error))
  }

  // IndexedDB 打不开也是一类“数据损坏”
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function') {
    const originalOpenDb = indexedDB.open.bind(indexedDB)
    indexedDB.open = ((...args: Parameters<IDBFactory['open']>) => {
      const request = originalOpenDb(...args)
      request.addEventListener('error', () => {
        logError('idb', `打开数据库失败 ${String(args[0])}`, describe(request.error))
      })
      request.addEventListener('blocked', () => {
        logWarn('idb', `数据库被旧页面占用 ${String(args[0])}`)
      })
      return request
    }) as IDBFactory['open']
  }

  // 资源加载失败（脚本 / 图片）
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target as HTMLElement | null
      if (target && target !== (window as unknown as HTMLElement)) {
        const src = (target as HTMLImageElement).src ?? (target as HTMLScriptElement).src
        logError('resource', `加载失败 ${target.tagName}`, src)
      }
    },
    true
  )
}

/** 环境快照：一眼看出是不是环境问题（存储、内存、时区、UA） */
const logEnvironment = () => {
  const nav = navigator as Navigator & { deviceMemory?: number }
  let quota = ''
  if (navigator.storage?.estimate) {
    navigator.storage
      .estimate()
      .then(({ usage, quota: total }) => {
        logInfo('env', '存储用量', {
          usedMB: usage ? Math.round(usage / 1024 / 1024) : null,
          quotaMB: total ? Math.round(total / 1024 / 1024) : null,
        })
      })
      .catch(() => undefined)
  }
  logInfo('env', '环境', {
    ua: navigator.userAgent.slice(0, 160),
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    memoryGB: nav.deviceMemory ?? null,
    hardware: navigator.hardwareConcurrency ?? null,
    quota,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
  })
}

/** 把原生外壳（文件选择器、录音授权）和全局异常都接进同一份日志 */
export const installLogCapture = (version: string) => {
  window.addEventListener('error', (event) => {
    logError('window', event.message, event.error)
  })
  window.addEventListener('unhandledrejection', (event) => {
    logError('promise', '未处理的 Promise 拒绝', event.reason)
  })
  try {
    installDeepCapture()
    logEnvironment()
  } catch (error) {
    logWarn('app', '深度日志抓取安装失败', describe(error))
  }
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
