<template>
  <div class="workflow-book-page" :class="{ 'workflow-book-page--restoring': restoredRun }">
    <!-- 恢复提示条与「历史记录」同处顶部动作区：提示条出现时整行回到文档流，
         否则绝对定位的「历史记录」会盖住提示条右侧的按钮。 -->
    <div class="workflow-book-top-actions">
      <div v-if="restoredRun" class="workflow-restore-bar">
        <i class="fa-solid fa-clock-rotate-left"></i>
        <p>
          已恢复上次未完成的《{{ restoredRun.title }}》 ·
          当前进度：{{ currentStepMeta.title }}
        </p>
        <button type="button" :disabled="busy" @click="startNewWorkflow">新建工作流</button>
        <button
          class="workflow-restore-bar__close"
          type="button"
          aria-label="关闭提示"
          @click="restoredRun = null"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <button class="workflow-history-link" type="button" @click="openWorkflowHistory">
        <i class="fa-regular fa-clock"></i>
        历史记录
      </button>
    </div>

    <WorkflowShell :current-step="draft.currentStep" @step-click="goStep">
      <WorkflowStepErrorNotice
        v-if="currentStepError"
        :notice="currentStepError"
        :generating="busy"
        @dismiss="stepError = null"
        @retry="retryStepError"
      />
      <WorkflowModeStep
        v-if="draft.currentStep === 'MODE_SELECT'"
        :draft="draft"
        :resources="workflowResources"
        :generating="inspirationGenerating"
        :idea-preview="pendingIdeaPreview"
        :preview-applying="previewApplying"
        @patch="patchDraft"
        @generate-inspiration="generateInspiration"
        @apply-preview="applyIdeaPreview"
        @close-preview="closeIdeaPreview"
      />
      <WorkflowBaseConfigStep
        v-else-if="draft.currentStep === 'BASE_CONFIG'"
        :draft="draft"
        :resources="workflowResources"
        @patch="patchDraft"
        @back-direction="goStep('MODE_SELECT')"
      />
      <WorkflowOutlineStep
        v-else-if="draft.currentStep === 'OUTLINE_GENERATE'"
        :draft="draft"
        :readonly="outlineAdjustPhase === 'generating'"
        :busy="busy || outlineAdjustVisible"
        :updated-keys="outlineUpdatedKeys"
        @patch="patchDraft"
        @regenerate="confirmDirectRegenerate"
        @adjust="openOutlineAdjust"
      />
      <WorkflowSettingStep
        v-else-if="draft.currentStep === 'SETTING_GENERATE'"
        :draft="draft"
        :stale="settingStale"
        @patch="patchDraft"
        @regenerate="regenerateSetting"
        @adjust="openSettingAdjust"
        @adjust-item="openSettingAdjustForItem"
      />
    </WorkflowShell>

    <WorkflowSettingAdjustDrawer
      ref="settingAdjustDrawerRef"
      :visible="settingAdjustVisible"
      :phase="settingAdjustPhase"
      :characters="settingAdjustCharacters"
      :storylines="settingAdjustStorylines"
      :model-name="workflowModelDisplayName"
      :percent="settingAdjustPercent"
      :stages="settingAdjustStages"
      :candidate="settingAdjustCandidate"
      :error-message="settingAdjustError"
      @close="settingAdjustVisible = false"
      @generate="startSettingAdjust"
      @stop="stopSettingAdjust"
      @discard="discardSettingCandidate"
      @regenerate="regenerateSettingCandidate"
      @apply="applySettingCandidate"
    />

    <WorkflowOutlineAdjustDrawer
      ref="outlineAdjustDrawerRef"
      :visible="outlineAdjustVisible"
      :phase="outlineAdjustPhase"
      :model-name="workflowModelDisplayName"
      :percent="outlineAdjustPercent"
      :stages="outlineAdjustStages"
      :candidate="outlineAdjustCandidate"
      :error-message="outlineAdjustError"
      @close="closeOutlineAdjust"
      @generate="startOutlineAdjust"
      @stop="stopOutlineAdjust"
      @discard="discardOutlineCandidate"
      @regenerate="regenerateOutlineCandidate"
      @apply="applyOutlineCandidate"
    />

    <footer class="workflow-book-footer">
      <button class="ghost-action" type="button" :disabled="busy" @click="saveDraft">
        <i :class="saving ? 'fa-solid fa-spinner fa-spin' : 'fa-regular fa-floppy-disk'"></i>
        {{ saving ? '保存中…' : '保存当前进度' }}
      </button>
      <button
        v-if="!isFirstStep"
        class="ghost-action"
        type="button"
        :disabled="busy"
        @click="prevStep"
      >
        <i class="fa-solid fa-arrow-left"></i>
        上一步：{{ prevStepTitle }}
      </button>
      <button
        v-if="cancelableGenerating || inspirationGenerating"
        class="ghost-action ghost-action--danger"
        type="button"
        @click="cancelGeneration"
      >
        <i class="fa-solid fa-xmark"></i>
        取消生成
      </button>
      <button class="primary-action" type="button" :disabled="busy" @click="handlePrimary">
        <i v-if="submitting" class="fa-solid fa-spinner fa-spin"></i>
        {{ submitting ? primaryLoadingText : nextButtonText }}
        <i v-if="!submitting" class="fa-solid fa-angle-right"></i>
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import type { JsonRecord } from '@/types/json'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import WorkflowShell from './components/WorkflowShell.vue'
import WorkflowBaseConfigStep from './components/WorkflowBaseConfigStep.vue'
import WorkflowModeStep from './components/WorkflowModeStep.vue'
import WorkflowOutlineAdjustDrawer from './components/WorkflowOutlineAdjustDrawer.vue'
import WorkflowOutlineStep from './components/WorkflowOutlineStep.vue'
import WorkflowSettingAdjustDrawer from './components/WorkflowSettingAdjustDrawer.vue'
import WorkflowSettingStep from './components/WorkflowSettingStep.vue'
import WorkflowStepErrorNotice from './components/WorkflowStepErrorNotice.vue'
import {
  applyWorkflowCreationDefaultsToNewDraft,
  applyWorkflowRunToDraft,
  buildWorkflowSavePayload,
  createInitialWorkflowDraft,
  normalizeOutlineResult,
  dropUntouchedSettingEntries,
  normalizeSettingResult,
  resolveWorkflowTitle,
  WORKFLOW_CREATION_DEFAULT_KEYS,
  type WorkflowCreationDefaultKey,
} from './workflow-adapter'
import type {
  WorkflowDraft,
  WorkflowOutlineAdjustCandidate,
  WorkflowAdjustPhase,
  WorkflowOutlineAdjustRequest,
  WorkflowSettingAdjustCandidate,
  WorkflowSettingAdjustRequest,
  WorkflowAdjustStage,
  WorkflowStepCode,
} from './types'
import { clearActiveRunId, getActiveRunId, setActiveRunId } from './active-run-store'
// 开源版：向导四步与"按要求调整"全部走本地 run 存储 + 本地引擎后台生成；
// "进入自动生文"起真实的逐章生成任务（local-workflow-control）
import type {
  WorkflowResources,
  WorkflowGenerateBookConflict,
  WorkflowRun,
  WorkflowStepGenerateStep,
  WorkflowStepTask,
} from '@/types/workflow'
import {
  createLocalWorkflow as createWorkflowApi,
  saveLocalWorkflow as saveWorkflowApi,
  getLocalWorkflowInfo as getWorkflowInfoApi,
  getLocalActiveStepTask as getWorkflowActiveStepTaskApi,
  getLocalWorkflowTaskStatus as getWorkflowTaskStatusApi,
  getLocalWorkflowResources as getWorkflowResourcesApi,
  applyLocalWorkflowOutlineAdjust as applyWorkflowOutlineAdjustApi,
  discardLocalWorkflowOutlineAdjust as discardWorkflowOutlineAdjustApi,
  applyLocalWorkflowSettingAdjust as applyWorkflowSettingAdjustApi,
  discardLocalWorkflowSettingAdjust as discardWorkflowSettingAdjustApi,
} from '@/storage/local-workflow'
import {
  cancelLocalWorkflowTask as cancelWorkflowTaskApi,
  generateLocalWorkflowBook as generateWorkflowBookApi,
} from '@/utils/local-workflow-control'
import { submitLocalWorkflowStepTask as submitWorkflowStepTaskApi } from '@/utils/local-workflow-engine'
import { extractApiErrorMessage, isCanceledRequest } from '@/utils/api-error'
import { useAiModelStore } from '@/stores/ai-model'
import './style.scss'

