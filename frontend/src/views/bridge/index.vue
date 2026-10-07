<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥调度管理</h2>
        <p class="page-desc">
          维护廊桥，围绕廊桥编号、所属机位、对接机型、调度人员做登记、筛选与状态流转；
          机位锁定结论由机位分配模块实时同步，安排对接前请先确认。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记廊桥</button>
        <button class="btn" type="button" @click="exportRows">导出廊桥调度清单</button>
      </div>
    </header>

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
            <span v-if="column === '机位锁定结论'" class="lock-conclusion" :class="conclusionClass(String(row[column]))">
              {{ row[column] ?? '—' }}
            </span>
            <template v-else>{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
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
          <td :colspan="columns.length + 2" class="empty-state">暂无廊桥调度数据，可先登记廊桥</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥调度记录（机位锁定结论与机位分配模块保持同步）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('bridge')
const columns = ["廊桥编号", "所属机位", "对接机型", "调度人员", "计划对接", "实际对接", "脱离时间", "廊桥状态", "机位锁定结论"]
const actions = ["安排对接", "确认脱离", "停用报修"]
const statuses = ["待对接", "已对接", "已脱离", "故障停用"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["廊桥编号", "所属机位", "对接机型"]
const stats = computed(() => [
  { label: '待对接廊桥', value: rows.value.filter((row) => String(row.status) === '待对接').length },
  { label: '已对接廊桥', value: rows.value.filter((row) => String(row.status) === '已对接').length },
  { label: '机位已锁定同步', value: rows.value.filter((row) => String(row['机位锁定结论'] ?? '').startsWith('已锁定')).length },
  { label: '故障廊桥', value: rows.value.filter((row) => String(row.status) === '故障停用').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function conclusionClass(conclusion: string): string {
  if (conclusion.startsWith('已锁定')) {
    return 'is-ok'
  }
  if (conclusion.startsWith('待复核')) {
    return 'is-warn'
  }
  if (conclusion.startsWith('待补录')) {
    return 'is-backfill'
  }
  return 'is-idle'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '廊桥登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊桥调度列表读取失败'
  }
}

onMounted(reload)
</script>
