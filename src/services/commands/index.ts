import { showToast } from '../../components/base/toastState.js'
import { translate, type TranslationKey } from '../../i18n/index.js'
import { exportHistory } from '../chat/backup.js'
import { compactSession } from '../chat/compact.js'
import { newChat, removeSession } from '../chat/store.js'
import { downloadBlob } from '../../utils/download.js'

export type CommandContext = {
  /** 当前会话；欢迎页为 null */
  sessionId: string | null
  /** 斜杠命令后面的参数原文 */
  args: string
}

export type CommandDefinition = {
  name: string
  label: TranslationKey
  hint: TranslationKey
  run: (context: CommandContext) => Promise<void> | void
}

const saveBlob = downloadBlob

const compact: CommandDefinition = {
  name: 'compact',
  label: 'commandCompactLabel',
  hint: 'commandCompactHint',
  run: async ({ sessionId, args }) => {
    if (args.trim().length > 0) {
      showToast({ key: 'commandCompactUsage' })
      return
    }
    const outcome = await compactSession(sessionId)
    switch (outcome.kind) {
      case 'done':
        showToast({
          key: 'commandCompactDone',
          params: { count: outcome.compacted, tokens: outcome.tokens },
        })
        return
      case 'empty':
        showToast({ key: 'commandCompactEmpty' })
        return
      case 'busy':
        showToast({ key: 'commandCompactBusy' })
        return
      case 'failed':
        showToast({ key: 'commandCompactFailed', type: 'error' })
        return
    }
  },
}

const newSession: CommandDefinition = {
  name: 'new',
  label: 'commandNewLabel',
  hint: 'commandNewHint',
  run: () => {
    newChat()
  },
}

const clear: CommandDefinition = {
  name: 'clear',
  label: 'commandClearLabel',
  hint: 'commandClearHint',
  run: async ({ sessionId }) => {
    if (sessionId === null) {
      return
    }
    if (!window.confirm(translate('commandClearConfirm'))) {
      return
    }
    await removeSession(sessionId)
    newChat()
  },
}

const exportAll: CommandDefinition = {
  name: 'export',
  label: 'commandExportLabel',
  hint: 'commandExportHint',
  run: async () => {
    try {
      const { name, blob } = await exportHistory()
      saveBlob(name, blob)
      showToast({ key: 'commandExportDone' })
    } catch {
      showToast({ key: 'commandExportEmpty', type: 'error' })
    }
  },
}

const help: CommandDefinition = {
  name: 'help',
  label: 'commandHelpLabel',
  hint: 'commandHelpHint',
  run: () => {
    showToast({ key: 'commandHelpToast' })
  },
}

/** 注册表；顺序即面板顺序 */
export const commands: CommandDefinition[] = [compact, newSession, clear, exportAll, help]

const byName = new Map(commands.map((command) => [command.name, command]))

export type ParsedCommand = { command: CommandDefinition; args: string }

/**
 * 只认「行首紧贴斜杠 + 已注册命令名」。
 * `/ 内容`（斜杠后带空格）、`／compact`（全角）、`/usr/bin 是什么`（未注册）都会退回普通消息。
 */
export const parseCommand = (input: string): ParsedCommand | null => {
  const match = /^\/([a-z][\w-]*)(?:[ \t]+([\s\S]*))?$/i.exec(input.trim())
  if (!match) {
    return null
  }
  const command = byName.get(match[1].toLowerCase())
  return command ? { command, args: match[2] ?? '' } : null
}

/** 正在输入命令名时用于面板过滤；出现空格或换行就不再当命令 */
export const matchCommandQuery = (input: string): string | null => {
  const match = /^\/([\w-]*)$/.exec(input.trim())
  return match ? match[1].toLowerCase() : null
}

export const filterCommands = (query: string) =>
  query.length === 0 ? commands : commands.filter((command) => command.name.startsWith(query))
