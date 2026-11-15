import { useChatStore } from '../../services/chat/store.js'
import { contextColor, estimateContext } from '../../services/contextUsage.js'
import styles from './ContextRing.module.css'

/**
 * 对话标题前的上下文水位环：圆环 + 百分比。
 * 低于 50% 蓝色，50–80% 黄色，高于 80% 红色；点不了，只做提示。
 */
export const ContextRing = () => {
  const session = useChatStore((state) =>
    state.activeId ? state.sessionCache[state.activeId] : undefined
  )
  if (!session) {
    return null
  }
  const { ratio, tokens } = estimateContext(session)
  const clamped = Math.min(Math.max(ratio, 0), 1)
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const color = contextColor(ratio)
  const percent = Math.round(ratio * 100)
  return (
    <span
      className={styles.ring}
      title={`${percent}% · ${tokens.toLocaleString('zh-CN')} / 1M tokens`}
      aria-label={`context ${percent}%`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.18" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray={`${clamped * circumference} ${circumference}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className={styles.text} style={{ color }}>
        {percent}%
      </span>
    </span>
  )
}
