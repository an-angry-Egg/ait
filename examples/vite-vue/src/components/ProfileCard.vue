<script setup lang="ts">
import type { Profile } from '../api'

defineProps<{ profile: Profile }>()
defineEmits<{ edit: [] }>()
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2 class="card-title">个人资料</h2>
      <span class="tag">{{ profile.role }}</span>
    </div>

    <div class="profile-row">
      <div class="avatar">{{ profile.avatar }}</div>
      <div class="profile-meta">
        <p class="profile-name">{{ profile.name }}</p>
        <p class="profile-sub">{{ profile.email }} · {{ profile.phone }}</p>
      </div>
      <div class="profile-actions">
        <button class="btn btn-primary" @click="$emit('edit')">编辑资料</button>
        <button class="btn">修改密码</button>
      </div>
    </div>
  </section>
</template>
