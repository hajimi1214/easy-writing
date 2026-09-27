<template>
  <section class="rail-form-panel" aria-label="写作规则">
    <div class="rail-form-body custom-scroll">
      <div v-if="!run" class="rail-form-empty">
        <i class="fa-regular fa-folder-open"></i>
        <strong>暂无可编辑的写作规则</strong>
        <span>工作流准备完成后，可在这里约束后续章节。</span>
      </div>

      <template v-else>
        <div v-if="saving || changedCount" class="rail-form-notice">
          <span>
            <i :class="saving ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-pen-to-square'"></i>
            {{ saving ? '正在保存并应用' : `${changedCount} 项修改待应用` }}
          </span>
          <button
            v-if="!saving"
            type="button"
            class="ink-btn ink-btn-ghost ink-btn-sm rail-form-icon-button"
            aria-label="放弃全部修改"
            @click="discard"
          >
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <section class="rail-form-section">
          <div class="rail-form-section-title">
            <strong>写作规则</strong>
            <span>你的硬性要求，优先级高于系统写作建议；输出格式与内容安全底线除外。</span>
          </div>
          <div class="rail-textarea-wrap">
            <textarea
              v-model="draft.writingRules"
              class="ink-input rail-textarea rules-textarea"
              rows="6"
              :maxlength="WRITING_RULES_MAX_LEN"
              placeholder="每行一条硬性要求，例如：&#10;主角不许无脑善良，先自保再救人&#10;每章至少一场正面冲突&#10;不许出现现代网络流行语"
              :disabled="formDisabled"
            ></textarea>
            <span class="rail-textarea-count">{{ draft.writingRules.length }} / {{ WRITING_RULES_MAX_LEN }}</span>
          </div>
        </section>

        <section class="rail-form-section">
          <div class="rail-form-section-title">
            <strong>文风与叙事</strong>
            <span>语言气质与叙事框架，与写作规则一起参与后续章节生成。</span>
          </div>

          <el-form :model="draft" label-position="top" class="rail-form-grid">
            <el-form-item label="文风要求">
              <div class="rail-textarea-wrap">
                <textarea
                  v-model="draft.writingStyle"
                  class="ink-input rail-textarea"
                  rows="3"
                  :maxlength="WRITING_STYLE_MAX_LEN"
                  placeholder="语言节奏、描写密度、对白和表达偏好"
                  :disabled="formDisabled"
                ></textarea>
                <span class="rail-textarea-count">{{ draft.writingStyle.length }} / {{ WRITING_STYLE_MAX_LEN }}</span>
              </div>
            </el-form-item>
          </el-form>

          <div v-if="resourcesLoading" class="rail-resource-state">
            <i class="fa-solid fa-spinner fa-spin"></i>
            正在加载可选项
          </div>
          <div v-else-if="resourcesError" class="rail-resource-state is-error">
            <span>
              <i class="fa-solid fa-circle-exclamation"></i>
              {{ resourcesError }}
            </span>
            <button
              type="button"
              class="ink-btn ink-btn-ghost ink-btn-sm"
              :disabled="saving"
              @click="loadResources"
            >
              重新加载
            </button>
          </div>

          <el-form
            :model="draft"
            label-position="left"
            label-width="68px"
            class="rail-form-grid rail-form-inline"
          >
            <el-form-item label="叙事风格">
              <el-select
                v-model="draft.narrativeStyle"
                class="ink-select"
                popper-class="ink-select-popper"
                placeholder="选择或输入叙事风格"
                filterable
                allow-create
                default-first-option
                clearable
                fit-input-width
                :disabled="formDisabled"
              >
                <el-option v-for="style in narrativeStyleOptions" :key="style" :label="style" :value="style" />
              </el-select>
            </el-form-item>

            <el-form-item label="叙事视角">
              <el-select
                v-model="draft.storyPerspective"
                class="ink-select"
                popper-class="ink-select-popper"
                placeholder="请选择叙事视角"
                clearable
                fit-input-width
                :loading="resourcesLoading"
                :disabled="resourceFieldDisabled"
              >
                <el-option
                  v-for="perspective in storyPerspectiveOptions"
                  :key="perspective"
                  :label="perspective"
                  :value="perspective"
                />
              </el-select>
            </el-form-item>
          </el-form>
        </section>

        <section class="rail-form-section">
          <div class="rail-form-section-title">
            <strong>AI 自检与改稿</strong>
            <span>规则轨（闸一）与事实账本（闸二）始终开启，这里单独管 AI 评审（闸三）怎么跑。</span>
          </div>

          <el-form label-position="left" label-width="68px" class="rail-form-grid rail-form-inline">
            <el-form-item label="评审档位">
              <el-select
                v-model="draft.selfCheckMode"
                class="ink-select"
                popper-class="ink-select-popper"
                placeholder="选择评审档位"
                fit-input-width
                :disabled="formDisabled"
              >
                <el-option
                  v-for="option in GATE_THIRD_MODE_OPTIONS"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </el-form-item>
          </el-form>

          <p class="rail-self-check-hint">{{ selfCheckHint }}</p>
          <p v-if="manualRuleHint" class="rail-self-check-hint">{{ manualRuleHint }}</p>
        </section>
      </template>
    </div>

    <footer class="rail-form-footer">
      <p class="rail-form-footer-hint">保存后自下一章生效，正在生成的章节不受影响。</p>
      <div class="rail-form-footer-actions">
        <button
          type="button"
          class="ink-btn ink-btn-outline"
          :disabled="formDisabled || !changedCount"
          @click="discard"
        >
          放弃修改
        </button>
        <button
          type="button"
          class="ink-btn ink-btn-primary"
          :disabled="saving || !run || !changedCount"
          @click="applyChanges"
        >
          <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
          {{ saving ? '正在保存' : '保存并应用' }}
        </button>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, toRef } from 'vue'