const router = useRouter()
const route = useRoute()
const aiModelStore = useAiModelStore()
// 开源版本地单用户：活动工作流缓存统一挂在 0 号桶下
const currentUserId = computed(() => 0)
const draft = reactive<WorkflowDraft>(createInitialWorkflowDraft())
// 无感恢复上次未完成流程时给出的提示（从历史「继续编辑」进入不提示：用户已明确知情）
const restoredRun = ref<{ title: string } | null>(null)
const loading = ref(false)
const saving = ref(false)
const submitting = ref(false)
// —— 步骤生成后台任务（灵感/大纲/设定）——
// 提交即返回任务，服务端执行，客户端只负责轮询展示：切页面/关窗生成都不中断，
// 回到页面自动恢复；取消走服务端任务取消（在子步骤边界生效）。
const cancelableGenerating = ref(false)
const activeStepTaskId = ref(0)
let stepTaskTimer: ReturnType<typeof setTimeout> | null = null
let stepPollController: AbortController | null = null
const clearStepTaskTimer = () => {
  if (stepTaskTimer) {
    clearTimeout(stepTaskTimer)
    stepTaskTimer = null
  }
}
const stopStepPolling = () => {
  clearStepTaskTimer()
  stepPollController?.abort()
  stepPollController = null
}
/** 请求层/生成链路抛上来的错误：axios 字段 + 业务附加字段全部可缺，读取端只做防御性取值 */
interface WorkflowFlowError {
  message?: string
  msg?: string
  code?: number | string
  statusCode?: number | string
  errorCode?: string
  stepCancelled?: boolean
  draftConflictHandled?: boolean
  workflowTask?: JsonRecord | null
  data?: JsonRecord | null
  response?: { status?: number; data?: JsonRecord | null } | null
}
const isStepCancelledError = (error: WorkflowFlowError | null) => Boolean(error?.stepCancelled)
const isDraftConflictHandled = (error: WorkflowFlowError | null) => Boolean(error?.draftConflictHandled)
interface WorkflowStepErrorNoticeState {
  step: 'inspiration' | 'outline' | 'setting'
  visibleStepCode: WorkflowStepCode
  title: string
  modelName: string
  message: string
  errorCode: string
  errorReference: string
  request?: { action: string; directions: string[]; ideaText: string }
}
const stepError = ref<WorkflowStepErrorNoticeState | null>(null)
const currentStepError = computed(() =>
  stepError.value?.visibleStepCode === draft.currentStep ? stepError.value : null
)

// 轮询任务到终态；组件卸载只停轮询，任务在服务端继续
const waitStepTask = (
  taskId: number,
  requestedStep: WorkflowStepGenerateStep,
  onProgress?: (task: WorkflowStepTask) => void
) =>
  new Promise<WorkflowStepTask>((resolve, reject) => {
    stopStepPolling()
    const controller = new AbortController()
    stepPollController = controller
    const poll = async () => {
      try {
        const { data } = await getWorkflowTaskStatusApi(taskId, {
          signal: controller.signal,
        })
        if (data.payload?.step !== requestedStep) {
          return reject(new Error('生成任务步骤与当前页面不一致，已拒绝消费该结果'))
        }
        onProgress?.(data as unknown as WorkflowStepTask)
        const status = String((data as JsonRecord)?.status || '')
        if (status === 'succeeded') return resolve(data as unknown as WorkflowStepTask)
        if (status === 'canceled') {
          return reject(Object.assign(new Error('已取消本次生成'), { stepCancelled: true }))
        }
        if (status === 'failed' || status === 'interrupted') {
          return reject(Object.assign(
            new Error(String((data as JsonRecord)?.errorMessage || '生成失败，请重试')),
            { workflowTask: data }
          ))
        }
        stepTaskTimer = setTimeout(() => void poll(), 2500)
      } catch (error) {
        if (isCanceledRequest(error)) return reject(error)
        const status = Number(error?.response?.status || error?.statusCode || 0)
        const retryable = !status || status >= 500 || [408, 429].includes(status)
        if (!retryable) {
          return reject(new Error(extractApiErrorMessage(error, '无法读取生成状态，请重新进入本页')))
        }
        // 短暂网络或服务异常不代表后台任务失败，放慢轮询后继续读取真实终态。
        stepTaskTimer = setTimeout(() => void poll(), 4000)
      }
    }
    void poll()
  })

// 提交步骤任务并等待结果（{artifact, content}），状态展示由调用方控制
const runStepTask = async (
  step: 'inspiration' | 'outline' | 'setting',
  input: JsonRecord,
  saveOverride: Partial<WorkflowDraft> = {}
) => {
  const savedRun = await persistDraft(saveOverride)
  const submitAtRevision = async (run: WorkflowRun) => {
    const { data } = await submitWorkflowStepTaskApi({
      runId: run.id,
      step,
      expectedDraftRevision: run.draftRevision,
      ...(step === 'setting'
        ? { expectedOutlineRevision: run.outlineRevision }
        : {}),
      input,
    })
    return data
  }
  const overwriteLocalAndSubmit = async (expectedDraftRevision: number): Promise<WorkflowStepTask> => {
    try {
      // 提交任务前若又发生冲突，用户确认后先重建唯一草稿真源再提交。
      const { data: overwritten } = await saveWorkflowApi(buildWorkflowSavePayload(draft, {
        ...saveOverride,
        id: savedRun.id,
        draftRevision: expectedDraftRevision,
      } as Partial<WorkflowDraft>))
      syncDraftRevisions(overwritten)
      return await submitAtRevision(overwritten)
    } catch (error) {
      return await resolveDraftConflict(error, overwriteLocalAndSubmit)
    }
  }
  let task: WorkflowStepTask
  try {
    task = await submitAtRevision(savedRun)
  } catch (error) {
    task = await resolveDraftConflict(error, overwriteLocalAndSubmit)
  }
  if (task.payload?.step !== step) {
    throw new Error('服务端返回了错误的生成步骤，已停止处理')
  }
  activeStepTaskId.value = Number(task.id)
  try {
    const done = await waitStepTask(Number(task.id), step)
    const result = done?.payload?.result
    if (!result?.content) throw new Error('生成结果为空，请重试')
    hasAiArtifact.value = true
    // 产物落库会推进服务端版本，客户端必须先接管新版本再继续保存。
    draft.draftRevision = Number(result.draftRevision || draft.draftRevision)
    draft.outlineRevision = Number(result.outlineRevision || draft.outlineRevision)
    return result
  } finally {
    activeStepTaskId.value = 0
    stopStepPolling()
  }
}
const inspirationGenerating = ref(false)
const previewApplying = ref(false)
const workflowResources = ref<WorkflowResources | null>(null)
// 资源请求返回前，用户明确碰过的创建默认字段必须保留；不能只用“值是否等于旧默认”
// 来猜测，否则用户改后又改回旧值时仍可能被后台默认值覆盖。
const creationDefaultTouchedFields = new Set<WorkflowCreationDefaultKey>()
const pendingIdeaPreview = ref<{ text: string; action: string } | null>(null)
const hasAiArtifact = ref(false)
const hasGeneratedContent = computed(() =>
  hasAiArtifact.value ||
  Boolean(draft.bookId) ||
  Boolean(pendingIdeaPreview.value) ||
  draft.outlineResult.chapters.length > 0 ||
  draft.settingResult.characters.length > 0
)
const currentPlatformRankCategories = computed(() => {
  const platformCode = workflowResources.value?.platforms.find(
    item => item.name === draft.baseConfig.platform
  )?.code
  const categories = platformCode
    ? workflowResources.value?.platformCategories?.[platformCode] || []
    : []
  const audience = String(draft.baseConfig.audience || '')
  const gender = audience.includes('女')
    ? 'female'
    : audience.includes('男')
    ? 'male'
    : ''
  return gender ? categories.filter(item => item.gender === gender) : categories
})

const stepMetas = [
  { code: 'MODE_SELECT' as WorkflowStepCode, title: '创作方向与灵感', button: '下一步：写作参数' },
  { code: 'BASE_CONFIG' as WorkflowStepCode, title: '写作参数', button: '下一步：生成大纲' },
  { code: 'OUTLINE_GENERATE' as WorkflowStepCode, title: '生成大纲', button: '下一步：生成设定' },
  { code: 'SETTING_GENERATE' as WorkflowStepCode, title: '生成设定', button: '进入自动生文' },
]

const currentIndex = computed(() => {
  const index = stepMetas.findIndex(item => item.code === draft.currentStep)
  return Math.max(0, index)
})
const currentStepMeta = computed(() => stepMetas[currentIndex.value])
const isFirstStep = computed(() => currentIndex.value === 0)
const prevStepTitle = computed(() => stepMetas[currentIndex.value - 1]?.title || '创作方向与灵感')
const nextButtonText = computed(() => currentStepMeta.value.button)
const isLastStep = computed(() => currentIndex.value === stepMetas.length - 1)
const busy = computed(() =>
  loading.value ||
  saving.value ||
  submitting.value ||
  inspirationGenerating.value ||
  previewApplying.value
)

// 主按钮在请求进行中显示对应阶段的加载文案，避免用户无法感知是否在生成。
const primaryLoadingText = computed(() => {
  if (isLastStep.value) return '正在进入自动生文…'
  if (draft.currentStep === 'BASE_CONFIG') return '正在生成大纲…'
  if (draft.currentStep === 'OUTLINE_GENERATE') return '正在生成设定…'
  return '处理中…'
})

const markCreationDefaultFieldsTouched = (payload: Partial<WorkflowDraft>) => {
  if (
    payload.baseConfig &&
    Number(draft.id || 0) === 0 &&
    Number(draft.bookId || 0) === 0 &&
    Number(draft.draftRevision || 0) === 0
  ) {
    WORKFLOW_CREATION_DEFAULT_KEYS.forEach(key => {
      if (payload.baseConfig?.[key] !== draft.baseConfig[key]) {
        creationDefaultTouchedFields.add(key)
      }
    })
  }
}

