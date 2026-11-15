import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import { logError, logInfo } from '../debug/log.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'
import { deleteBackups, listBackups, saveBackup } from '../backupStore.js'
import { useSettings } from '../settings.js'

const LAST_BACKUP_KEY = 'chat-demo:last-backup'
const BACKUP_INTERVAL = 24 * 60 * 60 * 1000

export const lastBackupAt = (): number => Number(localStorage.getItem(LAST_BACKUP_KEY) ?? '') || 0

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    logInfo('import', `开始校验归档：${file.name}`, { size: file.size, type: file.type })
    try {
      await checkArchiveFormat(file)
      logInfo('import', '格式校验通过')
    } catch (error) {
      logError('import', '格式校验失败', error)
      throw error
    }
    const count = await replaceHistory(async () => {
      try {
        await importArchive(file)
        logInfo('import', '已写入暂存')
      } catch (error) {
        logError('import', '读取归档内容失败', error)
        throw error
      }
    })
    logInfo('import', '已替换本地历史', { sessions: count })
    // 导入完成立刻留一份备份：覆盖式导入是不可逆操作
    void autoBackup(true)
    return count
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })

/**
 * 自动备份：开启时每天首次进入把全部会话导出一份 ZIP 到「下载」。
 * IndexedDB 被系统清理时，这份文件就是唯一的回滚点。
 */
export const autoBackup = async (force = false): Promise<string | null> => {
  if (!useSettings.getState().autoBackup && !force) {
    return null
  }
  if (!force && Date.now() - lastBackupAt() < BACKUP_INTERVAL) {
    return null
  }
  if (useChatStore.getState().sessions.length === 0) {
    return null
  }
  try {
    const { blob } = await exportHistory()
    // 文件名带时间戳：同一天多次备份不会互相覆盖，也便于按时间点回滚
    const stamp = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const name =
      `chat-demo-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.zip`
    await saveBackup(name, blob)
    localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()))
    logInfo('backup', '已生成自动备份', { name, bytes: blob.size })
    pruneBackups()
    return name
  } catch (error) {
    logError('backup', '自动备份失败', error)
    return null
  }
}

/** 只保留最近 these 份，避免备份目录无限增长 */
export const BACKUP_KEEP = 12

export const pruneBackups = () => {
  const files = listBackups()
  if (files.length <= BACKUP_KEEP) {
    return 0
  }
  const stale = files
    .slice()
    .sort((a, b) => b.modified - a.modified)
    .slice(BACKUP_KEEP)
    .map((item) => item.name)
  const removed = deleteBackups(stale)
  logInfo('backup', '清理旧备份', { removed })
  return removed
}
