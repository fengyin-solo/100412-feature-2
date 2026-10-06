import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  BRIDGE_KEY,
  evaluateStandAllocation,
  F_ACTUAL_WINDOW,
  F_FLIGHT,
  F_JUDGED_AT,
  F_LOCKED_FLIGHT,
  F_PLAN_WINDOW,
  F_REASON,
  F_REMARK,
  F_SAFETY,
  F_STAND_NO,
  F_STAND_TYPE,
  F_TERMINAL,
  F_VERDICT,
  formatStamp,
  formatWindow,
  STAND_KEY,
  STAND_TERMINAL_STATUSES,
  syncBridgeLockConclusions,
  VERDICT_ALLOCATABLE,
  VERDICT_REJECTED,
  VERDICT_REVIEW,
  type AllocationDecision,
  type AllocationInput,
  type Verdict,
} from '@/domain/stand-allocation'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 机位登记/补录表单：页面收集，服务层组装判定，页面本身不做业务判断。
export type StandAllocationForm = {
  id?: number
  standNo: string
  standType: string
  terminal: string
  flight: string
  safety: '是' | '否'
  planStart: string
  planEnd: string
  actual?: string
  remark?: string
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function verdictStatus(verdict: Verdict): string {
  if (verdict === VERDICT_ALLOCATABLE) {
    return '已分配'
  }
  return verdict === VERDICT_REVIEW ? '待复核' : '退回'
}

function buildStandRow(
  id: number,
  form: StandAllocationForm,
  decision: AllocationDecision,
  stamp: string,
): EntryRow {
  const status = verdictStatus(decision.verdict)
  return {
    id,
    status,
    pending: !STAND_TERMINAL_STATUSES.includes(status as (typeof STAND_TERMINAL_STATUSES)[number]),
    abnormal: status === '退回' || status === '待复核',
    [F_STAND_NO]: form.standNo.trim(),
    [F_STAND_TYPE]: form.standType.trim(),
    [F_TERMINAL]: form.terminal.trim(),
    [F_FLIGHT]: form.flight.trim(),
    [F_PLAN_WINDOW]: formatWindow(form.planStart, form.planEnd),
    [F_ACTUAL_WINDOW]: (form.actual ?? '').trim(),
    [F_VERDICT]: decision.verdict,
    [F_LOCKED_FLIGHT]: decision.verdict === VERDICT_ALLOCATABLE ? form.flight.trim() : '',
    [F_JUDGED_AT]: stamp,
    [F_SAFETY]: form.safety,
    [F_REASON]: decision.reasons.join('；'),
    [F_REMARK]: (form.remark ?? '').trim(),
  }
}

/** 保存机位数据后写穿廊桥调度清单的锁定结论，保证两模块结论一致。 */
function persistStandRows(rows: EntryRow[]): void {
  const bridgeRows = listRows(BRIDGE_KEY)
  const bridge = syncBridgeLockConclusions(bridgeRows, rows)
  if (bridge.changed) {
    saveAll({ ...allRows(), [STAND_KEY]: rows, [BRIDGE_KEY]: bridge.rows })
    return
  }
  saveRows(STAND_KEY, rows)
}

function toAllocationInput(form: StandAllocationForm): AllocationInput {
  return {
    [F_STAND_NO]: form.standNo.trim(),
    [F_STAND_TYPE]: form.standType.trim(),
    [F_TERMINAL]: form.terminal.trim(),
    [F_FLIGHT]: form.flight.trim(),
    [F_PLAN_WINDOW]: formatWindow(form.planStart, form.planEnd),
    [F_SAFETY]: form.safety,
  }
}

/**
 * 机位分配登记：机位编号、机位类型、所属航站楼、匹配航班进入计划占用范围后按规则判定。
 * 退回（含超上限、同航班抢占落败、规则冲突落败）不允许保存。
 */
export function submitStandAllocation(form: StandAllocationForm): ActionResult {
  const rows = listRows(STAND_KEY)
  const decision = evaluateStandAllocation(toAllocationInput(form), rows)
  const stamp = formatStamp(new Date())
  if (decision.verdict === VERDICT_REJECTED) {
    return { ok: false, message: `判定退回，未保存：${decision.reasons.join('；')}` }
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  persistStandRows([...rows, buildStandRow(id, form, decision, stamp)])
  if (decision.verdict === VERDICT_ALLOCATABLE) {
    return {
      ok: true,
      message: `判定可分配：${decision.reasons.join('；')}。机位已锁定航班 ${form.flight.trim()}，廊桥调度清单已同步`,
    }
  }
  return { ok: true, message: `判定待复核：${decision.reasons.join('；')}。已登记但不锁定机位，待人工复核` }
}

/**
 * 待复核记录人工复核：重新按当前占用情况判定。
 * 超出上限等退回情形仍不允许保存为分配；复核通过且仍可分配才锁定并同步廊桥。
 */
export function reviewStandAllocation(id: number, approved: boolean): ActionResult {
  const rows = listRows(STAND_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的机位分配记录` }
  }
  const current = rows[index]
  if (current.status !== '待复核') {
    return { ok: false, message: `记录当前为「${current.status}」，只有待复核记录能复核` }
  }

  const stamp = formatStamp(new Date())
  if (!approved) {
    const updated: EntryRow = {
      ...current,
      status: '退回',
      pending: false,
      abnormal: true,
      [F_VERDICT]: VERDICT_REJECTED,
      [F_LOCKED_FLIGHT]: '',
      [F_JUDGED_AT]: stamp,
      [F_REASON]: '人工复核退回，不允许保存为已分配',
    }
    const next = [...rows]
    next[index] = updated
    persistStandRows(next)
    return { ok: true, message: '复核不通过，记录已退回' }
  }

  const decision = evaluateStandAllocation(toAllocationInput(toFormInput(current)), rows, { selfId: id })
  if (decision.verdict === VERDICT_REJECTED) {
    return { ok: false, message: `复核未通过，按当前占用情况应退回：${decision.reasons.join('；')}` }
  }
  if (decision.verdict === VERDICT_REVIEW) {
    const updated: EntryRow = {
      ...current,
      [F_JUDGED_AT]: stamp,
      [F_REASON]: `复核时仍处待复核区间：${decision.reasons.join('；')}`,
    }
    const next = [...rows]
    next[index] = updated
    persistStandRows(next)
    return { ok: true, message: `暂不具备通过条件，维持待复核：${decision.reasons.join('；')}` }
  }

  const updated: EntryRow = {
    ...current,
    status: '已分配',
    pending: true,
    abnormal: false,
    [F_VERDICT]: VERDICT_ALLOCATABLE,
    [F_LOCKED_FLIGHT]: String(current[F_FLIGHT] ?? ''),
    [F_JUDGED_AT]: stamp,
    [F_REASON]: `人工复核通过：${decision.reasons.join('；')}`,
  }
  const next = [...rows]
  next[index] = updated
  persistStandRows(next)
  return {
    ok: true,
    message: `复核通过，机位已锁定航班 ${current[F_FLIGHT]}，廊桥调度清单已同步`,
  }
}

/** 存量缺归属记录补录：补齐字段后同样走阈值判定，退回则仍不允许保存。 */
export function supplementStandRow(id: number, form: StandAllocationForm): ActionResult {
  const rows = listRows(STAND_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的机位分配记录` }
  }
  if (rows[index].status !== '待补录') {
    return { ok: false, message: `记录当前为「${rows[index].status}」，只有待补录记录需要补录归属` }
  }
  const decision = evaluateStandAllocation(toAllocationInput(form), rows, { selfId: id })
  if (decision.verdict === VERDICT_REJECTED) {
    return { ok: false, message: `补录后判定退回，未保存：${decision.reasons.join('；')}` }
  }
  const stamp = formatStamp(new Date())
  const next = [...rows]
  next[index] = buildStandRow(id, form, decision, stamp)
  persistStandRows(next)
  if (decision.verdict === VERDICT_ALLOCATABLE) {
    return {
      ok: true,
      message: `补录完成并判定可分配，机位已锁定航班 ${form.flight.trim()}，廊桥调度清单已同步`,
    }
  }
  return { ok: true, message: `补录完成，当前判定待复核：${decision.reasons.join('；')}` }
}

function toFormInput(row: EntryRow): StandAllocationForm {
  const window = String(row[F_PLAN_WINDOW] ?? '')
  const [start = '', end = ''] = window.split(/~|～|至|——/)
  return {
    standNo: String(row[F_STAND_NO] ?? ''),
    standType: String(row[F_STAND_TYPE] ?? ''),
    terminal: String(row[F_TERMINAL] ?? ''),
    flight: String(row[F_FLIGHT] ?? ''),
    safety: String(row[F_SAFETY] ?? '否') === '是' ? '是' : '否',
    planStart: start.trim(),
    planEnd: end.trim(),
    actual: String(row[F_ACTUAL_WINDOW] ?? ''),
    remark: String(row[F_REMARK] ?? ''),
  }
}

/** 机位模块的状态动作：规则收敛在此，页面只按状态摆按钮。 */
function runStandAction(id: number, action: string): ActionResult {
  const rows = listRows(STAND_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的机位分配记录` }
  }
  const current = rows[index]

  if (action === '复核通过' || action === '复核退回') {
    return reviewStandAllocation(id, action === '复核通过')
  }

  if (action === '确认占用') {
    if (current.status !== '已分配') {
      return { ok: false, message: `只有已分配机位能确认占用，当前为「${current.status}」` }
    }
    const updated: EntryRow = {
      ...current,
      status: '占用中',
      pending: false,
      abnormal: false,
      [F_ACTUAL_WINDOW]:
        String(current[F_ACTUAL_WINDOW] ?? '') || String(current[F_PLAN_WINDOW] ?? ''),
    }
    const next = [...rows]
    next[index] = updated
    persistStandRows(next)
    return { ok: true, message: `机位 ${current[F_STAND_NO]} 已确认占用，锁定结论保持并同步廊桥` }
  }

  if (action === '释放机位') {
    if (current.status !== '占用中' && current.status !== '已分配') {
      return { ok: false, message: `只有已分配或占用中的机位能释放，当前为「${current.status}」` }
    }
    const updated: EntryRow = {
      ...current,
      status: '已释放',
      pending: false,
      abnormal: false,
      [F_LOCKED_FLIGHT]: '',
    }
    const next = [...rows]
    next[index] = updated
    persistStandRows(next)
    return { ok: true, message: `机位 ${current[F_STAND_NO]} 已释放航班 ${current[F_FLIGHT]}，廊桥调度清单已同步解除` }
  }

  return { ok: false, message: `机位分配记录不支持直接「${action}」，请走登记/复核入口` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === STAND_KEY) {
    return runStandAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