const patchDraft = (payload: Partial<WorkflowDraft>) => {
  if (stepError.value?.visibleStepCode === draft.currentStep) stepError.value = null
  if (payload.ideaText !== undefined) {
    syncAutoSellingPoint(payload.ideaText)
    pendingIdeaPreview.value = null
    if (stepError.value?.step === 'inspiration') stepError.value = null
  }
  const nextModelCode = payload.baseConfig?.modelCode
  // 已建书后更换模型：卷间可切，但要先确认文风一致性风险。
  if (
    nextModelCode !== undefined &&
    hasGeneratedContent.value &&
    nextModelCode !== draft.baseConfig.modelCode
  ) {
    void confirmModelSwitch(payload)
    return
  }
  markCreationDefaultFieldsTouched(payload)
  Object.assign(draft, payload)
}

const confirmModelSwitch = async (payload: Partial<WorkflowDraft>) => {
  try {
    await inkConfirm(
      '后续内容可能在文风、节奏、人物语气和细节密度上发生变化。已生成内容不会被修改；正在执行的任务继续使用原模型，新模型从下一次生成或下一章生效。',
      '更换模型',
      {
        confirmButtonText: '更换',
        cancelButtonText: '保持当前模型',
        type: 'warning',
      }
    )
    markCreationDefaultFieldsTouched(payload)
    Object.assign(draft, payload)
    stepError.value = null
  } catch {
    // 用户取消，保持原模型
  }
}

const patchBaseConfig = (payload: Partial<WorkflowDraft['baseConfig']>) => {
  draft.baseConfig = {
    ...draft.baseConfig,
    ...payload,
  }
}

// 创作重点尚未被用户改写时跟随灵感；一旦用户形成独立重点就不再自动覆盖。
const syncAutoSellingPoint = (nextIdeaText: string) => {
  const previousIdeaText = String(draft.ideaText || '').trim()
  const currentSellingPoint = String(draft.baseConfig.sellingPoint || '').trim()
  if (currentSellingPoint && currentSellingPoint !== previousIdeaText) return
  patchBaseConfig({ sellingPoint: String(nextIdeaText || '').trim() })
}

const creativeDirectionWarning = computed(() => {
  if (!String(draft.baseConfig.platform || '').trim()) return '请先选择发布平台'
  if (!String(draft.baseConfig.audience || '').trim()) return '请先选择目标读者'
  if (!String(draft.baseConfig.genre || '').trim()) return '请先选择小说类型'
  if (
    currentPlatformRankCategories.value.length > 0 &&
    !String(draft.baseConfig.platformCategory || '').trim()
  ) {
    return '请先选择小说类型，或填写自定义类型'
  }
  return ''
})

const validateCreativeDirection = () => {
  if (!creativeDirectionWarning.value) return true
  showWorkflowWarning(creativeDirectionWarning.value)
  return false
}

const goStep = (stepCode: WorkflowStepCode) => {
  // 生成期间不允许跳回前面步骤：那里改动的配置不会进入本次生成，
  // 却会在生成结束后随草稿一起落库，造成"参数与产物对不上"。
  if (busy.value) {
    showWorkflowWarning('正在生成中，请等待本次生成结束或先停止生成')
    return
  }
  const exists = stepMetas.some(item => item.code === stepCode)
  if (exists && stepMetas.findIndex(item => item.code === stepCode) > 0) {
    if (!validateCreativeDirection()) return
    if (!draft.ideaText.trim()) {
      showWorkflowWarning('请先输入或选择一个故事灵感')
      return
    }
    syncAutoSellingPoint(draft.ideaText)
  }
  if (exists) {
    draft.currentStep = stepCode
  }
}

const buildWorkflowErrorMessage = (error: WorkflowFlowError, stepCode: WorkflowStepCode) => {
  const fallback: Record<WorkflowStepCode, string> = {
    MODE_SELECT: '灵感生成失败，请查看原因后重新生成。',
    BASE_CONFIG: '大纲生成失败，请查看原因后重新生成。',
    MODEL_SELECT: '模型设置失败，请重新选择。',
    AGENT_SELECT: '智能体设置失败，请重新选择。',
    OUTLINE_GENERATE: '设定生成失败，请查看原因后重新生成。',
    SETTING_GENERATE: '工作流执行失败，请稍后重试。',
  }
  const message = extractApiErrorMessage(error, fallback[stepCode])
  const errorCode = String(error?.workflowTask?.errorCode || error?.errorCode || '')
  const advice: Record<string, string> = {
    RATE_LIMITED: '请稍等片刻后重试。',
    TIMEOUT: '网络或模型响应超时，可直接重新生成。',
    NETWORK_ERROR: '请检查本机网络后重试。',
    MODEL_UNAVAILABLE: '请重新选择一个可用模型。',
    MODEL_FORBIDDEN: '当前账号无权使用该模型，请重新选择。',
    CONTEXT_LIMIT: '当前输入超出模型上下文限制，请缩短内容或选择容量更大的模型。',
    OUTPUT_TRUNCATED: '模型输出被截断，本次不会使用该结果，请重新生成。',
    QUEUE_UNAVAILABLE: '生成队列暂不可用，请稍后重试。',
  }
  const hint = advice[errorCode]
  return hint && !message.includes(hint) ? `${message} ${hint}` : message
}

const showWorkflowError = (message: string) => {
  ElMessage.error(message)
}

/** 步骤失败只保存服务端结构化结果，切换页面时不重复弹历史 Toast。 */
const recordStepFailure = (
  error: WorkflowFlowError,
  step: 'inspiration' | 'outline' | 'setting',
  visibleStepCode: WorkflowStepCode,
  request?: { action: string; directions: string[]; ideaText: string },
) => {
  const task = error?.workflowTask as WorkflowStepTask | undefined
  const errorStepCode: WorkflowStepCode = step === 'inspiration'
    ? 'MODE_SELECT'
    : step === 'outline'
      ? 'BASE_CONFIG'
      : 'OUTLINE_GENERATE'
  const message = buildWorkflowErrorMessage(error, errorStepCode)
  const errorCode = String(task?.errorCode || error?.errorCode || 'UNKNOWN')
  stepError.value = {
    step,
    visibleStepCode,
    title: `${step === 'inspiration' ? '灵感' : step === 'outline' ? '大纲' : '设定'}生成未完成`,
    modelName: String(task?.modelName || task?.modelCode || '默认文字模型'),
    message,
    errorCode,
    // 本地任务 id 是负数，剥掉负号避免出现 "WF--" 观感
    errorReference: String(task?.errorReference || `WF-${String(task?.id || draft.id).replace(/^-/, '')}`),
    request,
  }
  showWorkflowError(message)
}

const showWorkflowWarning = (message: string) => {
  ElMessage.warning(message)
}

const isWorkflowBookConflict = (value: unknown): value is WorkflowGenerateBookConflict => (
  Boolean(value && typeof value === 'object' && (value as WorkflowGenerateBookConflict).conflict === true)
)

// 进入历史前先保存当前草稿，确保返回时数据不丢失，且路由带上 runId。
// 生成中（submitting）也放行：长耗时生成不该把用户锁死在本页，跳转不影响服务端生成。
const openWorkflowHistory = async () => {
  if (!submitting.value && hasPersistableDraft()) {
    saving.value = true
    try {
      await persistDraft()
    } catch (error) {
      // 保存失败不阻断跳转，历史页仍可查看其他记录。
    } finally {
      saving.value = false
    }
  }
  void router.push('/workflowBook/history')
}

const syncRouteRunId = async (runId: number) => {
  if (Number(route.query.id || 0) === runId) return
  await router.replace({ query: { ...route.query, id: String(runId) } })
}

const syncRouteAgentSelection = () => {
  const routeAgentId = String(route.query.agentId || '').trim()
  if (routeAgentId && routeAgentId !== draft.baseConfig.agentId) {
    patchBaseConfig({ agentId: routeAgentId })
  }
}

// 进入页面不再建 run：那会让每次点开工作流都在历史里留一条空记录。
// run 由首个实质动作懒创建（ensureWorkflowRun），入口优先级：
//   ?new=1 强制新建 > ?id= 指定（历史「继续编辑」）> localStorage 记住的进行中 run > 空白新建页
const loadWorkflow = async () => {
  loading.value = true
  try {
    if (String(route.query.new || '') === '1') {
      clearActiveRunId(currentUserId.value)
      const nextQuery = { ...route.query }
      delete nextQuery.new
      await router.replace({ path: route.path, query: nextQuery })
      return
    }
    const routeRunId = Number(route.query.id || 0)
    if (routeRunId) {
      await adoptRun(routeRunId)
      return
    }
    // 防呆：URL 明确要打开某个草稿、但参数解析不出有效 id 时，绝不能静默回退到
    // "上次的草稿"——那会打开另一本书且页面毫无异常，极难被发现（小易深链曾误传
    // draftId=xxx，用户点进来看到的是别的书）。这里如实报错，不猜用户想看哪本。
    const unknownDraftKey = Object.keys(route.query).find(key =>
      /^(draftid|runid|workflowid)$/i.test(key)
    )
    if (unknownDraftKey) {
      ElMessage.error('草稿链接参数无效，无法定位该草稿')
      console.warn(
        `[workflow] 未知的草稿参数 ${unknownDraftKey}=${route.query[unknownDraftKey]}，工作流页只接受 ?id=`
      )
      return
    }
    const cachedRunId = getActiveRunId(currentUserId.value)
    if (cachedRunId) await restoreCachedRun(cachedRunId)
  } catch (error) {
    // 请求被取消（组件卸载/路由切换）不算失败，不打扰用户
    if (isCanceledRequest(error)) return
    if (!error?.__handled) ElMessage.error(extractApiErrorMessage(error, '工作流加载失败'))
  } finally {
    loading.value = false
  }
}

