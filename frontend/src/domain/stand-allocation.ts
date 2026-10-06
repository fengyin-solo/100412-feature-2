import type { EntryRow } from '@/data/types'

/**
 * 机位分配领域规则（纯函数，不碰 localStorage）：
 * - 占用阈值判定：可分配 / 待复核 / 退回
 * - 规则冲突：安全航班、已锁定航班优先；超出航站楼占用上限不允许保存
 * - 同一航班并发抢占：只允许首个成功
 * - 历史分配状态按当时判定保留；存量缺归属记录兼容为待补录
 * 页面与本地服务只做组装和持久化，业务判定都收敛在本文件。
 */

export const STAND_KEY = 'stand'
export const BRIDGE_KEY = 'bridge'

// 机位字段
export const F_STAND_NO = '机位编号'
export const F_STAND_TYPE = '机位类型'
export const F_TERMINAL = '所属航站楼'
export const F_FLIGHT = '匹配航班'
export const F_PLAN_WINDOW = '计划占用'
export const F_ACTUAL_WINDOW = '实际占用'
export const F_VERDICT = '判定结论'
export const F_LOCKED_FLIGHT = '锁定航班'
export const F_JUDGED_AT = '判定时间'
export const F_SAFETY = '安全标记'
export const F_REASON = '判定说明'
export const F_REMARK = '备注说明'

// 廊桥字段
export const F_BRIDGE_STAND = '所属机位'
export const F_LOCK_CONCLUSION = '机位锁定结论'

export const STAND_STATUSES = ['空闲', '已分配', '占用中', '待复核', '待补录', '退回', '已释放'] as const
export const STAND_TERMINAL_STATUSES = ['占用中', '已释放', '退回'] as const

export const VERDICT_ALLOCATABLE = '可分配'
export const VERDICT_REVIEW = '待复核'
export const VERDICT_REJECTED = '退回'
export const VERDICTS = [VERDICT_ALLOCATABLE, VERDICT_REVIEW, VERDICT_REJECTED] as const

export type Verdict = (typeof VERDICTS)[number]

export type AllocationInput = {
  [F_STAND_NO]: string
  [F_STAND_TYPE]: string
  [F_TERMINAL]: string
  [F_FLIGHT]: string
  [F_PLAN_WINDOW]: string
  [F_SAFETY]?: string
}

export type AllocationDecision = {
  verdict: Verdict
  reasons: string[]
  terminal: string
  occupied: number
  capacity: number
}

export type TimeWindow = { start: Date; end: Date }

/** 航站楼同时占用上限：达到上限即硬退回；预警线（80%）以内普通航班转人工复核。 */
export const TERMINAL_CAPACITY: Record<string, number> = {
  T1: 5,
  T2: 4,
  T3: 3,
}
export const DEFAULT_CAPACITY = 3
export const WARN_RATIO = 0.8

const REQUIRED_FIELDS = [F_STAND_NO, F_STAND_TYPE, F_TERMINAL, F_FLIGHT] as const

function text(row: Partial<Record<string, string | number | boolean>>, field: string): string {
  return String(row[field] ?? '').trim()
}

export function isSafetyFlight(
  row: Partial<Record<string, string | number | boolean>>,
): boolean {
  return text(row, F_SAFETY) === '是'
}

/** 已锁定机位：已分配/占用中且锁定航班仍在；历史（已释放/退回）不算锁定。 */
export function isLockedStand(row: EntryRow): boolean {
  return (
    (row.status === '已分配' || row.status === '占用中') &&
    text(row, F_LOCKED_FLIGHT) !== '' &&
    text(row, F_FLIGHT) !== ''
  )
}

/** 计划占用：从字符串里抓两个「YYYY-MM-DD HH:mm」时间点，兼容 ~ / ～ / 至 / —— 分隔。 */
export function parseTimeWindow(raw: string): TimeWindow | null {
  const matches = raw.match(/\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?/g)
  if (!matches || matches.length < 2) {
    return null
  }
  const start = new Date(matches[0].replace(' ', 'T'))
  const end = new Date(matches[matches.length - 1].replace(' ', 'T'))
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return null
  }
  return { start, end }
}

export function formatWindow(start: string, end: string): string {
  return `${start.trim().replace('T', ' ')}~${end.trim().replace('T', ' ')}`
}

export function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end
}

/** 行的计划占用与给定窗口是否重叠；存量记录窗口解析不出来时按无重叠处理。 */
function rowOverlaps(row: EntryRow, window: TimeWindow): boolean {
  const rowWindow = parseTimeWindow(text(row, F_PLAN_WINDOW))
  return rowWindow !== null && windowsOverlap(window, rowWindow)
}

