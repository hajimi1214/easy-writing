<template>
  <div class="workflow-base-step">
    <section class="design-panel base-config-panel writing-parameters-panel">
      <h2>写作参数</h2>

      <div class="base-select-grid writing-parameter-grid">
        <label
          v-for="field in writingSelectFields"
          :key="field.key"
          class="base-select-control"
        >
          <span>{{ field.label }}</span>
          <el-select
            :model-value="baseConfig[field.key]"
            class="ink-select workflow-config-select"
            popper-class="ink-select-popper"
            fit-input-width
            @change="updateSelectField(field.key, String($event))"
          >
            <el-option
              v-for="option in field.options"
              :key="option"
              :label="option"
              :value="option"
            />
          </el-select>
        </label>
      </div>

      <label class="writing-focus-control">
        <span class="writing-focus-heading">
          <strong>创作重点补充</strong>
          <em>
            <i class="fa-solid fa-circle-check"></i>
            已自动带入第一步灵感，可继续修改
          </em>
        </span>
        <textarea
          :value="baseConfig.sellingPoint"
          maxlength="1000"
          rows="6"
          placeholder="补充你希望大纲重点强化的冲突、节奏、人物关系或创作边界"
          @input="updateBaseConfig({ sellingPoint: ($event.target as HTMLTextAreaElement).value })"
        ></textarea>
      </label>

      <p class="writing-parameter-hint">这些参数将用于控制大纲规模与后续正文生成。</p>
    </section>

    <aside class="workflow-base-side">
      <section class="design-panel creative-direction-summary">
        <div class="design-panel__title between">
          <span class="template-title-left">
            <i class="fa-solid fa-bullseye"></i>
            本次创作方向
          </span>
          <button type="button" @click="$emit('back-direction')">
            <i class="fa-solid fa-rotate-left"></i>
            返回修改
          </button>
        </div>
        <dl>
          <div>
            <dt>发布平台</dt>
            <dd>{{ baseConfig.platform || '未选择' }}</dd>
          </div>
          <div>
            <dt>目标读者</dt>
            <dd>{{ baseConfig.audience || '未选择' }}</dd>
          </div>
          <div>
            <dt>小说类型</dt>
            <dd>{{ baseConfig.platformCategory || baseConfig.genre || '未选择' }}</dd>
          </div>
          <div>
            <dt>风格标签</dt>
            <dd>{{ baseConfig.tags.join(' / ') || '未设置' }}</dd>
          </div>
          <div>
            <dt>本次模型</dt>
            <dd>{{ workflowModelDisplayName }}</dd>
          </div>
        </dl>
      </section>

    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { WorkflowBaseConfig, WorkflowDraft } from '../types'
import type {
  WorkflowResources,
  WorkflowSelectFieldResource,
} from '@/types/workflow'
import { useAiModelStore } from '@/stores/ai-model'

const props = withDefaults(defineProps<{
  draft: WorkflowDraft
  resources?: WorkflowResources | null
}>(), {
  resources: null,
})

const emit = defineEmits<{
  (event: 'patch', payload: Partial<WorkflowDraft>): void
  (event: 'back-direction'): void
}>()

type WritingSelectFieldKey = 'targetWords' | 'chapterTargetWords' | 'protagonist' | 'storyPerspective' | 'volumeRelay'

const aiModelStore = useAiModelStore()
const baseConfig = computed(() => props.draft.baseConfig)
const workflowModelDisplayName = computed(() => {
  const group = aiModelStore.groups.workflow_book
  const models = group?.models || []
  const explicitCode = String(baseConfig.value.modelCode || '').trim()
  const resolvedModel = explicitCode
    ? models.find(item => item.code === explicitCode)
    : group?.selectedModel || group?.defaultModel

  if (resolvedModel) {
    return resolvedModel.name || resolvedModel.modelCode || resolvedModel.code
  }
  if (explicitCode) return explicitCode
  return aiModelStore.loading.workflow_book ? '模型名称加载中…' : '未配置可用模型'
})
const writingSelectFields = computed(() =>
  (props.resources?.selectFields || []).filter(
    field => field.key !== 'audience'
  ) as Array<WorkflowSelectFieldResource & { key: WritingSelectFieldKey }>
)
// 写作参数继续使用既有 baseConfig 契约，不新增草稿字段或接口映射。
const updateBaseConfig = (payload: Partial<WorkflowBaseConfig>) => {
  emit('patch', {
    baseConfig: {
      ...props.draft.baseConfig,
      ...payload,
    },
  })
}

const updateSelectField = (key: WritingSelectFieldKey, value: string) => {
  updateBaseConfig({ [key]: value })
}
</script>