const adoptRun = async (runId: number) => {
  const { data } = await getWorkflowInfoApi(runId)
  applyWorkflowRunToDraft(draft, data)
  hasAiArtifact.value = Boolean(data.artifacts?.length)
  syncWorkflowModelSelection()
  syncRouteAgentSelection()
  rememberActiveRun()
  await syncRouteRunId(draft.id)
}

// 只有「这条 run 确实用不了」（已删除 / 不属于当前账号）才忘掉它。
// 请求取消、网络抖动、超时或服务端 5xx 不该让用户永久丢失正在进行的流程——下次进来还能续上。
const isRunUnavailableError = (error: WorkflowFlowError) => {
  if (isCanceledRequest(error)) return false
  const status = Number(error?.statusCode || 0)
  if (status >= 500 || status === 401 || status === 403) return false
  if (status >= 400) return true
  // 无 HTTP 状态码时只认业务层错误（HTTP 200 + 数字业务码，如 1001「工作流不存在」）；
  // ERR_NETWORK / ECONNABORTED 等 axios 错误码说明请求没到业务层，一律不算。
  if (!/^\d+$/.test(String(error?.code ?? ''))) return false
  return /不存在|已删除|无权|不属于/.test(String(error?.msg || error?.message || ''))
}

// 恢复失败不打扰用户（getWorkflowInfoApi 已 silentError）：静默落到干净的新建页。
const restoreCachedRun = async (cachedRunId: number) => {
  try {
    const { data } = await getWorkflowInfoApi(cachedRunId)
    // 已建书：流程已移交写作页，不再作为「进行中的工作流」
    if (Number(data?.bookId || 0)) {
      clearActiveRunId(currentUserId.value)
      return
    }
    applyWorkflowRunToDraft(draft, data)
    hasAiArtifact.value = Boolean(data.artifacts?.length)
    syncWorkflowModelSelection()
    syncRouteAgentSelection()
    await syncRouteRunId(draft.id)
    restoredRun.value = { title: resolveWorkflowTitle(draft) }
  } catch (error) {
    if (isRunUnavailableError(error)) clearActiveRunId(currentUserId.value)
    creationDefaultTouchedFields.clear()
    Object.assign(
      draft,
      createInitialWorkflowDraft(workflowResources.value?.creationDefaults),
    )
  }
}

// run 已建书后流程移交写作页，不再作为「进行中的工作流」被恢复。
const rememberActiveRun = () => {
  if (draft.id && !draft.bookId) setActiveRunId(currentUserId.value, draft.id)
}

const startNewWorkflow = async () => {
  if (busy.value) return
  // 页面可能已经打开很久；新建前重新读取一次，确保采用管理员刚发布的最新默认值。
  // 请求失败时 loadWorkflowResources 会保留页面现有资源，仍可安全回退。
  await loadWorkflowResources({ applyToCurrentDraft: false })
  clearActiveRunId(currentUserId.value)
  creationDefaultTouchedFields.clear()
  Object.assign(
    draft,
    createInitialWorkflowDraft(workflowResources.value?.creationDefaults),
  )
  restoredRun.value = null
  pendingIdeaPreview.value = null
  await router.replace({ path: '/workflowBook', query: {} })
}

const loadWorkflowResources = async (
  options: { applyToCurrentDraft?: boolean } = {},
) => {
  try {
    const { data } = await getWorkflowResourcesApi()
    workflowResources.value = data || null
    if (options.applyToCurrentDraft !== false) {
      applyWorkflowCreationDefaultsToNewDraft(
        draft,
        data?.creationDefaults,
        creationDefaultTouchedFields,
      )
    }
  } catch (error) {
    if (isCanceledRequest(error)) return
    if (!error?.__handled) ElMessage.error(extractApiErrorMessage(error, '工作流配置加载失败'))
  }
}

// 模型列表统一走共享 store（ModelChip 同源）；这里只负责校正草稿里的失效模型
const loadWorkflowModels = async () => {
  await aiModelStore.loadWorkflowModels()
  syncWorkflowModelSelection()
}

// 空模型 = 跟随默认（全书使用「AI 模型」页的建书默认模型），这是新建草稿的默认：
// 不自动补具体模型——那会在用户尚未见过该选择器时就把默认以 explicit 层钉进 run。
const syncWorkflowModelSelection = () => {
  const models = aiModelStore.workflowModels
  if (!models.length) return
  const current = String(draft.baseConfig.modelCode || '').trim()
  if (!current) return
  const exists = models.some(item => item.code === current)
  if (!exists) {
    // 草稿里的模型已下架/不可选：回落「跟随默认」而非悄悄换成另一个具体模型
    patchBaseConfig({ modelCode: '', modelFollowPreference: true })
  }
}

// 首个实质动作（生成灵感 / 采用灵感 / 下一步 / 保存 / 应用模板）才真正建 run
const ensureWorkflowRun = async () => {
  if (draft.id) return draft.id
  const { data } = await createWorkflowApi(buildWorkflowSavePayload(draft))
  applyWorkflowRunToDraft(draft, data)
  rememberActiveRun()
  await syncRouteRunId(data.id)
  return data.id
}

// 没有 run、也没写过灵感时不落库，避免「点一下历史/模板库」就产生一条空记录
const hasPersistableDraft = () => Boolean(draft.id || draft.ideaText.trim())

const persistDraft = async (override: Partial<WorkflowDraft> = {}) => {
  const runId = await ensureWorkflowRun()
  const saveWithRevision = async (expectedDraftRevision: number): Promise<WorkflowRun> => {
    const payload = buildWorkflowSavePayload(draft, {
      ...override,
      id: runId,
      draftRevision: expectedDraftRevision,
    } as Partial<WorkflowDraft>)
    try {
      const { data } = await saveWorkflowApi(payload)
      syncDraftRevisions(data)
      return data
    } catch (error) {
      return await resolveDraftConflict(error, saveWithRevision)
    }
  }
  return await saveWithRevision(draft.draftRevision)
}

// 设定是否已被服务端标记为「大纲变了、可能对不上」。
// 只做提示不清内容：用户可能在设定上改了很多轮，是否重生由他决定。
const settingStaleFlag = ref(false)

const syncDraftRevisions = (run: WorkflowRun) => {
  draft.id = Number(run.id || draft.id)
  draft.draftRevision = Number(run.draftRevision || 0)
  draft.outlineRevision = Number(run.outlineRevision || 0)
  const summary = run.summary || {}
  settingStaleFlag.value = Boolean((summary as JsonRecord).workflowSettingStale)
  if (summary.workflowSetting === null && summary.workflowSettingUi === null) {
    // 模板切换会真正清空设定，本地不得在下次保存时回灌。
    draft.settingResult = normalizeSettingResult(null)
  }
}

const draftConflictPayload = (error: WorkflowFlowError) => {
  const payload = error?.data || error?.response?.data?.data || null
  const run = payload?.run as WorkflowRun | undefined
  const revision = Number(payload?.currentDraftRevision ?? run?.draftRevision)
  return Number.isInteger(revision) && run ? { revision, run } : null
}

const isDraftConflict = (error: WorkflowFlowError) =>
  Number(error?.statusCode || error?.code || error?.response?.status || 0) === 409

const draftConflictHandled = () =>
  Object.assign(new Error('工作流草稿冲突已处理'), { draftConflictHandled: true })

const resolveDraftConflict = async <T>(
  error: WorkflowFlowError,
  overwrite: (revision: number) => Promise<T>
): Promise<T> => {
  const conflict = draftConflictPayload(error)
  if (!isDraftConflict(error) || !conflict) throw error
  try {
    await inkConfirm(
      '服务器上的草稿已被其他页面修改。加载服务器版本会放弃当前未保存内容；也可明确用本地草稿覆盖。',
      '草稿版本冲突',
      {
        confirmButtonText: '加载服务器版本',
        cancelButtonText: '用本地草稿覆盖',
        distinguishCancelAndClose: true,
        showClose: true,
        type: 'warning',
      }
    )
    applyWorkflowRunToDraft(draft, conflict.run)
    throw draftConflictHandled()
  } catch (action) {
    if (action?.draftConflictHandled) throw action
    if (action === 'cancel') {
      // 每次覆盖都必须由用户显式点击；再次冲突会重新询问。
      return await overwrite(conflict.revision)
    }
    throw draftConflictHandled()
  }
}