export function capacityOf(terminal: string): number {
  return TERMINAL_CAPACITY[terminal] ?? DEFAULT_CAPACITY
}

/**
 * 机位分配阈值判定。规则按硬到弱顺序执行：
 * 1. 机位编号/类型/航站楼/匹配航班缺一 → 退回
 * 2. 计划占用范围无法识别（需含起止）→ 退回
 * 3. 同一航班已在他处锁定 → 退回（并发抢占只允许首个成功）
 * 4. 尚未进入计划占用范围 → 待复核（进入后才按阈值判定）
 * 5. 同机位时段冲突：撞上安全航班 → 退回；安全航班撞已锁定普通航班 → 待复核；其余 → 退回
 * 6. 航站楼同时占用超上限 → 退回；达预警线普通航班 → 待复核、安全航班优先可分配
 */
export function evaluateStandAllocation(
  input: AllocationInput,
  rows: EntryRow[],
  options: { now?: Date; selfId?: number } = {},
): AllocationDecision {
  const now = options.now ?? new Date()
  const selfId = options.selfId
  const standNo = text(input, F_STAND_NO)
  const terminal = text(input, F_TERMINAL)
  const flight = text(input, F_FLIGHT)
  const safety = isSafetyFlight(input)

  for (const field of REQUIRED_FIELDS) {
    if (text(input, field) === '') {
      return decide(VERDICT_REJECTED, terminal, 0, capacityOf(terminal), [
        `缺少「${field}」，机位归属信息不完整，退回补全后再提交`,
      ])
    }
  }

  const window = parseTimeWindow(text(input, F_PLAN_WINDOW))
  if (!window) {
    return decide(VERDICT_REJECTED, terminal, 0, capacityOf(terminal), [
      '计划占用范围无法识别，需同时包含开始与结束时间',
    ])
  }

  // 同一航班并发抢占：已有锁定记录时后续全部退回，只允许首个成功。
  const flightHolder = rows.find(
    (row) => Number(row.id) !== selfId && isLockedStand(row) && text(row, F_FLIGHT) === flight,
  )
  if (flightHolder) {
    return decide(VERDICT_REJECTED, terminal, 0, capacityOf(terminal), [
      `航班 ${flight} 已锁定机位 ${text(flightHolder, F_STAND_NO)}，同一航班并发抢占只允许首个成功`,
    ])
  }

  // 进入计划占用范围后才按阈值给结论；未进入先挂待复核，不提前锁定。
  if (now < window.start || now > window.end) {
    return decide(VERDICT_REVIEW, terminal, 0, capacityOf(terminal), [
      '匹配航班尚未进入计划占用范围，进入后再按占用阈值判定',
    ])
  }

  // 同机位时段冲突：安全和已锁定航班为准。
  const standConflict = rows.find(
    (row) =>
      Number(row.id) !== selfId &&
      isLockedStand(row) &&
      text(row, F_STAND_NO) === standNo &&
      rowOverlaps(row, window),
  )
  if (standConflict) {
    const lockedFlight = text(standConflict, F_FLIGHT)
    if (isSafetyFlight(standConflict)) {
      return decide(VERDICT_REJECTED, terminal, 0, capacityOf(terminal), [
        `机位 ${standNo} 计划占用时段已被安全航班 ${lockedFlight} 锁定，规则冲突以安全航班为准`,
      ])
    }
    if (safety) {
      return decide(VERDICT_REVIEW, terminal, 0, capacityOf(terminal), [
        `机位 ${standNo} 与已锁定航班 ${lockedFlight} 时段冲突且涉及安全航班，需人工复核裁定`,
      ])
    }
    return decide(VERDICT_REJECTED, terminal, 0, capacityOf(terminal), [
      `机位 ${standNo} 计划占用时段已被航班 ${lockedFlight} 锁定，规则冲突以已锁定航班为准`,
    ])
  }

  // 航站楼同时占用阈值：同航站楼、计划占用时段重叠的锁定机位计数。
  const occupied = rows.filter(
    (row) =>
      Number(row.id) !== selfId &&
      isLockedStand(row) &&
      text(row, F_TERMINAL) === terminal &&
      rowOverlaps(row, window),
  ).length
  const capacity = capacityOf(terminal)
  const next = occupied + 1

  if (next > capacity) {
    return decide(VERDICT_REJECTED, terminal, occupied, capacity, [
      `${terminal} 同时占用将达 ${next}/${capacity}，超出上限，超出上限的不允许保存`,
    ])
  }
  if (next > capacity * WARN_RATIO) {
    if (safety) {
      return decide(VERDICT_ALLOCATABLE, terminal, occupied, capacity, [
        `${terminal} 同时占用将达 ${next}/${capacity}，已达预警线，安全航班优先保障直接通过`,
      ])
    }
    return decide(VERDICT_REVIEW, terminal, occupied, capacity, [
      `${terminal} 同时占用将达 ${next}/${capacity}，超过预警阈值 ${Math.round(WARN_RATIO * 100)}%，需复核确认`,
    ])
  }
  return decide(VERDICT_ALLOCATABLE, terminal, occupied, capacity, [
    `${terminal} 同时占用 ${next}/${capacity}，在占用阈值内，可分配`,
  ])
}

