// 服务层冒烟：通过 localStorage 桩驱动 saveStandAllocation / batch / 动作 / 列表装饰。
const storage: Record<string, string> = {}
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (k in storage ? storage[k] : null),
    setItem: (k: string, v: string) => {
      storage[k] = v
    },
  },
}

import {
  listEntries,
  saveStandAllocation,
  saveStandAllocationBatch,
  previewStandAllocation,
  runAction,
} from '../src/api/local-service'
import { listRows, resetRows } from '../src/data/local-store'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name} ${extra}`)
  }
}

resetRows('stand')
const before = listRows('stand').length

// 1. 普通航班占应急机位 -> 退回且不入库
let res = saveStandAllocation({
  机位编号: 'STAN-301',
  匹配航班: 'XX1',
  计划占用: '2026-10-07 12:00~13:00',
})
check('应急机型错配退回', res.ok === false)
check('退回不允许保存（条数不变）', listRows('stand').length === before)

// 2. 正常分配可分配 -> 入库并锁定
res = saveStandAllocation({
  机位编号: 'STAN-102',
  匹配航班: 'SV100',
  计划占用: '2026-10-07 13:00~14:00',
})
check('可分配保存成功', res.ok === true, res.message)
const saved = listRows('stand').find((r) => String(r['匹配航班']) === 'SV100')
check('保存即锁定', saved?.['锁定标记'] === '已锁定')
check('阈值判定落库为可分配', saved?.['阈值判定'] === '可分配')
check('判定时间已记录', typeof saved?.['判定时间'] === 'string' && String(saved['判定时间']).length > 0)

// 3. 同机位同窗口第二个航班 -> 锁定冲突退回
res = saveStandAllocation({
  机位编号: 'STAN-102',
  匹配航班: 'SV101',
  计划占用: '2026-10-07 13:20~13:40',
})
check('锁定冲突保存被拒', res.ok === false && res.message.includes('退回'))

// 4. 未锁定不允许确认占用：先制造一条待复核（T1 复核线 3/4）
resetRows('stand')
// 预置 2 条 T1
saveStandAllocation({ 机位编号: 'STAN-101', 匹配航班: 'A1', 计划占用: '2026-10-07 08:00~09:00' })
saveStandAllocation({ 机位编号: 'STAN-102', 匹配航班: 'A2', 计划占用: '2026-10-07 08:00~09:00' })
res = saveStandAllocation({ 机位编号: 'STAN-103', 匹配航班: 'A3', 计划占用: '2026-10-07 08:00~09:00' })
check('复核线返回待复核并可落库', res.ok === true && res.message.includes('待复核'), res.message)
const pending = listRows('stand').find((r) => String(r['匹配航班']) === 'A3')
check('待复核记录未锁定', pending?.['锁定标记'] === '未锁定')
res = runAction('stand', Number(pending!.id), '确认占用')
check('未锁定确认占用被拒', res.ok === false && res.message.includes('尚未锁定'))

// 5. 复核通过 -> 锁定
res = runAction('stand', Number(pending!.id), '复核通过')
check('复核通过成功', res.ok === true, res.message)
check('复核后已锁定', listRows('stand').find((r) => Number(r.id) === Number(pending!.id))?.['锁定标记'] === '已锁定')

// 6. 确认占用后再复核被拒；释放清锁
const lockedId = Number(pending!.id)
check('确认占用成功', runAction('stand', lockedId, '确认占用').ok)
check('占用后复核被拒', runAction('stand', lockedId, '复核通过').ok === false)
check('释放机位成功', runAction('stand', lockedId, '释放机位').ok)
check('释放后锁定清除', listRows('stand').find((r) => Number(r.id) === lockedId)?.['锁定标记'] === '未锁定')

// 7. 并发批处理：同航班两条，仅首个成功，一次 saveRows 原子落库
resetRows('stand')
const batch = saveStandAllocationBatch([
  { 机位编号: 'STAN-201', 匹配航班: 'DUP', 计划占用: '2026-10-07 16:00~16:40' },
  { 机位编号: 'STAN-202', 匹配航班: 'DUP', 计划占用: '2026-10-07 16:00~16:40' },
])
check('批处理整体 ok（有成功项）', batch.ok === true, batch.message)
check('首个成功', batch.results[0].verdict === '可分配')
check('次个抢占退回', batch.results[1].verdict === '退回')
check('只落库 1 条 DUP', listRows('stand').filter((r) => String(r['匹配航班']) === 'DUP').length === 1)

// 8. 全退回批次不写入
resetRows('stand')
// 填满 T1
saveStandAllocation({ 机位编号: 'STAN-101', 匹配航班: 'T1', 计划占用: '2026-10-07 08:00~09:00' })
saveStandAllocation({ 机位编号: 'STAN-102', 匹配航班: 'T2', 计划占用: '2026-10-07 08:00~09:00' })
saveStandAllocation({ 机位编号: 'STAN-103', 匹配航班: 'T3', 计划占用: '2026-10-07 08:00~09:00' })
saveStandAllocation({ 机位编号: 'STAN-104', 匹配航班: 'T4', 计划占用: '2026-10-07 08:00~09:00' })
const n = listRows('stand').length
const fullBatch = saveStandAllocationBatch([
  { 机位编号: 'STAN-101', 匹配航班: 'X1', 计划占用: '2026-10-07 08:10~08:40' },
  { 机位编号: 'STAN-102', 匹配航班: 'X2', 计划占用: '2026-10-07 08:10~08:40' },
])
check('全退回批次整体失败', fullBatch.ok === false)
check('全退回不写入', listRows('stand').length === n)

// 9. 列表装饰：历史判定保持；存量缺归属显示待补录
resetRows('stand')
const list = listEntries('stand')
const legacy = list.items.find((r) => String(r['机位编号']) === 'STAN-0001')
check('存量缺归属兼容为待补录', legacy?.['阈值判定'] === '待补录')
const hist = list.items.find((r) => String(r['机位编号']) === 'STAN-201' && String(r['匹配航班']) === 'MU5108')
check('历史待复核判定原样保留', hist?.['阈值判定'] === '待复核')

// 10. 预览不产生副作用
const m = listRows('stand').length
previewStandAllocation({ 机位编号: 'STAN-204', 匹配航班: 'PV', 计划占用: '2026-10-07 13:00~14:00' })
check('预览不落库', listRows('stand').length === m)

// 11. 廊桥清单同步结论
resetRows('bridge')
const bridges = listEntries('bridge')
const b1 = bridges.items.find((r) => String(r['廊桥编号']) === 'BRID-0001')
check('廊桥同步已锁定航班', String(b1?.['机位锁定结论'] ?? '').startsWith('已锁定：CA1202'), String(b1?.['机位锁定结论']))
const b3 = bridges.items.find((r) => String(r['廊桥编号']) === 'BRID-0003')
check('廊桥缺归属同步待补录', String(b3?.['机位锁定结论'] ?? '').includes('待补录'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