const generateInspiration = async (payload: {
  action: string
  directions: string[]
  ideaText: string
}) => {
  if (busy.value || inspirationGenerating.value) return
  if (!validateCreativeDirection()) return
  stepError.value = null
  inspirationGenerating.value = true
  try {
    const result = await runStepTask('inspiration', {
      action: payload.action,
      directions: payload.directions,
      ideaText: payload.ideaText,
    }, { ideaText: payload.ideaText })
    const ideaText = String(result.content?.ideaText || '').trim()
    if (!ideaText) throw new Error('灵感生成结果为空')
    pendingIdeaPreview.value = {
      text: ideaText,
      action: payload.action,
    }
    stepError.value = null
    ElMessage.success('已生成灵感预览')
  } catch (error) {
    if (isDraftConflictHandled(error) || isCanceledRequest(error)) return
    if (isStepCancelledError(error)) ElMessage.info('已取消本次生成')
    else {
      recordStepFailure(error, 'inspiration', 'MODE_SELECT', {
        action: payload.action,
        directions: [...payload.directions],
        ideaText: payload.ideaText,
      })
    }
  } finally {
    inspirationGenerating.value = false
  }
}

const retryStepError = () => {
  const failed = stepError.value
  if (!failed) return
  stepError.value = null
  if (failed.step === 'inspiration' && failed.request) {
    void generateInspiration(failed.request)
    return
  }
  if (failed.step === 'outline' && failed.visibleStepCode === 'BASE_CONFIG') {
    void handlePrimary()
    return
  }
  if (failed.step === 'setting' && failed.visibleStepCode === 'OUTLINE_GENERATE') {
    void handlePrimary()
    return
  }
  if (failed.step === 'outline') void regenerateOutline()
  else void regenerateSetting()
}

const closeIdeaPreview = () => {
  pendingIdeaPreview.value = null
}

// AI 辅助结果先进入预览，只有用户采用后才覆盖输入框并保存。
const applyIdeaPreview = async () => {
  const ideaText = String(pendingIdeaPreview.value?.text || '').trim()
  if (!ideaText || previewApplying.value) return
  previewApplying.value = true
  try {
    syncAutoSellingPoint(ideaText)
    draft.ideaText = ideaText
    pendingIdeaPreview.value = null
    await persistDraft({ currentStep: 'MODE_SELECT', status: 'waiting_user' })
    ElMessage.success('已采用灵感')
  } catch (error) {
    if (!isDraftConflictHandled(error)) ElMessage.error(error?.message || '采用灵感失败')
  } finally {
    previewApplying.value = false
  }
}

/**
 * 清掉「新增了却没填」的空行。
 *
 * 空白条目进提示词，模型会把它当成"存在但没写清楚的人物/阶段"去圆，拖累生成质量。
 * 幂等：清完再调一次不会重复提示，所以入口检查和落盘前各调一次都安全。
 */
const pruneUntouchedSettingEntries = () => {
  const pruned = dropUntouchedSettingEntries(draft.settingResult)
  if (!pruned.removed) return
  draft.settingResult = pruned.setting
  ElMessage.info(`已忽略 ${pruned.removed} 条未填写的设定`)
}

const enterAutoWriting = async () => {
  try {
    if (submitting.value) return
    submitting.value = true
    pruneUntouchedSettingEntries()
    await persistDraft({ currentStep: 'SETTING_GENERATE', status: 'waiting_user' })
    const { data } = await generateWorkflowBookApi({ runId: draft.id })
    if (isWorkflowBookConflict(data)) {
      ElMessage.warning(data.message || '当前有自动生文任务正在运行')
      void router.push({
        path: '/workflowBook/history',
        query: { status: 'running', taskId: String(data.activeTask?.id || '') },
      })
      return
    }
    if (!data.bookId) throw new Error('工作流未返回书籍ID')
    // 已建书：流程移交写作页，不再作为「进行中的工作流」被恢复
    clearActiveRunId(currentUserId.value)
    ElMessage.success('已开始自动生成')
    void router.push({
      path: `/writing/${data.bookId}`,
      query: { from: 'workflow', runId: String(data.runId || draft.id), taskId: String(data.id) }
    })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error?.message || '开始自动生成失败')
    }
  } finally {
    submitting.value = false
  }
}

// 步骤推进以服务端 run 为准，生成步骤成功后再切换页面状态。
const confirmRegenerate = async (target: string) => {
  try {
    await inkConfirm(
      `当前已有${target}内容（包括你的手动修改），重新生成会整体覆盖，确定继续吗？`,
      `重新生成${target}`,
      {
        confirmButtonText: '重新生成',
        cancelButtonText: '保留当前内容',
        type: 'warning',
      }
    )
    return true
  } catch {
    return false
  }
}

// 世界背景最终版同步：从 seed 把 5 张 worldCards 写入 draft.settingResult
// 设定同步：从 seed 同步 worldCards、core、characters 与 storylines（最终版）
const importWorldBgSeedIfNeeded = async () => {
  if (!draft.id) return
  // v5：seed 补了剧透排期字段（revealAtChapter / briefBackground / briefIntro）。
  // 旧书的设定里没有这些字段，不强制再同步一次的话，泄底闸门对存量书完全不生效。
  const markerKey = `ew-world-bg-${draft.id}-v5`
  try {
    if (localStorage.getItem(markerKey) === '1') return
    // 完整性检查：worldCards 含 w5，core 9/6/6，characters 10 张，storylines 7 条，
    // 并且剧透排期字段已就位 —— 只查条数会让存量旧数据蒙混过关，marker 一打就再也不补。
    const cur = draft.settingResult || {}
    const cards = cur.worldCards || []
    const realms = cur.core?.cultivation?.realms || []
    const mechs = cur.core?.mechanics?.items || []
    const ress = cur.core?.resources?.items || []
    const chars = cur.characters || []
    const lines = cur.storylines || []
    if (
      cards.length >= 5 && cards.some(c => c.id === 'w5' && c.title === '飞升与封印') &&
      realms.length >= 9 && mechs.length >= 6 && ress.length >= 6 &&
      chars.length >= 10 && chars.some(c => c.id === 'p10' && c.name === '九人旧信') &&
      lines.length >= 7 && lines.some(l => l.id === 's7' && l.title.includes('墨痕')) &&
      realms.some(r => Number(r.revealAtChapter || 0) > 0) &&
      chars.some(c => Boolean(String(c.briefBackground || '').trim())) &&
      lines.some(l => Number(l.revealAtChapter || 0) > 0)
    ) {
      localStorage.setItem(markerKey, '1')
      return
    }
    const resp = await fetch('/seed-volume1.json')
    if (!resp.ok) return
    const seed = await resp.json()
    if (
      !Array.isArray(seed?.worldCards) || seed.worldCards.length < 5 ||
      !seed?.core ||
      !Array.isArray(seed?.characters) || seed.characters.length < 10 ||
      !Array.isArray(seed?.storylines) || seed.storylines.length < 7
    ) return
    // 只替换 worldCards、core、characters、storylines，其余设定原样保留
    draft.settingResult = {
      ...cur,
      worldCards: seed.worldCards,
      core: seed.core,
      characters: seed.characters,
      storylines: seed.storylines,
    }
    await persistDraft({ currentStep: 'SETTING_GENERATE', status: 'waiting_user' })
    localStorage.setItem(markerKey, '1')
    ElMessage.success('已同步世界背景、核心设定、角色卡与故事线')
  } catch (error) {
    console.warn('[world-bg] 同步失败', error)
  }
}
// 大纲/设定页的"重新生成"入口：与前进重生共用覆盖确认，成功后停留在当前步骤。
const regenerateOutline = async () => {
  if (busy.value) return
  if (draft.outlineResult.chapters.length && !(await confirmRegenerate('大纲'))) return
  submitting.value = true
  cancelableGenerating.value = true
  try {
    const result = await runStepTask('outline', {})
    draft.outlineResult = normalizeOutlineResult(result.content)
    stepError.value = null
    await persistDraft({ currentStep: 'OUTLINE_GENERATE', status: 'waiting_user' })
    ElMessage.success('大纲已重新生成')
  } catch (error) {
    if (isDraftConflictHandled(error) || isCanceledRequest(error)) return
    if (isStepCancelledError(error)) ElMessage.info('已取消本次生成')
    else recordStepFailure(error, 'outline', draft.currentStep)
  } finally {
    cancelableGenerating.value = false
    submitting.value = false
  }
}

// ==================== 第三步：按要求调整大纲 ====================
// 非破坏式：AI 先出候选，用户确认后才成为新版本，当前版本始终保留。
// 注意：服务端 propose / apply 接口尚未落地，runOutlineAdjust 内部目前是本地模拟，
// 交互确认后只需把 buildMockCandidate 换成真实请求，其余状态机不动。

const OUTLINE_ADJUST_STAGES: Array<{ key: string; label: string }> = [
  { key: 'read', label: '读取当前大纲' },
  { key: 'preserve', label: '应用保留项' },
  { key: 'generate', label: '生成调整内容' },
  { key: 'verify', label: '一致性检查' },
]

const outlineAdjustDrawerRef = ref<InstanceType<typeof WorkflowOutlineAdjustDrawer> | null>(null)
const outlineAdjustVisible = ref(false)
const outlineAdjustPhase = ref<WorkflowAdjustPhase>('input')
const outlineAdjustPercent = ref(0)
const outlineAdjustStages = ref<WorkflowAdjustStage[]>([])
const outlineAdjustCandidate = ref<WorkflowOutlineAdjustCandidate | null>(null)
const outlineAdjustError = ref('')
const outlineUpdatedKeys = ref<string[]>([])
const outlineAdjustTaskId = ref(0)
const applyingOutlineCandidate = ref(false)
let outlineAdjustRequest: WorkflowOutlineAdjustRequest | null = null