function decide(
  verdict: Verdict,
  terminal: string,
  occupied: number,
  capacity: number,
  reasons: string[],
): AllocationDecision {
  return { verdict, reasons, terminal, occupied, capacity }
}

/** 待补录：存量记录缺机位归属任一字段。 */
function lacksAttribution(row: EntryRow): boolean {
  return REQUIRED_FIELDS.some((field) => text(row, field) === '')
}

/**
 * 存量机位记录兼容：
 * - 新结构（带判定结论字段）原样保留，历史判定不重算；
 * - 旧结构且归属完整：保留当时状态，已锁定的补「可分配」结论，标注历史判定；
 * - 旧结构缺归属：兼容为待补录，不丢弃记录。
 */
export function migrateStandRows(
  rows: EntryRow[],
): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const next = rows.map((row) => {
    if (F_VERDICT in row) {
      return row
    }
    changed = true
    if (lacksAttribution(row)) {
      return {
        ...row,
        status: '待补录',
        pending: true,
        abnormal: true,
        [F_VERDICT]: '',
        [F_LOCKED_FLIGHT]: '',
        [F_JUDGED_AT]: '',
        [F_SAFETY]: text(row, F_SAFETY) || '否',
        [F_REASON]: '存量记录缺少机位归属信息，兼容为待补录',
      }
    }
    const locked = row.status === '已分配' || row.status === '占用中'
    return {
      ...row,
      pending: row.status === '已分配',
      abnormal: false,
      [F_VERDICT]: locked ? VERDICT_ALLOCATABLE : '',
      [F_LOCKED_FLIGHT]: locked ? text(row, F_FLIGHT) : '',
      [F_JUDGED_AT]: '',
      [F_SAFETY]: text(row, F_SAFETY) || '否',
      [F_REASON]: locked ? '历史分配状态按当时判定保留，不按新规则重算' : '',
    }
  })
  return { rows: next, changed }
}

/** 廊桥清单同步机位锁定结论：按所属机位对上当前锁定中的机位。 */
export function lockConclusion(flight: string): string {
  return `已锁定 · ${flight}`
}

export function migrateBridgeRows(
  rows: EntryRow[],
  standRows: EntryRow[],
): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const lockedStands = new Map(
    standRows
      .filter(isLockedStand)
      .map((row) => [text(row, F_STAND_NO), text(row, F_LOCKED_FLIGHT) || text(row, F_FLIGHT)]),
  )
  const next = rows.map((row) => {
    if (F_LOCK_CONCLUSION in row) {
      return row
    }
    changed = true
    const flight = lockedStands.get(text(row, F_BRIDGE_STAND))
    return { ...row, [F_LOCK_CONCLUSION]: flight ? lockConclusion(flight) : '' }
  })
  return { rows: next, changed }
}

/** 机位锁定变化后写穿廊桥清单，只改结论发生变化的行（缺字段也补齐为空串）。 */
export function syncBridgeLockConclusions(
  bridgeRows: EntryRow[],
  standRows: EntryRow[],
): { rows: EntryRow[]; changed: boolean } {
  const lockedStands = new Map(
    standRows
      .filter(isLockedStand)
      .map((row) => [text(row, F_STAND_NO), text(row, F_LOCKED_FLIGHT) || text(row, F_FLIGHT)]),
  )
  let changed = false
  const next = bridgeRows.map((row) => {
    const flight = lockedStands.get(text(row, F_BRIDGE_STAND))
    const conclusion = flight ? lockConclusion(flight) : ''
    if (!(F_LOCK_CONCLUSION in row) || String(row[F_LOCK_CONCLUSION] ?? '') !== conclusion) {
      changed = true
      return { ...row, [F_LOCK_CONCLUSION]: conclusion }
    }
    return row
  })
  return { rows: next, changed }
}
