import { migrateBridgeRows, migrateStandRows, STAND_KEY, BRIDGE_KEY } from '@/domain/stand-allocation'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 存量结构兼容：旧版机位记录缺判定/归属字段，廊桥记录缺锁定结论。
 * 首次读到旧结构时就地迁移并写回，之后历史判定按当时保留、不再重算。
 */
function normalize(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  let changed = false
  const next: Record<string, EntryRow[]> = { ...data }

  if (next[STAND_KEY]) {
    const stand = migrateStandRows(next[STAND_KEY])
    if (stand.changed) {
      changed = true
      next[STAND_KEY] = stand.rows
    }
    if (next[BRIDGE_KEY]) {
      const bridge = migrateBridgeRows(next[BRIDGE_KEY], next[STAND_KEY])
      if (bridge.changed) {
        changed = true
        next[BRIDGE_KEY] = bridge.rows
      }
    }
  }

  if (changed && typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalize(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 旧库里可能没有新版模块，缺失的仍用示例数据补齐。
    return normalize({ ...fallback, ...parsed })
  } catch {
    const seeded = normalize(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveAll(rows: Record<string, EntryRow[]>): void {
  cache = rows
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