const workflowModelDisplayName = computed(() => {
  const group = aiModelStore.groups.workflow_book
  const models = group?.models || []
  const explicitCode = String(draft.baseConfig.modelCode || '').trim()
  const resolved = explicitCode
    ? models.find(item => item.code === explicitCode)
    : group?.selectedModel || group?.defaultModel
  if (resolved) return resolved.name || resolved.modelCode || resolved.code
  return explicitCode
})

// 「已更新」只是应用瞬间的定位提示，亮一下就清掉，不作为常驻状态。
// 6s 与角标的淡出动画同长，元素被移除时已经透明。
let outlineUpdatedTimer: ReturnType<typeof setTimeout> | null = null
const flashOutlineUpdated = (keys: string[]) => {
  if (outlineUpdatedTimer) clearTimeout(outlineUpdatedTimer)
  outlineUpdatedKeys.value = keys
  outlineUpdatedTimer = setTimeout(() => {
    outlineUpdatedKeys.value = []
    outlineUpdatedTimer = null
  }, 6000)
}

const openOutlineAdjust = () => {
  if (busy.value) return
  outlineAdjustError.value = ''
  outlineAdjustPhase.value = outlineAdjustCandidate.value ? 'candidate' : 'input'
  outlineAdjustVisible.value = true
}

// 生成中关闭抽屉不终止任务：设计要求生成期间用户仍能回看当前大纲。
const closeOutlineAdjust = () => {
  outlineAdjustVisible.value = false
}

const startOutlineAdjust = (request: WorkflowOutlineAdjustRequest) => {
  outlineAdjustRequest = request
  void runOutlineAdjust()
}

const regenerateOutlineCandidate = () => {
  if (!outlineAdjustRequest) return
  void runOutlineAdjust()
}

