<script setup lang="ts">
import { ref } from 'vue'
import type { Profile } from '../api'

const props = defineProps<{ profile: Profile; saving: boolean }>()
const emit = defineEmits<{ save: [{ name: string; email: string }]; cancel: [] }>()

const name = ref(props.profile.name)
const email = ref(props.profile.email)

function submit(): void {
  emit('save', { name: name.value.trim(), email: email.value.trim() })
}
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2 class="card-title">编辑资料</h2>
    </div>

    <form @submit.prevent="submit">
      <div class="field">
        <label class="field-label">昵称</label>
        <input v-model="name" class="field-input" type="text" placeholder="请输入昵称" />
      </div>

      <div class="field">
        <label class="field-label">邮箱</label>
        <input v-model="email" class="field-input" type="text" placeholder="请输入邮箱" />
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" type="submit" :disabled="saving">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button class="btn btn-ghost" type="button" @click="$emit('cancel')">取消</button>
      </div>
    </form>
  </section>
</template>
