<template>
  <section class="page" data-module="stand">
    <header class="page-head">
      <div>
        <h2>机位分配管理</h2>
        <p class="page-desc">机位编号、机位类型、所属航站楼、匹配航班进入计划占用范围后，按占用阈值给出可分配、待复核或退回；冲突以安全和已锁定航班为准，超上限不允许保存。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记机位分配</button>
        <button class="btn" type="button" @click="exportRows">导出机位分配清单</button>
      </div>
    </header>

    <p class="threshold-hint">
      航站楼同时占用上限：<strong>T1 5 / T2 4 / T3 3（默认 3）</strong>，达到 80% 预警线普通航班转待复核，安全航班优先通过；超出上限直接退回且不保存。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
            <span v-if="column === '判定结论'" :class="['verdict-tag', verdictClass(String(row[column]))]">
              {{ row[column] || '—' }}
            </span>
            <span v-else-if="column === '安全标记'">{{ row[column] === '是' ? '🛡 安全航班' : '普通' }}</span>
            <span v-else>{{ row[column] || '—' }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              :class="['link', action === '复核退回' ? 'link-danger' : '']"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="actionsFor(row).length === 0" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机位分配数据，可先登记机位分配</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条机位分配记录，历史分配状态按当时判定保留</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <div v-if="formVisible" class="modal-mask" @click.self="closeForm">
      <form class="modal-panel" @submit.prevent="submitForm">
        <h3 class="modal-title">{{ formMode === 'create' ? '登记机位分配' : '补录机位归属' }}</h3>
        <p class="modal-hint">提交后按占用阈值自动判定；退回（含超上限、同航班抢占落败）不会保存。</p>

        <label class="form-item">
          <span>机位编号 *</span>
          <input v-model="form.standNo" required placeholder="如 STAN-108" />
        </label>
        <label class="form-item">
          <span>机位类型 *</span>
          <select v-model="form.standType" required>
            <option value="" disabled>请选择</option>
            <option>近机位</option>
            <option>远机位</option>
            <option>货机位</option>
          </select>
        </label>
        <label class="form-item">
          <span>所属航站楼 *</span>
          <select v-model="form.terminal" required>
            <option value="" disabled>请选择</option>
            <option>T1</option>
            <option>T2</option>
            <option>T3</option>
          </select>
        </label>
        <label class="form-item">
          <span>匹配航班 *</span>
          <input v-model="form.flight" required placeholder="如 CA1202" />
        </label>
        <label class="form-item">
          <span>安全标记</span>
          <select v-model="form.safety">
            <option value="否">普通航班</option>
            <option value="是">安全航班（冲突时优先）</option>
          </select>
        </label>
        <label class="form-item">
          <span>计划占用开始 *</span>
          <input v-model="form.planStart" type="datetime-local" required />
        </label>
        <label class="form-item">
          <span>计划占用结束 *</span>
          <input v-model="form.planEnd" type="datetime-local" required />
        </label>
        <label class="form-item form-wide">
          <span>备注说明</span>
          <input v-model="form.remark" placeholder="可留空" />
        </label>

        <p v-if="formError" class="error-text form-message">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="submit">{{ formMode === 'create' ? '提交判定' : '保存补录' }}</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitStandAllocation,
  supplementStandRow,
  type StandAllocationForm,
} from '@/api/local-service'
import { isLockedStand } from '@/domain/stand-allocation'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('stand')
const columns = meta.fields
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '空闲机位', value: rows.value.filter((row) => row.status === '空闲').length },
  { label: '占用中机位', value: rows.value.filter((row) => row.status === '占用中').length },
  { label: '待复核机位', value: rows.value.filter((row) => row.status === '待复核' || row.status === '待补录').length },
  { label: '锁定机位', value: rows.value.filter(isLockedStand).length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

/** 动作按当前状态给：退回/历史态不能直接改判，业务判断都在服务层，这里只控制入口。 */
function actionsFor(row: EntryRow): string[] {
  switch (row.status) {
    case '已分配':
      return ['确认占用', '释放机位']
    case '占用中':
      return ['释放机位']
    case '待复核':
      return ['复核通过', '复核退回']
    case '待补录':
      return ['补录归属']
    default:
      return []
  }
}

function verdictClass(verdict: string): string {
  if (verdict === '可分配') {
    return 'verdict-ok'
  }
  return verdict === '待复核' ? 'verdict-review' : verdict === '退回' ? 'verdict-reject' : ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

const emptyForm = (): StandAllocationForm => ({
  standNo: '',
  standType: '',
  terminal: '',
  flight: '',
  safety: '否',
  planStart: '',
  planEnd: '',
  actual: '',
  remark: '',
})

const formVisible = ref(false)
const formError = ref('')
const formMode = ref<'create' | 'supplement'>('create')
const supplementId = ref<number | null>(null)
const form = reactive<StandAllocationForm>(emptyForm())

function openCreate() {
  Object.assign(form, emptyForm())
  formMode.value = 'create'
  supplementId.value = null
  formError.value = ''
  formVisible.value = true
}

function openSupplement(row: EntryRow) {
  Object.assign(form, emptyForm(), {
    standNo: String(row['机位编号'] ?? ''),
    standType: String(row['机位类型'] ?? ''),
    terminal: String(row['所属航站楼'] ?? ''),
    flight: String(row['匹配航班'] ?? ''),
    safety: String(row['安全标记'] ?? '否') === '是' ? '是' : '否',
    remark: String(row['备注说明'] ?? ''),
  })
  formMode.value = 'supplement'
  supplementId.value = Number(row.id)
  formError.value = ''
  formVisible.value = true
}

function closeForm() {
  formVisible.value = false
}

function submitForm() {
  formError.value = ''
  if (form.planEnd <= form.planStart) {
    formError.value = '计划占用结束时间必须晚于开始时间'
    return
  }
  const result =
    formMode.value === 'supplement' && supplementId.value !== null
      ? supplementStandRow(supplementId.value, { ...form })
      : submitStandAllocation({ ...form })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  successMessage.value = result.message
  errorMessage.value = ''
  formVisible.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  if (action === '补录归属') {
    openSupplement(row)
    return
  }
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
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

<style scoped>
.threshold-hint {
  margin: 0 0 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: #475569;
  background: #eef4ff;
  border: 1px solid #c7d9f7;
  border-radius: 6px;
}
.verdict-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
}
.verdict-ok {
  color: #067647;
  background: #e7f6ec;
}
.verdict-review {
  color: #b54708;
  background: #fdf1e2;
}
.verdict-reject {
  color: #b42318;
  background: #fdeaea;
}
.muted-text {
  color: var(--muted);
}
.link-danger {
  color: #b42318;
}
.success-text {
  color: #067647;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-panel {
  width: 560px;
  max-width: calc(100vw - 40px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.modal-title {
  margin: 0;
  grid-column: 1 / -1;
  font-size: 16px;
}
.modal-hint {
  margin: 0 0 4px;
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--muted);
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.form-item input,
.form-item select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: #1f2937;
}
.form-wide {
  grid-column: 1 / -1;
}
.form-message {
  grid-column: 1 / -1;
  margin: 0;
}
.modal-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