const confirmDirectRegenerate = async () => {
  if (busy.value) return
  try {
    await inkConfirm(
      '将忽略当前大纲内容，重新生成一份完整候选。当前大纲不会丢失，生成完成后仍需确认应用。',
      '直接重新生成大纲？',
      {
        confirmButtonText: '生成新候选',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )
  } catch {
    return
  }
  // 直接重生不带要求和范围，但同样先出候选，不覆盖当前版本。
  outlineAdjustRequest = {
    scope: 'all',
    instruction: '',
    preserve: [],
    allowVolumeTitleChange: true,
  }
  void runOutlineAdjust()
}

// 服务端把阶段进度写进 task.payload.adjustProgress，由既有轮询带回，不额外开 SSE。
/** 两个调整步骤的阶段推进算法一致，只有阶段清单和落点不同 */
const resolveAdjustProgress = (
  task: WorkflowStepTask,
  definition: Array<{ key: string; label: string }>
) => {
  const progress = task.payload?.adjustProgress
  const stageKey = progress?.stage || 'read'
  const index = Math.max(0, definition.findIndex(item => item.key === stageKey))
  return {
    stages: definition.map((stage, stageIndex) => ({
      ...stage,
      status: (stageIndex < index
        ? 'done'
        : stageIndex === index
        ? 'running'
        : 'pending') as WorkflowAdjustStage['status'],
    })),
    percent: Number(
      progress?.percent ?? Math.round((index / definition.length) * 100)
    ),
  }
}

const applyOutlineAdjustProgress = (task: WorkflowStepTask) => {
  const next = resolveAdjustProgress(task, OUTLINE_ADJUST_STAGES)
  outlineAdjustStages.value = next.stages
  outlineAdjustPercent.value = next.percent
}

const toOutlineAdjustCandidate = (
  result: JsonRecord
): WorkflowOutlineAdjustCandidate => ({
  candidateId: Number(result.candidateId || 0),
  version: Number(result.version || 0),
  request: (result.request as WorkflowOutlineAdjustRequest) || null,
  tags: Array.isArray(result.tags) ? result.tags : [],
  changes: Array.isArray(result.changes) ? result.changes : [],
  consistency: result.consistency || { passed: true, message: '' },
  manualEditCount: Number(result.manualEditCount || 0),
  // 服务端返回的是与 workflowOutline 同构的原始结构，这里统一走展示层归一化。
  outline: normalizeOutlineResult(result.outline),
})

const runOutlineAdjust = async () => {
  if (!outlineAdjustRequest) return
  outlineAdjustError.value = ''
  outlineAdjustCandidate.value = null
  outlineAdjustPhase.value = 'generating'
  outlineAdjustVisible.value = true
  outlineAdjustPercent.value = 0
  outlineAdjustStages.value = OUTLINE_ADJUST_STAGES.map((stage, index) => ({
    ...stage,
    status: index === 0 ? 'running' : 'pending',
  }))
  try {
    // 先落盘：候选基于服务端已保存的大纲生成，本地手改必须先成为真源。
    const savedRun = await persistDraft({
      currentStep: 'OUTLINE_GENERATE',
      status: 'waiting_user',
    })
    const { data: task } = await submitWorkflowStepTaskApi({
      runId: savedRun.id,
      step: 'outline_adjust',
      expectedDraftRevision: savedRun.draftRevision,
      input: { request: outlineAdjustRequest },
    })
    outlineAdjustTaskId.value = Number(task.id)
    const done = await waitStepTask(
      Number(task.id),
      'outline_adjust',
      applyOutlineAdjustProgress
    )
    const result = done.payload?.result
    if (!result?.candidateId) throw new Error('候选生成结果为空，请重试')
    finishOutlineAdjust(result)
  } catch (error) {
    if (isCanceledRequest(error)) return
    outlineAdjustPhase.value = 'input'
    outlineAdjustPercent.value = 0
    outlineAdjustStages.value = []
    if (isStepCancelledError(error)) {
      ElMessage.info('已停止生成，当前大纲未改变')
      return
    }
    if (isDraftConflictHandled(error)) return
    outlineAdjustError.value = extractApiErrorMessage(error, '调整候选生成失败，请重试')
  } finally {
    outlineAdjustTaskId.value = 0
    stopStepPolling()
  }
}

// 切走页面或关窗时任务仍在服务端跑，回来接管进度或直接拿到已生成的候选。
const restoreOutlineAdjustTask = async (task: WorkflowStepTask) => {
  const request = task.payload?.input?.request
  if (request) outlineAdjustRequest = request as WorkflowOutlineAdjustRequest
  draft.currentStep = 'OUTLINE_GENERATE'
  outlineAdjustTaskId.value = Number(task.id)
  outlineAdjustPhase.value = 'generating'
  outlineAdjustVisible.value = true
  applyOutlineAdjustProgress(task)
  try {
    const done = await waitStepTask(Number(task.id), 'outline_adjust', applyOutlineAdjustProgress)
    const result = done.payload?.result
    if (!result?.candidateId) throw new Error('候选生成结果为空，请重试')
    finishOutlineAdjust(result)
  } catch (error) {
    if (isCanceledRequest(error)) return
    outlineAdjustPhase.value = 'input'
    outlineAdjustPercent.value = 0
    outlineAdjustStages.value = []
    if (isStepCancelledError(error)) {
      outlineAdjustVisible.value = false
      return
    }
    outlineAdjustError.value = extractApiErrorMessage(error, '调整候选生成失败，请重试')
  } finally {
    outlineAdjustTaskId.value = 0
    stopStepPolling()
  }
}

const finishOutlineAdjust = (result: JsonRecord) => {
  outlineAdjustCandidate.value = toOutlineAdjustCandidate(result)
  outlineAdjustPhase.value = 'candidate'
  outlineAdjustPercent.value = 100
  outlineAdjustStages.value = OUTLINE_ADJUST_STAGES.map(stage => ({ ...stage, status: 'done' }))
  if (!outlineAdjustVisible.value) {
    outlineAdjustVisible.value = true
    ElMessage.success('调整候选已生成，请确认')
  }
}

const stopOutlineAdjust = async () => {
  const taskId = outlineAdjustTaskId.value
  if (!taskId) return
  try {
    await cancelWorkflowTaskApi({ taskId })
  } catch (error) {
    if (!error?.__handled) ElMessage.error(extractApiErrorMessage(error, '停止生成失败，请重试'))
  }
}

const discardOutlineCandidate = async () => {
  const candidate = outlineAdjustCandidate.value
  outlineAdjustCandidate.value = null
  outlineAdjustPhase.value = 'input'
  outlineAdjustVisible.value = false
  if (candidate?.candidateId && draft.id) {
    // 候选是服务端的一条软删记录，本地清掉的同时要通知服务端，避免下次进页面又被恢复出来。
    await discardWorkflowOutlineAdjustApi({
      runId: draft.id,
      candidateId: candidate.candidateId,
    }).catch(() => undefined)
  }
  ElMessage.info('已废弃本次候选，当前大纲未改变')
}

const applyOutlineCandidate = async () => {
  const candidate = outlineAdjustCandidate.value
  if (!candidate || applyingOutlineCandidate.value) return
  applyingOutlineCandidate.value = true
  try {
    const { data } = await applyWorkflowOutlineAdjustApi({
      runId: draft.id,
      candidateId: candidate.candidateId,
      expectedDraftRevision: draft.draftRevision,
    })
    draft.draftRevision = Number(data.draftRevision || draft.draftRevision)
    draft.outlineRevision = Number(data.outlineRevision || draft.outlineRevision)
    draft.outlineResult = normalizeOutlineResult(data.content)
    flashOutlineUpdated(candidate.changes.map(item => item.key))
    hasAiArtifact.value = true
    outlineAdjustCandidate.value = null
    outlineAdjustPhase.value = 'input'
    outlineAdjustVisible.value = false
    outlineAdjustRequest = null
    outlineAdjustDrawerRef.value?.resetDraft()
    ElMessage.success(
      `已按要求调整 ${candidate.changes.length} 处`
    )
  } catch (error) {
    if (isCanceledRequest(error)) return
    outlineAdjustError.value = extractApiErrorMessage(error, '应用失败，请重试')
    ElMessage.error(outlineAdjustError.value)
  } finally {
    applyingOutlineCandidate.value = false
  }
}

const SETTING_ADJUST_STAGES: Array<{ key: string; label: string }> = [
  { key: 'read', label: '读取当前设定' },
  { key: 'preserve', label: '应用保留项' },
  { key: 'generate', label: '生成调整内容' },
  { key: 'verify', label: '一致性检查' },
]

const settingAdjustDrawerRef = ref<InstanceType<typeof WorkflowSettingAdjustDrawer> | null>(null)
const settingAdjustVisible = ref(false)
const settingAdjustPhase = ref<WorkflowAdjustPhase>('input')
const settingAdjustPercent = ref(0)
const settingAdjustStages = ref<WorkflowAdjustStage[]>([])
const settingAdjustCandidate = ref<WorkflowSettingAdjustCandidate | null>(null)
const settingAdjustError = ref('')
const settingAdjustTaskId = ref(0)
const applyingSettingCandidate = ref(false)
let settingAdjustRequest: WorkflowSettingAdjustRequest | null = null

// 大纲变更后服务端只打过期标记、不再清空设定，由用户决定要不要重生。
const settingStale = computed(() => settingStaleFlag.value)

const settingAdjustCharacters = computed(() =>
  draft.settingResult.characters.map((item, index) => ({
    id: String(item.id || `char-${index + 1}`),
    name: String(item.name || ''),
  }))
)
const settingAdjustStorylines = computed(() =>
  draft.settingResult.storylines.map((item, index) => ({
    id: String(item.id || `line-${index + 1}`),
    title: String(item.title || ''),
  }))
)

const openSettingAdjust = () => {
  if (busy.value) return
  settingAdjustError.value = ''
  settingAdjustPhase.value = settingAdjustCandidate.value ? 'candidate' : 'input'
  settingAdjustVisible.value = true
}

/** 角色卡 / 剧情线卡上的入口：带着目标直接打开，省去再选一次 */
const openSettingAdjustForItem = (payload: { kind: 'character' | 'storyline'; id: string }) => {
  if (busy.value) return
  settingAdjustError.value = ''
  settingAdjustPhase.value = 'input'
  settingAdjustVisible.value = true
  void nextTick(() => settingAdjustDrawerRef.value?.openForTarget(payload.kind, payload.id))
}

const applySettingAdjustProgress = (task: WorkflowStepTask) => {
  const next = resolveAdjustProgress(task, SETTING_ADJUST_STAGES)
  settingAdjustStages.value = next.stages
  settingAdjustPercent.value = next.percent
}

const toSettingAdjustCandidate = (
  result: JsonRecord
): WorkflowSettingAdjustCandidate => ({
  candidateId: Number(result.candidateId || 0),
  version: Number(result.version || 0),
  request: (result.request as WorkflowSettingAdjustRequest) || null,
  tags: Array.isArray(result.tags) ? result.tags : [],
  changes: Array.isArray(result.changes) ? result.changes : [],
  consistency: result.consistency || { passed: true, message: '', warnings: [] },
  manualEditCount: Number(result.manualEditCount || 0),
  setting: normalizeSettingResult(result.setting),
})

const finishSettingAdjust = (result: JsonRecord) => {
  settingAdjustCandidate.value = toSettingAdjustCandidate(result)
  settingAdjustPhase.value = 'candidate'
  settingAdjustPercent.value = 100
  settingAdjustStages.value = SETTING_ADJUST_STAGES.map(stage => ({ ...stage, status: 'done' }))
  if (!settingAdjustVisible.value) {
    settingAdjustVisible.value = true
    ElMessage.success('调整候选已生成，请确认')
  }
}

const runSettingAdjust = async () => {
  if (!settingAdjustRequest) return
  settingAdjustError.value = ''
  settingAdjustCandidate.value = null
  settingAdjustPhase.value = 'generating'
  settingAdjustVisible.value = true
  settingAdjustPercent.value = 0
  settingAdjustStages.value = SETTING_ADJUST_STAGES.map((stage, index) => ({
    ...stage,
    status: index === 0 ? 'running' : 'pending',
  }))
  try {
    // 先落盘：候选基于服务端已保存的设定生成，本地手改必须先成为真源。
    const savedRun = await persistDraft({
      currentStep: 'SETTING_GENERATE',
      status: 'waiting_user',
    })
    const { data: task } = await submitWorkflowStepTaskApi({
      runId: savedRun.id,
      step: 'setting_adjust',
      expectedDraftRevision: savedRun.draftRevision,
      input: { request: settingAdjustRequest },
    })
    settingAdjustTaskId.value = Number(task.id)
    const done = await waitStepTask(
      Number(task.id),
      'setting_adjust',
      applySettingAdjustProgress
    )
    const result = done.payload?.result
    if (!result?.candidateId) throw new Error('候选生成结果为空，请重试')
    finishSettingAdjust(result)
  } catch (error) {
    if (isCanceledRequest(error)) return
    settingAdjustPhase.value = 'input'
    settingAdjustPercent.value = 0
    settingAdjustStages.value = []
    if (isStepCancelledError(error)) {
      ElMessage.info('已停止生成，当前设定未改变')
      return
    }
    if (isDraftConflictHandled(error)) return
    settingAdjustError.value = extractApiErrorMessage(error, '调整候选生成失败，请重试')
  } finally {
    settingAdjustTaskId.value = 0
    stopStepPolling()
  }
}

const startSettingAdjust = (request: WorkflowSettingAdjustRequest) => {
  settingAdjustRequest = request
  void runSettingAdjust()
}

const regenerateSettingCandidate = () => {
  if (!settingAdjustRequest) return
  void runSettingAdjust()
}

const stopSettingAdjust = async () => {
  const taskId = settingAdjustTaskId.value
  if (!taskId) return
  try {
    await cancelWorkflowTaskApi({ taskId })
  } catch (error) {
    if (!error?.__handled) ElMessage.error(extractApiErrorMessage(error, '停止生成失败，请重试'))
  }
}

const discardSettingCandidate = async () => {
  const candidate = settingAdjustCandidate.value
  settingAdjustCandidate.value = null
  settingAdjustPhase.value = 'input'
  settingAdjustVisible.value = false
  if (candidate?.candidateId && draft.id) {
    // 候选是服务端的一条软删记录，本地清掉的同时要通知服务端。
    await discardWorkflowSettingAdjustApi({
      runId: draft.id,
      candidateId: candidate.candidateId,
    }).catch(() => undefined)
  }
  ElMessage.info('已废弃本次候选，当前设定未改变')
}

const applySettingCandidate = async () => {
  const candidate = settingAdjustCandidate.value
  if (!candidate || applyingSettingCandidate.value) return
  applyingSettingCandidate.value = true
  try {
    const { data } = await applyWorkflowSettingAdjustApi({
      runId: draft.id,
      candidateId: candidate.candidateId,
      expectedDraftRevision: draft.draftRevision,
    })
    draft.draftRevision = Number(data.draftRevision || draft.draftRevision)
    draft.outlineRevision = Number(data.outlineRevision || draft.outlineRevision)
    draft.settingResult = normalizeSettingResult(data.content)
    settingStaleFlag.value = false
    hasAiArtifact.value = true
    settingAdjustCandidate.value = null
    settingAdjustPhase.value = 'input'
    settingAdjustVisible.value = false
    settingAdjustRequest = null
    settingAdjustDrawerRef.value?.resetDraft()
    ElMessage.success(`已按要求调整 ${candidate.changes.length} 处`)
  } catch (error) {
    if (isCanceledRequest(error)) return
    settingAdjustError.value = extractApiErrorMessage(error, '应用失败，请重试')
    ElMessage.error(settingAdjustError.value)
  } finally {
    applyingSettingCandidate.value = false
  }
}

const regenerateSetting = async () => {
  if (busy.value) return
  if (draft.settingResult.characters.length && !(await confirmRegenerate('设定'))) return
  submitting.value = true
  cancelableGenerating.value = true
  try {
    const result = await runStepTask('setting', {})
    draft.settingResult = normalizeSettingResult(result.content)
    settingStaleFlag.value = false
    stepError.value = null
    await persistDraft({ currentStep: 'SETTING_GENERATE', status: 'waiting_user' })
    ElMessage.success('设定已重新生成')
  } catch (error) {
    if (isDraftConflictHandled(error) || isCanceledRequest(error)) return
    if (isStepCancelledError(error)) ElMessage.info('已取消本次生成')
    else recordStepFailure(error, 'setting', draft.currentStep)
  } finally {
    cancelableGenerating.value = false
    submitting.value = false
  }
}

const handlePrimary = async () => {
  if (busy.value) return
  if (isLastStep.value) {
    // 先清空行再判断：只剩一个空白新增行时，角色数会被清成 0，
    // 放在清理之前判断会把这种情况当成"有设定"放行，带着空列表进生文。
    pruneUntouchedSettingEntries()
    if (!draft.settingResult.characters.length) {
      showWorkflowWarning('请先生成作品设定')
      return
    }
    try {
      await inkConfirm(
        '确认根据当前大纲与设定创建书籍，并开始自动生成正文吗？',
        '进入自动生文',
        {
          confirmButtonText: '确认生成',
          cancelButtonText: '继续检查',
          type: 'warning',
        }
      )
    } catch {
      return
    }
    await enterAutoWriting()
    return
  }
  const currentStep = draft.currentStep
  if (draft.currentStep === 'MODE_SELECT') {
    if (!validateCreativeDirection()) return
    if (!draft.ideaText.trim()) {
      showWorkflowWarning('请先输入或选择一个故事灵感')
      return
    }
  }
  submitting.value = true
  try {
    if (draft.currentStep === 'MODE_SELECT') {
      syncAutoSellingPoint(draft.ideaText)
      draft.currentStep = 'BASE_CONFIG'
      await persistDraft({ currentStep: 'BASE_CONFIG', status: 'waiting_user' })
      return
    }
    if (draft.currentStep === 'BASE_CONFIG') {
      if (
        currentPlatformRankCategories.value.length > 0 &&
        !String(draft.baseConfig.platformCategory || '').trim()
      ) {
        showWorkflowWarning('请先选择小说类型，或填写自定义类型')
        return
      }
      // 已有大纲（可能含手改）时重生成会整包覆盖，先确认。
      if (draft.outlineResult.chapters.length && !(await confirmRegenerate('大纲'))) return
      cancelableGenerating.value = true
      const result = await runStepTask('outline', {}, {
        currentStep: 'BASE_CONFIG',
        status: 'waiting_user',
      })
      draft.outlineResult = normalizeOutlineResult(result.content)
      stepError.value = null
      draft.currentStep = 'OUTLINE_GENERATE'
      draft.status = 'waiting_user'
      await persistDraft({ currentStep: 'OUTLINE_GENERATE', status: 'waiting_user' })
      return
    }
    if (draft.currentStep === 'OUTLINE_GENERATE') {
      if (draft.settingResult.characters.length && !(await confirmRegenerate('设定'))) return
      cancelableGenerating.value = true
      const result = await runStepTask('setting', {}, {
        currentStep: 'OUTLINE_GENERATE',
        status: 'waiting_user',
      })
      draft.settingResult = normalizeSettingResult(result.content)
      stepError.value = null
      draft.currentStep = 'SETTING_GENERATE'
      draft.status = 'waiting_user'
      await persistDraft({ currentStep: 'SETTING_GENERATE', status: 'waiting_user' })
    }
  } catch (error) {
    if (isDraftConflictHandled(error) || isCanceledRequest(error)) return
    if (isStepCancelledError(error)) ElMessage.info('已取消本次生成')
    else if (currentStep === 'BASE_CONFIG') recordStepFailure(error, 'outline', currentStep)
    else if (currentStep === 'OUTLINE_GENERATE') recordStepFailure(error, 'setting', currentStep)
    else showWorkflowError(buildWorkflowErrorMessage(error, currentStep))
  } finally {
    cancelableGenerating.value = false
    submitting.value = false
  }
}

// 取消进行中的生成：走服务端任务取消，在子步骤边界生效——
// 已完成的子步骤结果保留（真实消耗有对应产出），后续子步骤不再发起。
const cancelGeneration = async () => {
  const taskId = activeStepTaskId.value
  if (!taskId) return
  try {
    await inkConfirm(
      '确定取消本次生成吗？已完成的部分会保留，未开始的部分不再执行。',
      '取消生成',
      {
        confirmButtonText: '取消生成',
        cancelButtonText: '继续等待',
        type: 'warning',
      }
    )
  } catch {
    return
  }
  try {
    await cancelWorkflowTaskApi({ taskId })
    // 终态由轮询感知并统一收尾，这里不直接改状态
  } catch (error) {
    ElMessage.error(error?.message || '取消失败，请重试')
  }
}

// 页面离开不改变后台任务，历史记录会同步展示成功或失败终态。
onBeforeRouteLeave(() => {
  if (cancelableGenerating.value || inspirationGenerating.value) {
    ElMessage.info('生成已转到后台，可在历史记录查看结果或失败原因')
  }
  stopStepPolling()
  return true
})

const prevStep = () => {
  if (busy.value) return
  const prev = stepMetas[currentIndex.value - 1]
  if (prev) draft.currentStep = prev.code
}

const saveDraft = async () => {
  if (busy.value) return
  if (!hasPersistableDraft()) {
    showWorkflowWarning('请先输入或选择一个故事灵感再保存')
    return
  }
  saving.value = true
  try {
    draft.title = resolveWorkflowTitle(draft)
    await persistDraft()
    ElMessage.success('保存成功，可在历史记录中查看当前进度')
  } catch (error) {
    if (!isDraftConflictHandled(error)) ElMessage.error(error?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

// 页面重进恢复：run 存在进行中的步骤任务时接管展示并继续轮询，
// 完成后按步骤应用结果（与提交路径一致），实现"切走再回来无缝续上"。
const restoreActiveStepTask = async () => {
  if (!draft.id) return
  const task = await getWorkflowActiveStepTaskApi(draft.id)
    .then(res => res.data)
    .catch(() => null)
  if (!task?.id) return
  // 重进页面只接管执行态，历史失败不在入口重复弹错。
  if (!['queued', 'running'].includes(String(task.status || ''))) return
  const step = task.payload?.step
  // 大纲调整候选走自己的抽屉状态机，不参与四步流程的步骤恢复。
  if (step === 'outline_adjust') {
    await restoreOutlineAdjustTask(task)
    return
  }
  if (!['inspiration', 'outline', 'setting'].includes(String(step || ''))) {
    showWorkflowError('生成任务步骤异常，已拒绝接管')
    return
  }
  const input = task.payload?.input || {}
  const stepCode: WorkflowStepCode = step === 'outline'
    ? 'BASE_CONFIG'
    : step === 'setting'
      ? 'OUTLINE_GENERATE'
      : 'MODE_SELECT'
  activeStepTaskId.value = Number(task.id)
  if (step === 'inspiration') inspirationGenerating.value = true
  else {
    submitting.value = true
    cancelableGenerating.value = true
  }
  try {
    const done = await waitStepTask(Number(task.id), step as 'inspiration' | 'outline' | 'setting')
    const result = done?.payload?.result
    if (!result?.content) throw new Error('生成结果为空，请重试')
    draft.draftRevision = Number(result.draftRevision || draft.draftRevision)
    draft.outlineRevision = Number(result.outlineRevision || draft.outlineRevision)
    if (step === 'inspiration') {
      const ideaText = String(result.content?.ideaText || '').trim()
      if (ideaText) {
        pendingIdeaPreview.value = { text: ideaText, action: String(input.action || 'generate') }
        stepError.value = null
        ElMessage.success('已生成灵感预览')
      }
    } else if (step === 'outline') {
      draft.outlineResult = normalizeOutlineResult(result.content)
      stepError.value = null
      draft.currentStep = 'OUTLINE_GENERATE'
      draft.status = 'waiting_user'
      await persistDraft({ currentStep: 'OUTLINE_GENERATE', status: 'waiting_user' })
      ElMessage.success('大纲已生成')
    } else if (step === 'setting') {
      draft.settingResult = normalizeSettingResult(result.content)
      stepError.value = null
      draft.currentStep = 'SETTING_GENERATE'
      draft.status = 'waiting_user'
      await persistDraft({ currentStep: 'SETTING_GENERATE', status: 'waiting_user' })
      ElMessage.success('设定已生成')
    }
  } catch (error) {
    if (isDraftConflictHandled(error) || isCanceledRequest(error)) return
    if (isStepCancelledError(error)) ElMessage.info('已取消本次生成')
    else recordStepFailure(
      error,
      step as 'inspiration' | 'outline' | 'setting',
      stepCode,
      step === 'inspiration'
        ? {
            action: String(input.action || 'generate'),
            directions: Array.isArray(input.directions) ? input.directions : [],
            ideaText: String(input.ideaText || ''),
          }
        : undefined,
    )
  } finally {
    activeStepTaskId.value = 0
    inspirationGenerating.value = false
    cancelableGenerating.value = false
    submitting.value = false
    stopStepPolling()
  }
}

onMounted(() => {
  void (async () => {
    await loadWorkflow()
    // 恢复检查紧跟 run 加载：进入页面立即接管"生成中"状态，不等次要资源
    void restoreActiveStepTask()
    void importWorldBgSeedIfNeeded()
  })()
  void loadWorkflowResources()
  void loadWorkflowModels()
})

onBeforeUnmount(() => {
  stopStepPolling()
})

</script>
