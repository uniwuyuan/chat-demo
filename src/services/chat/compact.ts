import { streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import { useSettings } from '../settings.js'
import { applyCompaction, getVisibleSnapshot } from './store.js'
import type { Message } from './types.js'

/** 与 store 里保持一致的默认模型 */
const MODEL = 'deepseek-flash'
/** deepseek-flash 上下文窗口；只用来算预算，不参与请求 */
const CONTEXT_WINDOW_TOKENS = 131_072
/** 达到窗口的这个比例才会触发自动压缩；手动 /compact 不看阈值 */
const THRESHOLD_RATIO = 0.8
/** 保留尾部原文的预算比例（对应 dsh-compaction-basic 的 retainRatio） */
const RETAIN_RATIO = 0.16
/** 摘要至少压掉这么多条，否则不值得 */
const MIN_COMPACT_COUNT = 2

const SUMMARY_SYSTEM = '你负责把历史对话压缩成摘要，只输出摘要正文，不要寒暄、不要复述要求。'

const SUMMARY_PROMPT = `把下面的历史对话压缩成一份可以直接接着对话的中文摘要。

要求：
1. 保留：用户的真实目标、已确认的事实与结论、代码片段要点、文件路径、命令、尚未解决的问题。
2. 丢弃：寒暄、重复内容、被推翻的中间过程、工具调试噪音。
3. 用条目化 Markdown 输出，800 字以内。
4. 只输出摘要正文，不要写「以下是摘要」这类引导语。

历史对话：
`

/** 粗估 token：中文与代码混排时约每 2 个字符 1 token，只用于选择压缩范围 */
export const estimateTokens = (text: string) => Math.ceil(text.trim().length / 2)

/** 取一条消息可进入摘要的正文（思考块与服务端工具块不算） */
export const messageText = (message: Message) =>
  message.role === 'user'
    ? message.content
    : message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')

const renderTranscript = (messages: Message[]) =>
  messages
    .map((message) => {
      const text = messageText(message).trim()
      return text.length === 0 ? '' : `${message.role === 'user' ? '用户' : '助手'}：${text}`
    })
    .filter((line) => line.length > 0)
    .join('\n\n')

export type CompactOutcome =
  | { kind: 'done'; compacted: number; tokens: number }
  | { kind: 'empty' }
  | { kind: 'busy' }
  | { kind: 'failed' }

/**
 * 手动压缩：与 @deepseek-ai/dsh-compaction-basic 同一套思路——
 * 按保留预算从尾部往前留原文，其余整段交给模型摘要，再用摘要替换那一段。
 * 与官方实现的差别只有三处：token 用粗估、摘要走流式收集、没有检查点日志。
 */
export const compactSession = async (sessionId: string | null): Promise<CompactOutcome> => {
  if (sessionId === null) {
    return { kind: 'empty' }
  }
  const apiKey = useSettings.getState().apiKey
  if (!apiKey) {
    return { kind: 'failed' }
  }
  const snapshot = getVisibleSnapshot(sessionId)
  if (!snapshot || snapshot.messages.length === 0) {
    return { kind: 'empty' }
  }
  const history = snapshot.messages
  const retainBudget = Math.floor(CONTEXT_WINDOW_TOKENS * THRESHOLD_RATIO * RETAIN_RATIO)

  // 从末尾往前累计，超出保留预算的位置就是压缩边界
  let keepFrom = history.length
  let kept = 0
  while (keepFrom > 0) {
    const size = estimateTokens(messageText(history[keepFrom - 1]))
    if (kept + size > retainBudget && keepFrom < history.length) {
      break
    }
    kept += size
    keepFrom -= 1
  }
  // 保留部分必须从提问开始，否则摘要与原文之间会出现两条连续 assistant，服务端会拒绝
  while (keepFrom < history.length && history[keepFrom].role !== 'user') {
    keepFrom += 1
  }
  if (keepFrom < MIN_COMPACT_COUNT || keepFrom >= history.length) {
    return { kind: 'empty' }
  }

  const compactedMessages = history.slice(0, keepFrom)
  const transcript = renderTranscript(compactedMessages)
  if (transcript.length === 0) {
    return { kind: 'empty' }
  }

  const body: CreateMessageRequest = {
    model: MODEL,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: `${SUMMARY_PROMPT}${transcript}` }],
    thinking: { type: 'disabled' },
    tools: [],
    safety_check: { level: 'high' },
  }

  const controller = new AbortController()
  let summary = ''
  try {
    for await (const event of streamMessage(apiKey, body, controller.signal)) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        summary += event.delta.text
      }
    }
  } catch {
    return { kind: 'failed' }
  }

  const text = summary.trim()
  if (text.length === 0) {
    return { kind: 'failed' }
  }
  const tokens = compactedMessages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0)
  const applied = applyCompaction(sessionId, text, history.slice(keepFrom))
  return applied ? { kind: 'done', compacted: compactedMessages.length, tokens } : { kind: 'busy' }
}
