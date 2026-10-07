import { listRows } from './local-store'
import type { EntryRow } from './types'

// 机位分配占用阈值判定：纯规则层，不碰持久化；页面与 local-service 都只调这里。
// 判定结论三档：可分配 / 待复核 / 退回；存量缺归属记录在读取时兼容为「待补录」。

export const STAND_KEY = 'stand'
export const BRIDGE_KEY = 'bridge'
export const EMERGENCY_KEY = 'air_emergency'

export type StandVerdict = '可分配' | '待复核' | '退回'
export const BACKFILL_VERDICT = '待补录'

export type StandType = '近机位' | '远机位' | '应急机位'

export type StandCatalogItem = {
  机位编号: string
  机位类型: StandType
  所属航站楼: string
}

// 机位主数据：编号、类型、所属航站楼的唯一合法来源，登记表单只能从这里选。
export const STAND_CATALOG: StandCatalogItem[] = [
  { 机位编号: 'STAN-101', 机位类型: '近机位', 所属航站楼: 'T1' },
  { 机位编号: 'STAN-102', 机位类型: '远机位', 所属航站楼: 'T1' },
  { 机位编号: 'STAN-103', 机位类型: '近机位', 所属航站楼: 'T1' },
  { 机位编号: 'STAN-104', 机位类型: '远机位', 所属航站楼: 'T1' },
  { 机位编号: 'STAN-201', 机位类型: '近机位', 所属航站楼: 'T2' },
  { 机位编号: 'STAN-202', 机位类型: '近机位', 所属航站楼: 'T2' },
  { 机位编号: 'STAN-203', 机位类型: '远机位', 所属航站楼: 'T2' },
  { 机位编号: 'STAN-204', 机位类型: '远机位', 所属航站楼: 'T2' },
  { 机位编号: 'STAN-301', 机位类型: '应急机位', 所属航站楼: 'T3' },
  { 机位编号: 'STAN-302', 机位类型: '应急机位', 所属航站楼: 'T3' },
]

// 各航站楼计划占用上限与复核线：达到复核线进「待复核」，达到上限一律「退回」不允许保存。
export const TERMINAL_LIMITS: Record<string, { cap: number; reviewRatio: number }> = {
  T1: { cap: 4, reviewRatio: 0.75 },
  T2: { cap: 4, reviewRatio: 0.75 },
  T3: { cap: 2, reviewRatio: 0.75 },
}

export const STAND_TYPE_OPTIONS: StandType[] = ['近机位', '远机位', '应急机位']
export const TERMINAL_OPTIONS = Object.keys(TERMINAL_LIMITS)

export const LOCKED = '已锁定'
export const UNLOCKED = '未锁定'
const RELEASED_STATUS = '已释放'
const PLACEHOLDER_RE = /样例\d*$/

export type StandDraft = {
  机位编号: string
  匹配航班: string
  计划占用: string
  应急航班?: boolean
}

export type OccupancyWindow = { start: Date; end: Date }

export type StandEvaluation = {
  verdict: StandVerdict
  reasons: string[]
  terminal: string
  standType: StandType | ''
  occupancy: { used: number; cap: number; ratio: number }
  locked: boolean
  emergency: boolean
}

const catalogByCode = new Map(STAND_CATALOG.map((item) => [item.机位编号, item]))

export function findStand(code: string): StandCatalogItem | undefined {
  return catalogByCode.get(String(code ?? '').trim())
}

export function isPlaceholder(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || PLACEHOLDER_RE.test(text)
}

// 归属四要素：机位编号、机位类型、所属航站楼、匹配航班，任一缺失或与机位主数据不符就算缺归属。
export function attributionComplete(row: Pick<EntryRow, string> | EntryRow): boolean {
  const code = String(row['机位编号'] ?? '').trim()
  const catalog = findStand(code)
  if (!catalog) {
    return false
  }
  if (String(row['机位类型'] ?? '').trim() !== catalog.机位类型) {
    return false
  }
  if (String(row['所属航站楼'] ?? '').trim() !== catalog.所属航站楼) {
    return false
  }
  return !isPlaceholder(row['匹配航班'])
}