import type { WorkflowRun, WorkflowRuntimeSettings } from '@/types/workflow'
import { GATE_THIRD_MODE_OPTIONS, resolveGateThirdMode } from '@/utils/self-check-mode'
import { qualityRulesMeta } from '@/utils/quality-rules'
import type { WorkflowRuntimeConfigUpdate } from './rail'
import {
  createRunConfigReader,
  useRuntimeDraft,
  useWorkflowResources,
} from './runtime-settings'

/** 写作规则长度上限（与服务端约定） */
const WRITING_RULES_MAX_LEN = 1000
const WRITING_STYLE_MAX_LEN = 1500

interface RulesDraft extends Record<string, string> {
  writingRules: string
  writingStyle: string
  narrativeStyle: string
  storyPerspective: string
  selfCheckMode: string
}

const props = withDefaults(defineProps<{
  run: WorkflowRun | null
  saving?: boolean
}>(), {
  saving: false,
})

const emit = defineEmits<{
  (event: 'apply', payload: WorkflowRuntimeConfigUpdate): void
}>()

const presetNarrativeStyleOptions = [
  '顺叙推进',
  '双线交织',
  '多线群像',
  '倒叙悬念',
  '单元剧结构',
]

const buildDraft = (run: WorkflowRun | null): RulesDraft => {
  const reader = createRunConfigReader(run)
  if (!reader) {
    return {
      writingRules: '',
      writingStyle: '',
      narrativeStyle: '',
      storyPerspective: '',
      selfCheckMode: resolveGateThirdMode(null),
    }
  }
  return {
    writingRules: reader.readConfigText('writingRules'),
    writingStyle: reader.readConfigText('writingStyle'),
    narrativeStyle: reader.readConfigText('narrativeStyle', reader.tags.join('、')),
    storyPerspective: reader.readConfigText('storyPerspective'),
    // 走与引擎同一份判定函数：旧数据只有 criticEnabled / autoFix 也能显示出真实档位
    selfCheckMode: resolveGateThirdMode(reader.rawConfig),
  }
}

const runRef = toRef(props, 'run')
const { draft, changedCount, discard, markSubmitted, buildPatch } = useRuntimeDraft(runRef, buildDraft)

const {
  resources,
  loading: resourcesLoading,
  error: resourcesError,
  load: loadResources,
} = useWorkflowResources()

const formDisabled = computed(() => !props.run || props.saving)
const resourceFieldDisabled = computed(() =>
  formDisabled.value || resourcesLoading.value || Boolean(resourcesError.value)
)
const narrativeStyleOptions = computed(() =>
  [...new Set([...(resources.value?.tags || []), ...presetNarrativeStyleOptions])]
)
const storyPerspectiveOptions = computed(() =>
  resources.value?.selectFields.find(field => field.key === 'storyPerspective')?.options || []
)

/** 档位说明要写清代价：三档的差别就是「多花一次调用」和「改不改正文」，得让人一眼看懂 */
const selfCheckHint = computed(() => {
  if (draft.selfCheckMode === 'fix') {
    return '评审出的问题会自动改写正文：首次先试跑一次给你看改动，之后每章自动改（改前存快照，字数漂移过大就放弃）。'
  }
  if (draft.selfCheckMode === 'off') {
    return '完全不跑 AI 评审，最省额度；闸一规则轨与闸二事实账本照常运行。'
  }
  return '每章多一次评审调用，只把问题清单挑出来交给你判断，绝不改动正文。'
})

/**
 * 闸一的《流白》AI 味手册包是内置的、不可关的（作者要求每次生成都按它来），
 * 这里只把「已经装了什么、有多少条」摊开给作者看，省得怀疑规则没生效。
 */
const manualRuleHint = computed(() => {
  const words = qualityRulesMeta.liubaiWordCount ?? 0
  const sentences = qualityRulesMeta.liubaiSentenceCount ?? 0
  if (!words && !sentences) return ''
  return `闸一已内置《流白》AI 味手册：硬禁词 ${words} 个、硬禁模板句 ${sentences} 条。生成前注入约束，生成后逐条核对，命中按 P1 列出并给出手册的替换改法。`
})

const applyChanges = () => {
  if (!props.run || props.saving || !changedCount.value) return
  const next: RulesDraft = {
    writingRules: draft.writingRules.trim().slice(0, WRITING_RULES_MAX_LEN),
    writingStyle: draft.writingStyle.trim().slice(0, WRITING_STYLE_MAX_LEN),
    narrativeStyle: draft.narrativeStyle.trim(),
    storyPerspective: draft.storyPerspective.trim(),
    // 过一遍判定函数：脏值不会写进配置
    selfCheckMode: resolveGateThirdMode({ selfCheckMode: draft.selfCheckMode }),
  }
  // 补丁语义：只提交真实变化字段，避免覆盖其他面板的待生效配置
  const config = buildPatch(next) as Partial<WorkflowRuntimeSettings>
  markSubmitted(next)
  emit('apply', { config, effectiveScope: 'next_chapter' })
}

onMounted(loadResources)
</script>

<style scoped lang="scss">
@use './rail-form';

.rules-textarea {
  min-height: 128px;
}

/* 档位说明随选择切换，紧贴表单项读起来才是同一段 */
.rail-self-check-hint {
  margin: 0;
  color: var(--ink-sec);
  font-size: 11px;
  line-height: 1.62;
}
</style>
