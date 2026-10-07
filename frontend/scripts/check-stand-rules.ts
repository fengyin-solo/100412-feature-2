// 规则层冒烟测试（node 直跑，不入库浏览器）：用 esbuild 即时打包后执行。
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
  evaluateStand,
  bridgeLockConclusion,
  attributionComplete,
  parseWindow,
  STAND_CATALOG,
} from '../src/data/stand-rules'

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

// 0. 主数据完整
check('机位主数据 10 条', STAND_CATALOG.length === 10)
check('窗口解析同日时刻', parseWindow('2026-10-07 08:00~09:30') !== null)
check('窗口非法返回 null', parseWindow('2026-10-07 08:00') === null)

// 存量缺归属
const legacy: any = {
  id: 1,
  status: '空闲',
  机位编号: 'STAN-0001',
  机位类型: '机位分配样例1',
  所属航站楼: '机位分配样例1',
  匹配航班: '机位分配样例1',
  计划占用: '机位分配样例1',
}
check('存量占位记录判为缺归属', attributionComplete(legacy) === false)

const good: any = {
  id: 9,
  status: '已分配',
  机位编号: 'STAN-101',
  机位类型: '近机位',
  所属航站楼: 'T1',
  匹配航班: 'CA1202',
  计划占用: '2026-10-07 08:00~09:40',
  锁定标记: '已锁定',
}
check('完整归属记录通过', attributionComplete(good) === true)

// 1. 空闲机位可分配并锁定
let rows: any[] = [good]
let r = evaluateStand(
  { 机位编号: 'STAN-102', 匹配航班: 'MU3001', 计划占用: '2026-10-07 12:00~13:00' },
  rows,
)
check('空闲机位可分配', r.verdict === '可分配', JSON.stringify(r))
check('可分配即锁定', r.locked === true)

// 2. 已锁定航班窗口冲突 -> 退回
r = evaluateStand(
  { 机位编号: 'STAN-101', 匹配航班: 'MU3002', 计划占用: '2026-10-07 09:00~09:30' },
  rows,
)
check('锁定冲突退回', r.verdict === '退回', JSON.stringify(r.reasons))
check('退回原因含已锁定优先', r.reasons.join('').includes('已锁定航班优先'))

// 3. 不重叠窗口 -> 可分配（已释放/错峰都不冲突）
r = evaluateStand(
  { 机位编号: 'STAN-101', 匹配航班: 'MU3003', 计划占用: '2026-10-07 10:00~11:00' },
  rows,
)
check('错峰窗口可分配', r.verdict === '可分配', JSON.stringify(r.reasons))

// 4. 应急机位：普通航班退回，应急航班放行
r = evaluateStand(
  { 机位编号: 'STAN-301', 匹配航班: 'CA9999', 计划占用: '2026-10-07 12:00~13:00' },
  [],
)
check('普通航班占应急机位退回', r.verdict === '退回', JSON.stringify(r.reasons))
r = evaluateStand(
  { 机位编号: 'STAN-301', 匹配航班: 'CA9999', 计划占用: '2026-10-07 12:00~13:00', 应急航班: true },
  [],
)
check('应急航班使用应急机位可分配', r.verdict === '可分配' && r.locked === true)

// 5. 复核线 75%：T1 cap=4，预置 2 条；候选使累计到 3（3/4=0.75）-> 待复核
rows = [
  { ...good, 机位编号: 'STAN-101', 所属航站楼: 'T1', 锁定标记: '已锁定', 计划占用: '2026-10-07 08:00~09:40' },
  { id: 2, status: '已分配', 机位编号: 'STAN-102', 机位类型: '远机位', 所属航站楼: 'T1', 匹配航班: 'F2', 计划占用: '2026-10-07 08:00~09:40', 锁定标记: '已锁定' },
]
r = evaluateStand(
  { 机位编号: 'STAN-103', 匹配航班: 'F3', 计划占用: '2026-10-07 08:00~09:40' },
  rows,
)
check('75% 复核线判待复核', r.verdict === '待复核', JSON.stringify(r))
check('待复核不锁定', r.locked === false)

// 6. 达到上限退回：已有 4 条 T1
const full = [
  ...rows,
  { id: 3, status: '已分配', 机位编号: 'STAN-103', 机位类型: '近机位', 所属航站楼: 'T1', 匹配航班: 'F3', 计划占用: '2026-10-07 08:00~09:40', 锁定标记: '未锁定' },
  { id: 4, status: '已分配', 机位编号: 'STAN-104', 机位类型: '远机位', 所属航站楼: 'T1', 匹配航班: 'F4', 计划占用: '2026-10-07 08:00~09:40', 锁定标记: '已锁定' },
]
r = evaluateStand(
  { 机位编号: 'STAN-101', 匹配航班: 'F5', 计划占用: '2026-10-07 09:00~09:30' },
  full,
)
check('航站楼达到上限退回', r.verdict === '退回' && r.reasons.join('').includes('上限'))

// 安全优先：即便航站楼已满，已锁定航班先于阈值；换另一航站楼确认上限不连坐
r = evaluateStand(
  { 机位编号: 'STAN-201', 匹配航班: 'T2F', 计划占用: '2026-10-07 09:00~09:30' },
  full,
)
check('航站楼计数不跨楼', r.verdict !== '退回' || !r.reasons.join('').includes('上限'))

// 7. 同航班并发抢占：串行判定两条，第二条必退回
const base = [
  { id: 1, status: '已分配', 机位编号: 'STAN-102', 机位类型: '远机位', 所属航站楼: 'T1', 匹配航班: 'DUP', 计划占用: '2026-10-07 16:00~16:40', 锁定标记: '已锁定' },
]
r = evaluateStand(
  { 机位编号: 'STAN-103', 匹配航班: 'DUP', 计划占用: '2026-10-07 16:00~16:40' },
  base,
)
check('同航班第二个请求抢占失败', r.verdict === '退回' && r.reasons.join('').includes('首个请求成功'))

// 8. 同机位待复核不硬拦 -> 待复核
const pending = [
  { id: 1, status: '已分配', 机位编号: 'STAN-204', 机位类型: '远机位', 所属航站楼: 'T2', 匹配航班: 'P1', 计划占用: '2026-10-07 10:00~11:00', 锁定标记: '未锁定' },
]
r = evaluateStand(
  { 机位编号: 'STAN-204', 匹配航班: 'P2', 计划占用: '2026-10-07 10:20~10:50' },
  pending,
)
check('同机位待复核冲突判待复核', r.verdict === '待复核')

// 9. 廊桥同步结论
check(
  '廊桥同步已锁定结论',
  bridgeLockConclusion({ 所属机位: 'STAN-101' } as any, rows).startsWith('已锁定：'),
)
check(
  '廊桥未登记机位显示待补录',
  bridgeLockConclusion({ 所属机位: '廊桥调度样例3' } as any, []).startsWith('待补录'),
)
check(
  '廊桥机位无在控航班显示未锁定',
  bridgeLockConclusion({ 所属机位: 'STAN-204' } as any, []).startsWith('未锁定'),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