// 计划占用文本形如「2026-10-07 08:00~09:30」，结束段只有时刻时沿用开始段的日期。
export function parseWindow(text: string): OccupancyWindow | null {
  const raw = String(text ?? '').trim()
  const [startText, endText] = raw.split('~')
  if (!startText || !endText) {
    return null
  }
  const start = new Date(startText.trim().replace(' ', 'T'))
  if (Number.isNaN(start.getTime())) {
    return null
  }
  let end: Date
  if (/^\s*\d{1,2}:\d{2}\s*$/.test(endText)) {
    const [hour, minute] = endText.trim().split(':').map(Number)
    end = new Date(start)
    end.setHours(hour, minute, 0, 0)
  } else {
    end = new Date(endText.trim().replace(' ', 'T'))
  }
  if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    return null
  }
  return { start, end }
}

function windowsOverlap(a: OccupancyWindow, b: OccupancyWindow): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()
}

export function isLockedStand(row: EntryRow): boolean {
  return String(row['锁定标记'] ?? '').trim() === LOCKED
}

// 进入计划占用范围的在控分配：已释放的不占指标，缺归属的存量记录也不占指标。
export function isActiveAllocation(row: EntryRow): boolean {
  if (String(row.status) === RELEASED_STATUS) {
    return false
  }
  if (!attributionComplete(row)) {
    return false
  }
  return parseWindow(String(row['计划占用'] ?? '')) !== null
}

function activeRows(rows: EntryRow[], window: OccupancyWindow): EntryRow[] {
  return rows.filter((row) => {
    if (!isActiveAllocation(row)) {
      return false
    }
    const own = parseWindow(String(row['计划占用'] ?? ''))
    return own !== null && windowsOverlap(own, window)
  })
}

function isEmergencyFlight(flight: string, forced: boolean | undefined): boolean {
  if (forced) {
    return true
  }
  const keyword = String(flight ?? '').trim()
  if (keyword === '') {
    return false
  }
  return listRows(EMERGENCY_KEY).some(
    (row) =>
      String(row.status) !== '已解除' && String(row['涉及航班'] ?? '').includes(keyword),
  )
}

export function emptyEvaluation(): StandEvaluation {
  return {
    verdict: '退回',
    reasons: [],
    terminal: '',
    standType: '',
    occupancy: { used: 0, cap: 0, ratio: 0 },
    locked: false,
    emergency: false,
  }
}

// 阈值判定主入口：同一套规则供「保存前预览」「落库」「复核」复用，保证页面判断和保存结果一致。
// 冲突优先级：缺归属/时间窗 → 应急机型错配（安全） → 航站楼达到上限（硬退回，任何身份不例外）
// → 已锁定航班占位（安全/锁定优先） → 同航班首个成功 → 同机位待复核冲突
// → 复核线（待复核，应急航班安全优先放行） → 可分配。
export function evaluateStand(
  draft: StandDraft,
  rows: EntryRow[] = listRows(STAND_KEY),
): StandEvaluation {
  const result = emptyEvaluation()
  const code = draft.机位编号.trim()
  const flight = draft.匹配航班.trim()
  const catalog = findStand(code)
  const window = parseWindow(draft.计划占用)

  if (!catalog) {
    result.reasons.push('机位编号不在机位主数据内，归属信息缺失，按「待补录」处理存量后再分配')
    return result
  }
  result.terminal = catalog.所属航站楼
  result.standType = catalog.机位类型
  if (isPlaceholder(flight)) {
    result.reasons.push('匹配航班为空，无法进入计划占用范围判定')
    return result
  }
  if (!window) {
    result.reasons.push('计划占用时间范围不合法，需形如「2026-10-07 08:00~09:30」')
    return result
  }

  const emergency = isEmergencyFlight(flight, draft.应急航班)
  result.emergency = emergency

  // 应急机位只保障应急航班；普通航班占用应急机位属于安全冲突，直接退回。
  if (catalog.机位类型 === '应急机位' && !emergency) {
    result.reasons.push(`机位 ${code} 为应急机位，仅保障应急航班，普通航班不得占用`)
    return result
  }

  const overlapping = activeRows(rows, window)
  const sameTerminal = overlapping.filter(
    (row) => String(row['所属航站楼']) === catalog.所属航站楼,
  )
  const snapshot = occupancySnapshot(sameTerminal.length + 1, catalog.所属航站楼)
  result.occupancy = snapshot
  const { used, cap, ratio } = snapshot

  // 超出（达到）航站楼占用上限的不允许保存：硬约束，排在冲突检测最前面，任何身份都不例外。
  if (used >= cap) {
    result.reasons.push(
      `${catalog.所属航站楼} 计划占用已达上限（${used}/${cap}），不允许保存`,
    )
    return result
  }

  // 规则冲突以安全和已锁定航班为准：机位上已锁定航班的计划占用窗口不可被抢占。
  const lockedConflict = overlapping.find(
    (row) => String(row['机位编号']) === code && isLockedStand(row),
  )
  if (lockedConflict) {
    result.reasons.push(
      `机位 ${code} 已被航班 ${lockedConflict['匹配航班']} 锁定，占用区间冲突，已锁定航班优先`,
    )
    return result
  }

  // 同一航班并发抢占只允许首个成功：后续请求一律退回，由先落库的那条占用。
  const claimed = overlapping.find((row) => String(row['匹配航班']) === flight)
  if (claimed) {
    result.reasons.push(
      `航班 ${flight} 已成功抢占机位 ${claimed['机位编号']}，同一航班只允许首个请求成功`,
    )
    return result
  }

  // 同机位尚有未锁定的待复核计划：不硬拦，但需人工复核拍板。
  const pendingConflict = overlapping.find((row) => String(row['机位编号']) === code)
  if (pendingConflict) {
    result.verdict = '待复核'
    result.reasons.push(
      `机位 ${code} 已有航班 ${pendingConflict['匹配航班']} 的待复核占用计划，需人工复核确认`,
    )
    return result
  }

  // 进复核线：普通航班落「待复核」且不锁定；应急航班按安全优先放行并锁定。
  if (ratio >= TERMINAL_LIMITS[catalog.所属航站楼].reviewRatio && !emergency) {
    result.verdict = '待复核'
    result.reasons.push(
      `${catalog.所属航站楼} 占用率 ${(ratio * 100).toFixed(0)}% 已达复核线（${used}/${cap}），需人工复核`,
    )
    return result
  }

  result.verdict = '可分配'
  result.locked = true
  result.reasons.push(
    emergency
      ? `应急航班按安全优先放行，机位 ${code} 直接锁定（占用 ${snapshot.used}/${snapshot.cap}）`
      : `校验通过，机位 ${code} 可分配并锁定（${catalog.所属航站楼} 占用 ${snapshot.used}/${snapshot.cap}）`,
  )
  return result
}

