<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ProfileCard from '../components/ProfileCard.vue'
import ProfileForm from '../components/ProfileForm.vue'
import LoginHistory from '../components/LoginHistory.vue'
import { ApiError, getProfile, saveProfile, type Profile } from '../api'

const profile = ref<Profile | null>(null)
const editing = ref(false)
const saving = ref(false)
const errorText = ref('')
const okText = ref('')

onMounted(async () => {
  try {
    profile.value = await getProfile()
  } catch (err) {
    errorText.value = (err as Error).message
  }
})

function startEdit(): void {
  errorText.value = ''
  okText.value = ''
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  errorText.value = ''
}

async function handleSave(payload: { name: string; email: string }): Promise<void> {
  saving.value = true
  errorText.value = ''
  okText.value = ''
  try {
    profile.value = await saveProfile(payload)
    editing.value = false
    okText.value = '资料已保存'
  } catch (err) {
    errorText.value = err instanceof ApiError ? `${err.message}（${err.status}）` : (err as Error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">账号设置</h1>
        <p class="page-desc">管理你的个人资料、登录设备与安全选项</p>
      </div>
      <span class="tag">开发模式</span>
    </header>

    <ProfileCard
      v-if="profile"
      :profile="profile"
      @edit="startEdit"
    />

    <ProfileForm
      v-if="profile && editing"
      :profile="profile"
      :saving="saving"
      @save="handleSave"
      @cancel="cancelEdit"
    />

    <p v-if="errorText" class="hint hint-error">{{ errorText }}</p>
    <p v-if="okText" class="hint hint-ok">{{ okText }}</p>

    <LoginHistory />
  </div>
</template>
