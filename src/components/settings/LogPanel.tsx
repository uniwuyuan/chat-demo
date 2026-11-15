import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { IconCopyOutline16, IconDownloadOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import { setDebugLog, useSettings } from '../../services/settings.js'
import { clearLogs, logText, useLogs, type LogLevel } from '../../services/debug/log.js'
import styles from './Settings.module.css'

const levels: { value: LogLevel | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

const formatTime = (at: number) => {
  const date = new Date(at)
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/**
 * 日志页：开关、清空 / 复制 / 导出，以及按级别过滤的日志列表。
 * 用来在手机上看清导入这类操作的失败原因（原生壳的文件选择器事件也进这里）。
 */
export const LogPanel = () => {
  const t = useTranslate()
  const entries = useLogs((state) => state.entries)
  const enabled = useSettings((state) => state.debugLog)
  const [level, setLevel] = useState<LogLevel | 'all'>('all')
  const [keyword, setKeyword] = useState('')

  const visible = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    return [...entries]
      .reverse()
      .filter((entry) => (level === 'all' ? true : entry.level === level))
      .filter((entry) =>
        text.length === 0
          ? true
          : `${entry.scope} ${entry.message} ${entry.detail ?? ''}`.toLowerCase().includes(text)
      )
  }, [entries, level, keyword])

  const download = () => {
    const blob = new Blob([logText()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `chat-demo-log-${Date.now()}.txt`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div className={styles.logPanel}>
      <div className={styles.logToolbar}>
        <button
          type="button"
          className={clsx(styles.logToggle, enabled && styles.logToggleOn)}
          aria-pressed={enabled}
          onClick={() => setDebugLog(!enabled)}
        >
          {t(enabled ? 'logSwitchOn' : 'logSwitchOff')}
        </button>
        <span className={styles.logCount}>{t('logCount', { count: entries.length })}</span>
        <div className={styles.logActions}>
          <Button variant="outlined" size="m" onClick={download}>
            <IconDownloadOutline16 />
            {t('logExport')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              const copy = navigator.clipboard?.writeText(logText())
              void (copy ?? Promise.reject(new Error('clipboard unavailable')))
                .then(() => showToast({ key: 'logCopied' }))
                .catch(() => showToast({ key: 'logCopyFailed', type: 'error' }))
            }}
          >
            <IconCopyOutline16 />
            {t('logCopy')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="m"
            onClick={() => {
              clearLogs()
              showToast({ key: 'logCleared' })
            }}
          >
            <IconTrashOutline16 />
            {t('logClear')}
          </Button>
        </div>
      </div>

      <div className={styles.logFilters}>
        {levels.map((item) => (
          <button
            key={item.value}
            type="button"
            className={clsx(styles.logFilter, level === item.value && styles.logFilterActive)}
            onClick={() => setLevel(item.value)}
          >
            {item.label}
          </button>
        ))}
        <input
          className={styles.logSearch}
          value={keyword}
          placeholder={t('logSearch')}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </div>

      <div className={styles.logList}>
        {visible.length === 0 ? (
          <div className={styles.logEmpty}>{t('logEmpty')}</div>
        ) : (
          visible.map((entry) => (
            <div
              key={entry.id}
              className={clsx(
                styles.logRow,
                entry.level === 'error' && styles.logError,
                entry.level === 'warn' && styles.logWarn
              )}
            >
              <div className={styles.logHead}>
                <span className={styles.logTime}>{formatTime(entry.at)}</span>
                <span className={styles.logScope}>{entry.scope}</span>
                <span className={styles.logMessage}>{entry.message}</span>
              </div>
              {entry.detail ? <pre className={styles.logDetail}>{entry.detail}</pre> : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