function occupancySnapshot(used: number, terminal: string) {
  const limit = TERMINAL_LIMITS[terminal] ?? { cap: 0, reviewRatio: 1 }
  return { used, cap: limit.cap, ratio: limit.cap === 0 ? 0 : used / limit.cap }
}

// 复核通过只复查硬约束（锁定冲突、上限）；复核线属于人工可以放行的软阈值。
export function evaluateReviewLock(
  row: EntryRow,
  rows: EntryRow[] = listRows(STAND_KEY),
): StandEvaluation {
  const draft: StandDraft = {
    机位编号: String(row['机位编号'] ?? ''),
    匹配航班: String(row['匹配航班'] ?? ''),
    计划占用: String(row['计划占用'] ?? ''),
    应急航班: String(row['备注说明'] ?? '').includes('应急'),
  }
  const others = rows.filter((item) => Number(item.id) !== Number(row.id))
  const evaluation = evaluateStand(draft, others)
  // 复核场景下复核线不再拦截：只要不是硬退回就允许人工锁定。
  if (evaluation.verdict === '待复核') {
    return { ...evaluation, verdict: '可分配', locked: true }
  }
  return evaluation
}

// 廊桥调度清单同步机位锁定结论：按廊桥所属机位找在控分配，纯展示，不反写廊桥数据。
export function bridgeLockConclusion(
  bridgeRow: EntryRow,
  standRows: EntryRow[] = listRows(STAND_KEY),
): string {
  const code = String(bridgeRow['所属机位'] ?? '').trim()
  if (isPlaceholder(code)) {
    return '待补录：廊桥未登记所属机位'
  }
  if (!findStand(code)) {
    return `待补录：机位 ${code} 不在机位主数据内`
  }
  const onStand = standRows.filter(
    (row) => String(row['机位编号']) === code && isActiveAllocation(row),
  )
  if (onStand.length === 0) {
    return `未锁定：机位 ${code} 当前无在控航班`
  }
  const locked = onStand.find((row) => isLockedStand(row))
  if (locked) {
    return `已锁定：${locked['匹配航班']}`
  }
  const flights = onStand.map((row) => String(row['匹配航班'])).join('、')
  return `待复核：机位 ${code} 占用尚未锁定（${flights}）`
}

export function formatStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
