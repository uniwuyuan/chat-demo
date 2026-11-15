import { logInfo, logWarn } from './debug/log.js'

/**
 * 备份文件读写的统一入口：
 * - APK 里走原生 AndroidShell，备份写进 Download/DeepSeekChatDemo/backups
 * - 浏览器里没有目录访问能力，退回普通下载 + localStorage 索引
 */
type Bridge = {
  listBackups?: () => string
  deleteBackups?: (namesJson: string) => number
  readBackupChunk?: (name: string, offset: number, length: number) => string | null
  saveFile?: (name: string, mime: string, base64: string) => void
}

const bridge = () => (window as unknown as { AndroidShell?: Bridge }).AndroidShell

export const hasNativeBackups = () => typeof bridge()?.listBackups === 'function'

export type BackupEntry = { name: string; size: number; modified: number }

const INDEX_KEY = 'chat-demo:backup-index'

const readIndex = (): BackupEntry[] => {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as BackupEntry[]) : []
  } catch {
    return []
  }
}

const writeIndex = (entries: BackupEntry[]) => {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(entries))
  } catch {
    // 索引写不进去时只影响浏览器里的列表展示
  }
}

export const listBackups = (): BackupEntry[] => {
  const api = bridge()
  if (api?.listBackups) {
    try {
      const parsed: unknown = JSON.parse(api.listBackups())
      return Array.isArray(parsed) ? (parsed as BackupEntry[]) : []
    } catch (error) {
      logWarn('backup', '备份列表解析失败', error)
      return []
    }
  }
  return readIndex()
}

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })

export const saveBackup = async (name: string, blob: Blob): Promise<void> => {
  const api = bridge()
  if (api?.saveFile) {
    const base64 = await blobToBase64(blob)
    api.saveFile(name, 'application/zip', base64)
    logInfo('backup', '备份已写入专有目录', { name, bytes: blob.size })
    return
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  writeIndex([
    { name, size: blob.size, modified: Date.now() },
    ...readIndex().filter((entry) => entry.name !== name),
  ])
}

export const deleteBackups = (names: string[]): number => {
  const api = bridge()
  if (api?.deleteBackups) {
    return api.deleteBackups(JSON.stringify(names))
  }
  writeIndex(readIndex().filter((entry) => !names.includes(entry.name)))
  return names.length
}

/** 读回一份备份；分片读，避免把几十 MB 一次性塞进 JS 字符串 */
export const readBackup = async (
  name: string,
  onProgress?: (ratio: number) => void
): Promise<Blob | null> => {
  const api = bridge()
  if (!api?.readBackupChunk) {
    return null
  }
  const entry = listBackups().find((item) => item.name === name)
  if (!entry || entry.size <= 0) {
    return null
  }
  const CHUNK = 3 * 1024 * 1024
  const parts: Blob[] = []
  let offset = 0
  while (offset < entry.size) {
    const chunk = api.readBackupChunk(name, offset, Math.min(CHUNK, entry.size - offset))
    if (!chunk) {
      break
    }
    const binary = atob(chunk)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    parts.push(new Blob([bytes]))
    offset += bytes.length
    onProgress?.(Math.min(offset / entry.size, 1))
  }
  if (parts.length === 0) {
    return null
  }
  return new Blob(parts, { type: 'application/zip' })
}
