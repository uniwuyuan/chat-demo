import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { autoBackup, lastBackupAt } from '../../services/chat/backup.js'
import { deleteBackups, hasNativeBackups, listBackups, readBackup } from '../../services/backupStore.js'
import { importHistory } from '../../services/chat/backup.js'
import { reloadSessions } from '../../services/chat/store.js'
import { setAutoBackup, useSettings } from '../../services/settings.js'
import { logError, logInfo } from '../../services/debug/log.js'
import styles from './Settings.module.css'

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const formatTime = (at: number) => {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 备份管理：专有目录 Download/DeepSeekChatDemo/backups。
 * 支持多选删除旧备份、单份回滚（覆盖当前全部对话）。
 */
export const BackupPanel = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.autoBackup)
  const [entries, setEntries] = useState(() => listBackups())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const native = hasNativeBackups()

  const refresh = () => {
    const files = listBackups()
    setEntries(files)
    setSelected((current) => new Set([...current].filter((name) => files.some((file) => file.name === name))))
  }

  useEffect(() => {
    refresh()
  }, [])

  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const restore = async (name: string) => {
    if (!window.confirm(t('backupRestoreConfirm'))) {
      return
    }
    setBusy(name)
    setProgress(0)
    try {
      const blob = await readBackup(name, (ratio) => setProgress(ratio))
      if (!blob) {
        throw new Error(t('backupReadFailed'))
      }
      const count = await importHistory(new File([blob], name, { type: 'application/zip' }))
      await reloadSessions()
      logInfo('backup', '已回滚备份', { name, sessions: count })
      showToast({ key: 'backupRestored', params: { count } })
    } catch (error) {
      logError('backup', '回滚失败', error)
      showToast({
        key: 'backupRestoreFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      setBusy(null)
      setProgress(0)
    }
  }

  return (
    <div className={styles.backupPanel}>
      <div className={styles.usageBlock}>
        <div className={styles.usageRowBetween}>
          <span className={styles.usageBlockTitle}>{t('backupAutoLabel')}</span>
          <button
            type="button"
            className={clsx(styles.logToggle, enabled && styles.logToggleOn)}
            aria-pressed={enabled}
            onClick={() => setAutoBackup(!enabled)}
          >
            {t(enabled ? 'logSwitchOn' : 'logSwitchOff')}
          </button>
        </div>
        <div className={styles.usageMuted}>
          {lastBackupAt() === 0
            ? t('autoBackupNever')
            : t('autoBackupLast', { time: formatTime(lastBackupAt()) })}
        </div>
        <div className={styles.backupActions}>
          <Button
            variant="outlined"
            size="m"
            disabled={busy !== null}
            onClick={() => {
              setBusy('backup')
              void autoBackup(true)
                .then((name) => {
                  showToast(name ? t('autoBackupDone') : t('autoBackupEmpty'))
                  refresh()
                })
                .finally(() => setBusy(null))
            }}
          >
            {t('autoBackupNow')}
          </Button>
          <Button variant="outlined" size="m" onClick={refresh}>
            {t('backupRefresh')}
          </Button>
        </div>
        <div className={styles.usageNote}>{t('backupFolderHint')}</div>
        {!native ? <div className={styles.usageNote}>{t('backupBrowserHint')}</div> : null}
      </div>

      <div className={styles.usageBlock}>
        <div className={styles.usageRowBetween}>
          <span className={styles.usageBlockTitle}>
            {t('backupListTitle')} · {entries.length}
          </span>
          <button
            type="button"
            className={styles.usageLink}
            onClick={() =>
              setSelected(
                selected.size === entries.length ? new Set() : new Set(entries.map((item) => item.name))
              )
            }
          >
            {selected.size === entries.length ? t('backupClearSelection') : t('backupSelectAll')}
          </button>
        </div>

        {entries.length === 0 ? (
          <div className={styles.usageEmpty}>{t('backupEmpty')}</div>
        ) : (
          <div className={styles.backupList}>
            {entries.map((entry) => (
              <div key={entry.name} className={styles.backupRow}>
                <label className={styles.backupCheck}>
                  <input
                    type="checkbox"
                    checked={selected.has(entry.name)}
                    onChange={() => toggle(entry.name)}
                  />
                </label>
                <span className={styles.backupMain}>
                  <span className={styles.backupName}>{entry.name}</span>
                  <span className={styles.usageMuted}>
                    {formatSize(entry.size)} · {formatTime(entry.modified)}
                  </span>
                </span>
                <button
                  type="button"
                  className={styles.usageLink}
                  disabled={busy !== null}
                  onClick={() => void restore(entry.name)}
                >
                  {busy === entry.name && progress > 0
                    ? t('backupProgress', { percent: Math.round(progress * 100) })
                    : t('backupRestore')}
                </button>
              </div>
            ))}
          </div>
        )}

        <Button
          variant="dangerOutlined"
          size="m"
          disabled={selected.size === 0 || busy !== null}
          onClick={() => {
            if (!window.confirm(t('backupDeleteConfirm', { count: selected.size }))) {
              return
            }
            const removed = deleteBackups([...selected])
            setSelected(new Set())
            refresh()
            showToast({ key: 'backupDeleted', params: { count: removed } })
          }}
        >
          {t('backupDeleteSelected', { count: selected.size })}
        </Button>
        <div className={styles.usageNote}>{t('backupKeepHint')}</div>
      </div>
    </div>
  )
}
