import { getVisibleMessages } from './chat/branches.js'
import type { Session } from './chat/types.js'

/** deepseek-flash 的上下文窗口 1M，用于把估算换算成占比 */
export const CONTEXT_WINDOW = 1_000_000
/** 系统提示的估算 token */
export const SYSTEM_TOKENS = 52
/** 工具声明（read_url + 可选 web_search）的估算 token */
export const TOOLS_TOKENS = 80

/** 一张图片在请求里按约 560 token 计（1080p 截图的量级） */
const IMAGE_TOKENS = 560

/**
 * 正文按字符数估算 token（中英混排约每 2 字符 1 token）；
 * 工具结果块与附件同样会进请求，不能只算正文，否则会比真实用量低一截。
 */
const messageTokens = (session: Session): number => {
  let chars = 0
  let toolChars = 0
  let images = 0
  for (const message of getVisibleMessages(session)) {
    if (message.role === 'user') {
      chars += message.content.length
      images += message.files.filter((file) => file.serverId !== null).length
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'text') {
        chars += block.text.length
      } else {
        // 服务端工具块（搜索、阅读链接）以 JSON 回传，按序列化长度折算
        toolChars += JSON.stringify(block).length
      }
    }
  }
  return Math.ceil(chars / 2) + Math.ceil(toolChars / 2) + images * IMAGE_TOKENS
}

export type ContextEstimate = {
  tokens: number
  messageTokens: number
  systemTokens: number
  toolTokens: number
  ratio: number
}

/** 估算「下一次请求」的上下文规模；与真实用量会有偏差，只用于提示水位 */
export const estimateContext = (session: Session | null | undefined): ContextEstimate => {
  const messages = session ? messageTokens(session) : 0
  const tokens = messages + SYSTEM_TOKENS + TOOLS_TOKENS
  return {
    tokens,
    messageTokens: messages,
    systemTokens: SYSTEM_TOKENS,
    toolTokens: TOOLS_TOKENS,
    ratio: tokens / CONTEXT_WINDOW,
  }
}

/** 水位配色：<50% 蓝、50–80% 黄、>80% 红 */
export const contextTone = (ratio: number) =>
  ratio >= 0.8 ? ('bad' as const) : ratio >= 0.5 ? ('warn' as const) : ('ok' as const)

export const contextColor = (ratio: number) =>
  contextTone(ratio) === 'bad' ? '#dc2626' : contextTone(ratio) === 'warn' ? '#d97706' : '#4d6bfe'

export type RequestParts = { system: number; user: number; assistant: number; other: number }

const charsOf = (content: unknown): number => {
  if (typeof content === 'string') {
    return content.length
  }
  if (Array.isArray(content)) {
    return content.reduce((sum: number, block: unknown) => {
      if (typeof block !== 'object' || block === null) {
        return sum
      }
      const item = block as { type?: string; text?: string }
      if (item.type === 'text' && typeof item.text === 'string') {
        return sum + item.text.length
      }
      // 图片/文档块按固定 token 计，这里先用占位字符量表示
      return item.type === 'image' || item.type === 'document' ? sum + IMAGE_TOKENS * 2 : sum
    }, 0)
  }
  return 0
}

/** 按真实请求体拆分输入构成，供「Token 统计」显示 */
export const splitRequestParts = (
  messages: { role: string; content: unknown }[],
  toolsChars = 320
): RequestParts => {
  let user = 0
  let assistant = 0
  for (const message of messages) {
    if (message.role === 'user') {
      user += charsOf(message.content)
    } else if (message.role === 'assistant') {
      assistant += charsOf(message.content)
    } else {
      // latest_reminder 这类附属块
      user += charsOf(message.content)
    }
  }
  return {
    system: SYSTEM_TOKENS,
    user: Math.ceil(user / 2),
    assistant: Math.ceil(assistant / 2),
    other: Math.ceil(toolsChars / 2),
  }
}
