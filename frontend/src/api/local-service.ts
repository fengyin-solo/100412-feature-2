import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  BACKFILL_VERDICT,
  BRIDGE_KEY,
  LOCKED,
  STAND_KEY,
  UNLOCKED,
  attributionComplete,
  bridgeLockConclusion,
  evaluateReviewLock,
  evaluateStand,
  formatStamp,
  isLockedStand,
  type StandDraft,
  type StandEvaluation,
} from '@/data/stand-rules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

// 存量缺归属记录兼容：读取时补「待补录」结论，但不改写底层数据，保存后才落真实结论。
// 历史分配状态仍按当时判定：已经写过阈值判定的记录一律保持原结论，不随现在的数据重算。
export function decorateStandRows(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    if (String(row['阈值判定'] ?? '').trim() !== '') {
      return { ...row, 锁定标记: String(row['锁定标记'] ?? UNLOCKED) }
    }
    if (attributionComplete(row)) {
      return { ...row, 锁定标记: isLockedStand(row) ? LOCKED : UNLOCKED }
    }
    return { ...row, 阈值判定: BACKFILL_VERDICT, 锁定标记: UNLOCKED }
  })
}

export function decorateBridgeRows(rows: EntryRow[]): EntryRow[] {
  const standRows = listRows(STAND_KEY)
  return rows.map((row) => ({
    ...row,
    机位锁定结论: bridgeLockConclusion(row, standRows),
  }))
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = listRows(key)
  const decorated =
    key === STAND_KEY
      ? decorateStandRows(source)
      : key === BRIDGE_KEY
        ? decorateBridgeRows(source)
        : source
  const matched = filterRows(decorated, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 保存前预览判定：不落库，表单实时展示「可分配 / 待复核 / 退回」及原因。
export function previewStandAllocation(draft: StandDraft): StandEvaluation {
  return evaluateStand(draft)
}

function nextStandId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function buildStandRow(
  draft: StandDraft,
  evaluation: StandEvaluation,
  id: number,
): EntryRow {
  const catalog = evaluation.standType
    ? { 机位类型: evaluation.standType, 所属航站楼: evaluation.terminal }
    : { 机位类型: '', 所属航站楼: '' }
  const stamp = formatStamp()
  const emergencyNote = evaluation.emergency ? '应急航班，安全优先；' : ''
  return {
    id,
    status: '已分配',
    pending: true,
    abnormal: false,
    机位编号: draft.机位编号.trim(),
    机位类型: catalog.机位类型,
    所属航站楼: catalog.所属航站楼,
    匹配航班: draft.匹配航班.trim(),
    计划占用: draft.计划占用.trim(),
    实际占用: '',
    分配状态: evaluation.verdict,
    备注说明: `${emergencyNote}${evaluation.reasons.join('；')}`,
    阈值判定: evaluation.verdict,
    锁定标记: evaluation.locked ? LOCKED : UNLOCKED,
    判定时间: stamp,
  }
}

// 单条分配保存：可分配落库即锁定，待复核落库待人工复核，退回直接拒绝保存。
export function saveStandAllocation(draft: StandDraft): ActionResult {
  const rows = listRows(STAND_KEY)
  const evaluation = evaluateStand(draft, rows)
  if (evaluation.verdict === '退回') {
    return { ok: false, message: `分配已退回，不允许保存：${evaluation.reasons.join('；')}` }
  }
  const row = buildStandRow(draft, evaluation, nextStandId(rows))
  saveRows(STAND_KEY, [...rows, row])
  return {
    ok: true,
    message:
      evaluation.verdict === '可分配'
        ? `机位 ${draft.机位编号} 判定可分配，已锁定给航班 ${draft.匹配航班}`
        : `机位 ${draft.机位编号} 判定待复核，已登记但暂不锁定：${evaluation.reasons.join('；')}`,
  }
}

// 同一航班并发抢占只允许首个成功：按请求顺序在同一份快照上串行判定，
// 全部判定完成后一次性原子落库——中途任何一条都不写，模拟事务的「同时提交」。
export function saveStandAllocationBatch(drafts: StandDraft[]): {
  ok: boolean
  message: string
  results: { draft: StandDraft; verdict: string; message: string }[]
} {
  if (drafts.length === 0) {
    return { ok: false, message: '没有需要提交的分配请求', results: [] }
  }
  const rows = [...listRows(STAND_KEY)]
  const accepted: EntryRow[] = []
  const results: { draft: StandDraft; verdict: string; message: string }[] = []

  for (const draft of drafts) {
    const evaluation = evaluateStand(draft, [...rows, ...accepted])
    if (evaluation.verdict === '退回') {
      results.push({ draft, verdict: '退回', message: evaluation.reasons.join('；') })
      continue
    }
    const row = buildStandRow(draft, evaluation, nextStandId([...rows, ...accepted]))
    accepted.push(row)
    results.push({
      draft,
      verdict: evaluation.verdict,
      message: evaluation.reasons.join('；'),
    })
  }

  const savedCount = accepted.length
  if (savedCount === 0) {
    return {
      ok: false,
      message: `全部 ${drafts.length} 条请求均被退回，未写入任何分配`,
      results,
    }
  }
  saveRows(STAND_KEY, [...rows, ...accepted])
  const rejected = drafts.length - savedCount
  return {
    ok: true,
    message:
      rejected === 0
        ? `${savedCount} 条分配全部判定成功并已保存`
        : `${savedCount} 条成功保存，${rejected} 条抢占失败已退回（同一航班/机位仅首个请求成功）`,
    results,
  }
}

// 复核通过：重新走硬约束判定，通过则把待复核记录锁定；判定变退回则拒绝并保留原状。
function approveStandReview(id: number): ActionResult {
  const rows = listRows(STAND_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的机位分配` }
  }
  const current = rows[index]
  if (isLockedStand(current)) {
    return { ok: false, message: '该机位分配已经锁定，无需重复复核' }
  }
  if (String(current['阈值判定'] ?? '') === '退回') {
    return { ok: false, message: '该机位分配已退回，请重新发起分配' }
  }
  const evaluation = evaluateReviewLock(current, rows)
  if (evaluation.verdict === '退回') {
    return { ok: false, message: `复核不通过：${evaluation.reasons.join('；')}` }
  }
  const updated: EntryRow = {
    ...current,
    锁定标记: LOCKED,
    判定时间: formatStamp(),
    备注说明: `${current['备注说明'] ?? ''}；复核通过并锁定（历史判定仍保留为 ${current['阈值判定'] ?? BACKFILL_VERDICT}）`.replace(
      /^；/,
      '',
    ),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(STAND_KEY, next)
  return {
    ok: true,
    message: `机位 ${current['机位编号']} 复核通过，已锁定给航班 ${current['匹配航班']}`,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)

  if (key === STAND_KEY && action === '复核通过') {
    return approveStandReview(id)
  }

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

  // 机位模块的专属动作约束：
  // 确认占用必须先锁定（安全优先，未锁定机位不允许进入实际占用）；释放机位同步解除锁定。
  let updated: EntryRow | null = null
  if (key === STAND_KEY) {
    if (action === '确认占用' && !isLockedStand(rows[index])) {
      return {
        ok: false,
        message: '机位尚未锁定（仍待复核或缺归属），不允许确认占用，请先完成复核或补录',
      }
    }
    updated = {
      ...rows[index],
      status: target,
      pending: target !== meta.statuses[meta.statuses.length - 1],
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
      实际占用: action === '确认占用' ? formatStamp() : rows[index]['实际占用'] ?? '',
      锁定标记: action === '释放机位' ? UNLOCKED : rows[index]['锁定标记'] ?? UNLOCKED,
    }
  } else {
    updated = {
      ...rows[index],
      status: target,
      pending: target !== meta.statuses[meta.statuses.length - 1],
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
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
  // 导出也走装饰层：机位带出历史/补录判定，廊桥带随机位锁定结论同步值。
  const rows =
    key === STAND_KEY
      ? decorateStandRows(listRows(key))
      : key === BRIDGE_KEY
        ? decorateBridgeRows(listRows(key))
        : listRows(key)
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
