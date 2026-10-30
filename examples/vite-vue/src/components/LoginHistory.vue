<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getLoginHistory, logout, type LoginRecord } from '../api'

const rows = ref<LoginRecord[]>([])
const loading = ref(false)
const message = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    rows.value = await getLoginHistory()
  } catch (err) {
    message.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

async function doLogout(): Promise<void> {
  try {
    await logout()
    message.value = '已退出登录（演示，不会真的登出）'
  } catch (err) {
    message.value = (err as Error).message
  }
}

onMounted(load)
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2 class="card-title">登录记录</h2>
      <div class="profile-actions">
        <button class="btn" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
        <button class="btn btn-danger" @click="doLogout">退出登录</button>
      </div>
    </div>

    <table class="table">
      <thead>
        <tr>
          <th>时间</th>
          <th>设备</th>
          <th>IP</th>
          <th>地点</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.time">
          <td>{{ row.time }}</td>
          <td>{{ row.device }}</td>
          <td>{{ row.ip }}</td>
          <td>{{ row.place }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="!rows.length && !loading" class="empty">暂无登录记录</p>
    <p v-if="message" class="hint hint-ok">{{ message }}</p>
  </section>
</template>
