<template>
  <section class="page" data-module="stand">
    <header class="page-head">
      <div>
        <h2>机位分配管理</h2>
        <p class="page-desc">
          机位编号、机位类型、所属航站楼和匹配航班进入计划占用范围后，按占用阈值给出
          <b>可分配</b>、<b>待复核</b>或<b>退回</b>；规则冲突以安全和已锁定航班为准，超出上限不允许保存。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出机位分配清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.verdict" class="legend-item">
        {{ item.verdict }}：{{ item.count }}
      </span>
    </p>

    <form class="alloc-panel" @submit.prevent="submitAllocation">
      <h3 class="alloc-title">登记机位分配（保存前先过占用阈值判定）</h3>
      <div class="alloc-grid">
        <label class="filter-item">
          <span>机位编号</span>
          <select v-model="form.机位编号" @change="syncCatalog">
            <option value="">请选择机位</option>
            <option v-for="item in catalog" :key="item.机位编号" :value="item.机位编号">
              {{ item.机位编号 }}（{{ item.所属航站楼 }} · {{ item.机位类型 }}）
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>机位类型</span>
          <input v-model="form.机位类型" readonly placeholder="随机位自动带出" />
        </label>
        <label class="filter-item">
          <span>所属航站楼</span>
          <input v-model="form.所属航站楼" readonly placeholder="随机位自动带出" />
        </label>
        <label class="filter-item">
          <span>匹配航班</span>
          <input v-model="form.匹配航班" placeholder="如 CA1202" />
        </label>
        <label class="filter-item wide">
          <span>计划占用（开始~结束）</span>
          <input v-model="form.计划占用" placeholder="2026-10-07 08:00~09:30" />
        </label>
        <label class="filter-item emergency">
          <input v-model="form.应急航班" type="checkbox" />
          <span>应急航班（应急机位 / 安全优先）</span>
        </label>
      </div>

      <div v-if="preview" class="verdict-box" :class="verdictClass(preview.verdict)">
        <div class="verdict-head">
          <strong>{{ preview.verdict }}</strong>
          <span class="occupy">
            {{ preview.terminal || '—' }} 占用
            {{ preview.occupancy.used }}/{{ preview.occupancy.cap || '—' }}
            <template v-if="preview.occupancy.cap">
              （{{ (preview.occupancy.ratio * 100).toFixed(0) }}%）
            </template>
            <em>· 复核线 75%，达到上限即退回</em>
          </span>
        </div>
        <ul class="verdict-reasons">
          <li v-for="(reason, idx) in preview.reasons" :key="idx">{{ reason }}</li>
        </ul>
      </div>

      <div class="alloc-actions">
        <button class="btn primary" type="submit">保存分配（退回项不允许落库）</button>
        <button class="btn" type="button" @click="simulateContention">
          并发抢占演示（同航班两请求只首个成功）
        </button>
      </div>
      <p v-if="infoMessage" class="info-text">{{ infoMessage }}</p>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span
              v-if="column === '阈值判定'"
              class="verdict-tag"
              :class="verdictClass(String(row[column]))"
            >{{ row[column] }}</span>
            <span v-else-if="column === '锁定标记'" :class="lockClass(String(row[column]))">
              {{ row[column] }}
            </span>
            <template v-else>{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机位分配数据，可先登记机位分配</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条机位分配记录（历史分配状态保持当时判定，不随现行规则重算）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  previewStandAllocation,
  runAction as applyAction,
  saveStandAllocation,
  saveStandAllocationBatch,
} from '@/api/local-service'
import {
  BACKFILL_VERDICT,
  LOCKED,
  STAND_CATALOG,
  type StandDraft,
  type StandEvaluation,
} from '@/data/stand-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('stand')
const columns = [
  '机位编号', '机位类型', '所属航站楼', '匹配航班', '计划占用', '实际占用',
  '分配状态', '备注说明', '阈值判定', '锁定标记', '判定时间',
]
const statuses = ['可分配', '待复核', '退回', BACKFILL_VERDICT]
const catalog = STAND_CATALOG

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['机位编号', '机位类型', '所属航站楼', '匹配航班']

const form = reactive<StandDraft & { 机位类型: string; 所属航站楼: string }>({
  机位编号: '',
  机位类型: '',
  所属航站楼: '',
  匹配航班: '',
  计划占用: '2026-10-07 14:00~15:00',
  应急航班: false,
})

function syncCatalog() {
  const hit = STAND_CATALOG.find((item) => item.机位编号 === form.机位编号)
  form.机位类型 = hit ? hit.机位类型 : ''
  form.所属航站楼 = hit ? hit.所属航站楼 : ''
}

const preview = computed<StandEvaluation | null>(() => {
  if (!form.机位编号 || !form.匹配航班.trim() || !form.计划占用.trim()) {
    return null
  }
  return previewStandAllocation({
    机位编号: form.机位编号,
    匹配航班: form.匹配航班,
    计划占用: form.计划占用,
    应急航班: form.应急航班,
  })
})

const stats = computed(() => {
  const locked = rows.value.filter((row) => String(row['锁定标记']) === LOCKED).length
  const pending = rows.value.filter((row) => String(row['阈值判定']) === '待复核').length
  const inUse = rows.value.filter((row) => String(row.status) === '占用中').length
  return [
    { label: '占用中机位', value: inUse },
    { label: '已锁定机位', value: locked },
    { label: '待复核机位', value: pending },
    { label: '缺归属待补录', value: rows.value.filter((row) => String(row['阈值判定']) === BACKFILL_VERDICT).length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((verdict) => ({
    verdict,
    count: rows.value.filter((row) => String(row['阈值判定']) === verdict).length,
  })),
)

function verdictClass(verdict: string): string {
  if (verdict === '可分配') {
    return 'is-ok'
  }
  if (verdict === '待复核') {
    return 'is-warn'
  }
  if (verdict === BACKFILL_VERDICT) {
    return 'is-backfill'
  }
  return 'is-bad'
}

function lockClass(lock: string): string {
  return lock === LOCKED ? 'lock-on' : 'lock-off'
}

// 动作按记录状态裁剪：待复核才出现「复核通过」，锁定后才能「确认占用」。
function availableActions(row: EntryRow): string[] {
  const verdict = String(row['阈值判定'] ?? '')
  if (verdict === BACKFILL_VERDICT) {
    return []
  }
  const actions: string[] = []
  if (String(row.status) === '已分配' && String(row['锁定标记']) !== LOCKED) {
    actions.push('复核通过')
  }
  if (String(row.status) === '已分配') {
    actions.push('确认占用')
  }
  if (String(row.status) === '占用中') {
    actions.push('释放机位')
  }
  return actions
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitAllocation() {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = saveStandAllocation({
    机位编号: form.机位编号,
    匹配航班: form.匹配航班,
    计划占用: form.计划占用,
    应急航班: form.应急航班,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

// 同一航班、同一时刻抢两个机位：规则层串行判定 + 单次原子落库，只有首个请求成功。
function simulateContention() {
  errorMessage.value = ''
  infoMessage.value = ''
  const flight = form.匹配航班.trim() || `DB${Math.floor(Math.random() * 9000 + 1000)}`
  const window = form.计划占用.trim() || '2026-10-07 16:00~16:40'
  const batch = saveStandAllocationBatch([
    { 机位编号: 'STAN-102', 匹配航班: flight, 计划占用: window },
    { 机位编号: 'STAN-103', 匹配航班: flight, 计划占用: window },
  ])
  infoMessage.value = batch.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '机位分配列表读取失败'
  }
}

onMounted(reload)
</script>
