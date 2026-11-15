import { API_ORIGIN } from './api/client.js'

/** GET /user/balance 的归一化结果 */
export type Balance = {
  available: boolean
  currency: string
  total: number
  granted: number
  toppedUp: number
  checkedAt: number
}

type RawBalance = {
  is_available?: boolean
  balance_infos?: {
    currency?: string
    total_balance?: string
    granted_balance?: string
    topped_up_balance?: string
  }[]
}

const toNumber = (value: string | undefined) => {
  const parsed = Number(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** 查询账户余额；失败时抛错，由调用方展示原因 */
export const fetchBalance = async (apiKey: string): Promise<Balance> => {
  const response = await fetch(`${API_ORIGIN}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const data = (await response.json()) as RawBalance
  const info = data.balance_infos?.[0]
  return {
    available: data.is_available !== false,
    currency: info?.currency === 'USD' ? 'USD' : 'CNY',
    total: toNumber(info?.total_balance),
    granted: toNumber(info?.granted_balance),
    toppedUp: toNumber(info?.topped_up_balance),
    checkedAt: Date.now(),
  }
}
