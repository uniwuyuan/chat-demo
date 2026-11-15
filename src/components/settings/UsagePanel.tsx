import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useChatStore } from '../../services/chat/store.js'
import { contextColor } from '../../services/contextUsage.js'
import {
  bySession,
  clearUsage,
  costOf,
  filterByRange,
  heatmapOf,
  paceOf,
  partsOf,
  setCnyRate,
  tokensByDay,
  totalsOf,
  useUsage,
  type UsageRange,
  type UsageRecord,
} from '../../services/usage.js'
import styles from './Settings.module.css'

const CONTEXT_WINDOW = 1_000_000

const formatNumber = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 10_000
      ? `${(value / 1000).toFixed(1)}k`
      : String(Math.round(value))

const formatMoney = (value: number) => (value >= 0.01 ? value.toFixed(2) : value.toFixed(4))

const formatDuration = (ms: number) => {
  if (ms < 1000) {
    return `${ms}ms`
  }
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m${seconds % 60}s`
  }
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

const formatTime = (at: number) => {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const ranges: UsageRange[] = ['today', '7d', '30d', 'all']
const rangeLabel = {
  today: 'usageRangeToday',
  '7d': 'usageRange7d',
  '30d': 'usageRange30d',
  all: 'usageRangeAll',
} as const

/** 通用环形图：按传入分项画弧 */
const Donut = ({ items, total }: { items: { value: number; color: string }[]; total: number }) => {
  const radius = 40
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <svg width="112" height="112" viewBox="0 0 112 112" aria-hidden>
      <circle cx="56" cy="56" r={radius} fill="none" stroke="currentColor" strokeWidth="13" opacity="0.12" />
      {total === 0
        ? null
        : items.map((item, index) => {
            const length = (item.value / total) * circumference
            const element = (
              <circle
                key={index}
                cx="56"
                cy="56"
                r={radius}
                fill="none"
                stroke={item.color}
                strokeWidth="13"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 56 56)"
              />
            )
            offset += length
            return element
          })}
    </svg>
  )
}

/**
 * 用量洞察：范围 → 六项总账 → 近 7 天（Token/费用双柱）→ Token 构成 → 活跃度 → 会话明细。
 * 每个会话都能点进去逐轮看输入命中 / 未命中 / 输出与费用。
 */
export const UsagePanel = () => {
  const t = useTranslate()
  const records = useUsage((state) => state.records)
  const cnyRate = useUsage((state) => state.cnyRate)
  const sessions = useChatStore((state) => state.sessions)
  const [range, setRange] = useState<UsageRange>('7d')
  const [opened, setOpened] = useState<string | null | undefined>(undefined)

  const scoped = useMemo(() => filterByRange(records, range), [records, range])
  const totals = useMemo(() => totalsOf(scoped, cnyRate), [scoped, cnyRate])
  const perSession = useMemo(() => bySession(scoped, cnyRate), [scoped, cnyRate])
  const days = useMemo(() => tokensByDay(scoped, cnyRate, 7), [scoped, cnyRate])
  const parts = useMemo(() => partsOf(scoped), [scoped])
  const pace = useMemo(() => paceOf(scoped), [scoped])
  const cells = useMemo(() => heatmapOf(scoped, 8), [scoped])
  const titles = useMemo(() => new Map(sessions.map((item) => [item.id, item.title])), [sessions])

  const inputTokens = totals.input + totals.cacheRead + totals.cacheWrite
  const maxToken = Math.max(1, ...days.map((day) => day.tokens))
  const maxCost = Math.max(0.0001, ...days.map((day) => day.cny))
  const maxCell = Math.max(1, ...cells.map((cell) => cell.tokens))

  const titleOf = (sessionId: string | null) =>
    sessionId === null ? t('usageNoSession') : (titles.get(sessionId) ?? sessionId.slice(0, 8))

  const hitClass =
    totals.hitRate >= 0.6 ? styles.usagegood : totals.hitRate >= 0.3 ? styles.usagewarn : styles.usagebad

  const partItems = [
    { key: 'usagePartsSystem', value: parts.system, color: '#6366f1' },
    { key: 'usagePartsUser', value: parts.user, color: '#f59e0b' },
    { key: 'usagePartsAssistant', value: parts.assistant, color: '#ec4899' },
    { key: 'usagePartsOther', value: parts.other, color: '#14b8a6' },
    { key: 'usagePartsOutput', value: totals.output, color: '#22c55e' },
  ] as const
  const partsTotal = partItems.reduce((sum, item) => sum + item.value, 0)

  const detail = opened === undefined ? null : (perSession.find((item) => item.sessionId === opened) ?? null)
  const detailRecords = useMemo(
    () =>
      opened === undefined
        ? []
        : scoped
            .filter((record) => (record.sessionId ?? null) === opened)
            .slice(-40)
            .reverse(),
    [scoped, opened]
  )

  if (detail) {
    const ratio = detail.contextTokens / CONTEXT_WINDOW
    const detailPace = paceOf(
      scoped.filter((record) => (record.sessionId ?? null) === opened)
    )
    return (
      <div className={styles.usagePanel}>
        <div className={styles.usageRowBetween}>
          <button type="button" className={styles.usageLink} onClick={() => setOpened(undefined)}>
            ← {t('usageBack')}
          </button>
          <span className={styles.usageMuted}>{formatTime(detail.lastAt)}</span>
        </div>
        <div className={styles.usageBlock}>
          <div className={styles.usageBlockTitle}>{titleOf(detail.sessionId)}</div>
          <div className={styles.usageBigRow}>
            <span className={styles.usageBig} style={{ color: contextColor(ratio) }}>
              {Math.round(ratio * 100)}%
            </span>
            <span className={styles.usageMuted}>
              {t('usageContext')} {formatNumber(detail.contextTokens)} / 1M
            </span>
          </div>
          <div className={styles.usageGrid3}>
            <div>
              <div className={styles.usageStatValue}>{formatNumber(detail.totals.cacheRead)}</div>
              <div className={styles.usageStatLabel}>{t('usageInputHitShort')}</div>
            </div>
            <div>
              <div className={styles.usageStatValue}>
                {formatNumber(detail.totals.input + detail.totals.cacheWrite)}
              </div>
              <div className={styles.usageStatLabel}>{t('usageInputMissShort')}</div>
            </div>
            <div>
              <div className={styles.usageStatValue}>{formatNumber(detail.totals.output)}</div>
              <div className={styles.usageStatLabel}>{t('usageOutputShort')}</div>
            </div>
          </div>
          <div className={styles.usageMuted}>
            {t('usageRounds', { count: detail.totals.requests })} · ¥{formatMoney(detail.totals.cny)} ·{' '}
            {t('usageActiveTime')} {formatDuration(detailPace.ms)}
            {detailPace.speed > 0 ? ` · ${detailPace.speed.toFixed(0)} tok/s` : ''}
          </div>
        </div>

        <div className={styles.usageBlock}>
          <div className={styles.usageRecentHead}>
            <span className={styles.usageBlockTitle}>{t('usageRecent')}</span>
            <label className={styles.usageRate}>
              {t('usageRate')}
              <input
                className={styles.usageRateInput}
                type="number"
                step="0.1"
                min="0"
                value={cnyRate}
                onChange={(event) => setCnyRate(Number(event.target.value))}
              />
            </label>
          </div>
          <div className={styles.usageList}>
            {detailRecords.length === 0 ? (
              <div className={styles.usageEmpty}>{t('usageEmpty')}</div>
            ) : (
              detailRecords.map((record: UsageRecord) => {
                const cost = costOf(record, cnyRate)
                const recordInput = record.input + record.cacheRead + record.cacheWrite
                const rate = recordInput === 0 ? 0 : record.cacheRead / recordInput
                return (
                  <div key={record.id} className={styles.usageRow}>
                    <span className={styles.usageCellTime}>{formatTime(record.at)}</span>
                    <span
                      className={clsx(
                        styles.usageCellHit,
                        rate >= 0.5 ? styles.usageGood : styles.usageBad
                      )}
                    >
                      {(rate * 100).toFixed(0)}%
                    </span>
                    <span className={styles.usageCellNum}>
                      {t('usageInputHitShort')} {formatNumber(record.cacheRead)} ·{' '}
                      {t('usageInputMissShort')} {formatNumber(record.input + record.cacheWrite)} ·{' '}
                      {t('usageOutputShort')} {formatNumber(record.output)}
                      {record.ms ? ` · ${formatDuration(record.ms)}` : ''}
                    </span>
                    <span className={styles.usageCellCost}>
                      ¥{formatMoney(cost.cny)}
                      <span className={styles.usagePeakTag}>
                        {cost.peak ? t('usagePeak') : t('usageOffPeak')}
                      </span>
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
        <div className={styles.usageNote}>{t('usageCostNote')}</div>
      </div>
    )
  }

  return (
    <div className={styles.usagePanel}>
      <div className={styles.usageChips}>
        {ranges.map((item) => (
          <button
            key={item}
            type="button"
            className={clsx(styles.usageChip, range === item && styles.usageChipActive)}
            onClick={() => setRange(item)}
          >
            {t(rangeLabel[item])}
          </button>
        ))}
      </div>

      <div className={styles.usageCards}>
        <div className={styles.usageCard}>
          <div className={styles.usageCardLabel}>{t('usageAllChats')}</div>
          <div className={styles.usageCardValue}>{perSession.length}</div>
          <div className={styles.usageCardSub}>
            {t('usageWithRecords', { count: perSession.length })}
          </div>
        </div>
        <div className={styles.usageCard}>
          <div className={styles.usageCardLabel}>{t('usageTokens')}</div>
          <div className={styles.usageCardValue}>{formatNumber(totals.tokens)}</div>
          <div className={styles.usageCardSub}>{t('usageRounds', { count: totals.requests })}</div>
        </div>
        <div className={styles.usageCard}>
          <div className={styles.usageCardLabel}>{t('usageCost')}</div>
          <div className={styles.usageCardValue}>¥{formatMoney(totals.cny)}</div>
          <div className={styles.usageCardSub}>{t('usageCounted', { count: perSession.length })}</div>
        </div>
        <div className={styles.usageCard}>
          <div className={styles.usageCardLabel}>{t('usageHitRate')}</div>
          <div className={clsx(styles.usageCardValue, hitClass)}>
            {totals.requests === 0 ? '—' : `${(totals.hitRate * 100).toFixed(2)}%`}
          </div>
          <div className={styles.usageCardSub}>
            {t('usageInputHitShort')} {formatNumber(totals.cacheRead)}
          </div>
        </div>
        <div className={styles.usageCard}>
          <div className={styles.usageCardLabel}>
            {t('usageInputTokens')} / {t('usageOutputTokens')}
          </div>
          <div className={styles.usageCardValue}>
            {formatNumber(inputTokens)} / {formatNumber(totals.output)}
          </div>
          <div className={styles.usageCardSub}>
            {totals.tokens === 0 ? '—' : `${((inputTokens / totals.tokens) * 100).toFixed(0)}% 输入占比`}
          </div>
        </div>
        <div className={styles.usageCard}>
          <div className={styles.usageCardLabel}>{t('usageActiveTime')}</div>
          <div className={styles.usageCardValue}>{formatDuration(pace.ms)}</div>
          <div className={styles.usageCardSub}>
            {t('usageSpeed')} {pace.speed > 0 ? `${pace.speed.toFixed(0)} tok/s` : '—'}
          </div>
        </div>
      </div>

      <div className={styles.usageBlock}>
        <div className={styles.usageBlockTitle}>{t('usageTrend')}</div>
        <div className={styles.usageChartBody}>
          <div className={styles.usageAxisLeft}>
            <span>{formatNumber(maxToken)}</span>
            <span>{formatNumber(maxToken / 2)}</span>
            <span>0</span>
          </div>
          <div className={styles.usageBars}>
            {days.map((day, index) => (
              <div key={day.start} className={styles.usageBarColumn}>
                <div className={styles.usageBarPair}>
                  <div className={styles.usageBarTrack}>
                    <div
                      className={clsx(styles.usageBarFill, index === days.length - 1 && styles.usageBarToday)}
                      style={{ height: `${Math.max(day.tokens / maxToken, 0.02) * 100}%` }}
                      title={`${formatNumber(day.tokens)} tokens`}
                    />
                  </div>
                  <div className={styles.usageBarTrack}>
                    <div
                      className={styles.usageBarCost}
                      style={{ height: `${Math.max(day.cny / maxCost, 0.02) * 100}%` }}
                      title={`¥${formatMoney(day.cny)}`}
                    />
                  </div>
                </div>
                <div className={styles.usageBarLabel}>{day.label}</div>
              </div>
            ))}
          </div>
          <div className={styles.usageAxisRight}>
            <span>¥{formatMoney(maxCost)}</span>
            <span>¥{formatMoney(maxCost / 2)}</span>
            <span>0</span>
          </div>
        </div>
        <div className={styles.usageLegendInline}>
          <span className={styles.usageDot} style={{ backgroundColor: '#4d6bfe' }} />
          {t('usageTokenLegend')}
          <span className={styles.usageDot} style={{ backgroundColor: '#22c55e' }} />
          {t('usageCostLegend')}
        </div>
      </div>

      <div className={styles.usageBlock}>
        <div className={styles.usageBlockTitle}>{t('usageTokenStats')}</div>
        <div className={styles.usageDonutRow}>
          <Donut items={partItems.map((item) => ({ value: item.value, color: item.color }))} total={partsTotal} />
          <div className={styles.usageLegend}>
            {partItems.map((item) => (
              <div key={item.key} className={styles.usageLegendItem}>
                <span className={styles.usageDot} style={{ backgroundColor: item.color }} />
                <span className={styles.usageLegendLabel}>{t(item.key)}</span>
                <span className={styles.usageLegendValue}>
                  {partsTotal === 0 ? '—' : `${((item.value / partsTotal) * 100).toFixed(1)}%`}
                </span>
                <span className={styles.usageMuted} style={{ width: 52, textAlign: 'right' }}>
                  ≈{formatNumber(item.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.usageBlock}>
        <div className={styles.usageBlockTitle}>{t('usageHeatmap')}</div>
        <div className={styles.usageHeatmap}>
          {cells.map((cell) => {
            const level = cell.tokens === 0 ? 0 : Math.ceil((cell.tokens / maxCell) * 4)
            return (
              <span
                key={cell.start}
                className={clsx(styles.usageCell, styles[`usageLevel${level}`])}
                title={`${cell.label} · ${formatNumber(cell.tokens)} tokens`}
              />
            )
          })}
        </div>
        <div className={styles.usageLegendInline}>
          {t('usageLess')}
          <span className={clsx(styles.usageCell, styles.usageLevel0)} />
          <span className={clsx(styles.usageCell, styles.usageLevel1)} />
          <span className={clsx(styles.usageCell, styles.usageLevel2)} />
          <span className={clsx(styles.usageCell, styles.usageLevel3)} />
          <span className={clsx(styles.usageCell, styles.usageLevel4)} />
          {t('usageMore')}
        </div>
      </div>

      <div className={styles.usageBlock}>
        <div className={styles.usageRowBetween}>
          <span className={styles.usageBlockTitle}>{t('usagePerChat')}</span>
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              clearUsage()
              showToast({ key: 'usageCleared' })
            }}
          >
            {t('usageClear')}
          </Button>
        </div>
        {perSession.length === 0 ? (
          <div className={styles.usageEmpty}>{t('usageEmpty')}</div>
        ) : (
          <div className={styles.usageSessionList}>
            {perSession.map((item) => {
              const ratio = item.contextTokens / CONTEXT_WINDOW
              return (
                <button
                  key={item.sessionId ?? 'unknown'}
                  type="button"
                  className={styles.usageSessionRow}
                  onClick={() => setOpened(item.sessionId)}
                >
                  <span className={styles.usageSessionRing} style={{ color: contextColor(ratio) }}>
                    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
                      <circle cx="17" cy="17" r="14" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.16" />
                      <circle
                        cx="17"
                        cy="17"
                        r="14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeDasharray={`${Math.min(ratio, 1) * 2 * Math.PI * 14} ${2 * Math.PI * 14}`}
                        transform="rotate(-90 17 17)"
                      />
                    </svg>
                    <span className={styles.usageSessionPercent}>{Math.round(ratio * 100)}%</span>
                  </span>
                  <span className={styles.usageSessionMain}>
                    <span className={styles.usageSessionTitle}>{titleOf(item.sessionId)}</span>
                    <span className={styles.usageMuted}>
                      {t('usageRounds', { count: item.totals.requests })} · 入{' '}
                      {formatNumber(item.totals.input + item.totals.cacheRead + item.totals.cacheWrite)} · 出{' '}
                      {formatNumber(item.totals.output)}
                    </span>
                  </span>
                  <span className={styles.usageSessionCost}>¥{formatMoney(item.totals.cny)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className={styles.usageNote}>{t('usageCostNote')}</div>
    </div>
  )
}
