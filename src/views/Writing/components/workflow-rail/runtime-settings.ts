/**
 * 规则/作品面板共用的运行时配置草稿逻辑。
 *
 * 从 WorkflowSettingsPanel 抽出的可复用部分：读 run 配置（含待生效补丁）、
 * 结构化设定回填、草稿-基线-指纹三件套。旧组件文件保持原样以便回退。
 */
import { computed, reactive, ref, watch, type Ref } from 'vue'
import { extractApiErrorMessage } from '@/utils/api-error'
import type {
  WorkflowResources,
  WorkflowRun,
  WorkflowRuntimeSettings,
} from '@/types/workflow'
// 开源版：界面选项资源走本地内置清单
import { getLocalWorkflowResources as getWorkflowResourcesApi } from '@/storage/local-workflow'
import { normalizeSettingResult } from '@/views/WorkflowBook/workflow-adapter'
import type {
  WorkflowSettingCoreItem,
  WorkflowSettingResult,
} from '@/views/WorkflowBook/types'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const readText = (value: unknown) => (typeof value === 'string' ? value : '')

export const readTextList = (value: unknown) =>
  Array.isArray(value)
    ? value.map(readText).map(item => item.trim()).filter(Boolean)
    : []

const findSettingSource = (run: WorkflowRun) => {
  const summary = isRecord(run.summary) ? run.summary : {}
  const artifact = run.artifacts?.find(item => item.artifactType === 'setting')?.content
  const source = [summary.workflowSettingUi, summary.workflowSetting, artifact].find(isRecord)
  if (!source) return {}
  return isRecord(source.setting) ? source.setting : source
}

const formatCoreItem = (item: WorkflowSettingCoreItem) => {
  const title = item.title.trim()
  const description = item.desc.trim()
  return [title, description].filter(Boolean).join('：')
}

/** 运行时文本设定完整承接结构化设定内容，避免切换模型时丢失未展示的世界规则。 */
export const buildInitialCoreSetting = (setting: WorkflowSettingResult) => {
  const lines: string[] = []
  setting.worldCards.forEach(card => {
    const content = [
      card.content?.trim(),
      card.tags?.map(tag => tag.trim()).filter(Boolean).join('、'),
      card.bullets?.map(bullet => bullet.trim()).filter(Boolean).join('；'),
    ].filter(Boolean).join('；')
    if (card.title.trim() && content) lines.push(`${card.title.trim()}：${content}`)
  })

  const { cultivation, ability, mechanics, resources } = setting.core
  const realms = cultivation.realms
    .map(realm => {
      const name = realm.name.trim()
      const description = realm.desc.trim()
      return name ? `${name}${description ? `（${description}）` : ''}` : description
    })
    .filter(Boolean)
    .join('、')
  const cultivationContent = [
    cultivation.intro.trim(),
    realms ? `境界：${realms}` : '',
    cultivation.more.trim(),
  ].filter(Boolean).join('；')
  if (cultivationContent) {
    lines.push(`力量体系：${cultivationContent}`)
  }

  const abilityContent = [
    ability.intro.trim(),
    formatCoreItem(ability.innate),
    formatCoreItem(ability.acquired),
    formatCoreItem(ability.bodyMemory),
    formatCoreItem(ability.sealArt),
    ability.dimensions.map(dimension => dimension.trim()).filter(Boolean).join('、'),
  ].filter(Boolean).join('；')
  if (abilityContent) lines.push(`能力规则：${abilityContent}`)

  const mechanicsContent = [
    mechanics.intro.trim(),
    ...mechanics.items.map(formatCoreItem),
  ].filter(Boolean).join('；')
  if (mechanicsContent) lines.push(`世界机制：${mechanicsContent}`)

  const resourceContent = [
    resources.intro.trim(),
    ...resources.items.map(formatCoreItem),
  ].filter(Boolean).join('；')
  if (resourceContent) lines.push(`资源体系：${resourceContent}`)

  return lines.join('\n').slice(0, 2000)
}

export const buildInitialStoryLine = (setting: WorkflowSettingResult) => {
  return setting.storylines
    .map(storyline => {
      const title = storyline.title.trim()
      const description = storyline.desc.trim()
      const keyEvent = storyline.keyEvent.trim()
      if (!title && !description && !keyEvent) return ''
      return `${title || '故事线'}：${[description, keyEvent ? `关键事件：${keyEvent}` : ''].filter(Boolean).join('；')}`
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000)
}

export interface WorkflowRunConfigReader {
  /** 当前配置与待生效补丁合并后的键值读取（延后生效字段优先） */
  readConfigText: (key: keyof WorkflowRuntimeSettings, fallback?: string) => string
  /** 运行时叙事标签（旧数据 narrativeStyle 的回退来源） */
  tags: string[]
  /** 顶层 modelCode（含 pending 覆盖） */
  modelCode: string
  /** 结构化设定归一化结果（核心设定/故事主线的初始回填来源） */
  setting: WorkflowSettingResult
}

/** 延后生效配置只覆盖明确携带的字段，未排期字段继续读取当前运行配置。 */
export const createRunConfigReader = (run: WorkflowRun | null): WorkflowRunConfigReader | null => {
  if (!run) return null
  const currentConfig = isRecord(run.config) ? run.config : {}
  const pending = isRecord(currentConfig.pendingRuntimeConfig)
    ? currentConfig.pendingRuntimeConfig
    : null
  const pendingConfig = pending && isRecord(pending.config) ? pending.config : {}
  const config: Record<string, unknown> = {
    ...currentConfig,
    ...pendingConfig,
  }
  const setting = normalizeSettingResult(findSettingSource(run))
  // 顶层 modelCode 是运行时当前值，配置内同名字段只承接旧工作流保存结构。
  const currentModelCode = readText(run.modelCode ?? currentConfig.modelCode)
  const modelCode = pending && Object.prototype.hasOwnProperty.call(pending, 'modelCode')
    ? readText(pending.modelCode)
    : currentModelCode
  return {
    readConfigText: (key, fallback = '') =>
      Object.prototype.hasOwnProperty.call(config, key) ? readText(config[key]) : fallback,
    tags: readTextList(config.tags),
    modelCode,
    setting,
  }
}

/** 可选项资源（平台/分类/视角等），面板各自加载互不影响 */
export const useWorkflowResources = () => {
  const resources = ref<WorkflowResources | null>(null)
  const loading = ref(false)
  const error = ref('')

  const load = async () => {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      const { data } = await getWorkflowResourcesApi()
      resources.value = data
    } catch (err) {
      error.value = extractApiErrorMessage(err, '生成配置加载失败')
    } finally {
      loading.value = false
    }
  }

  return { resources, loading, error, load }
}

export interface RuntimeDraftController<T extends Record<string, string>> {
  draft: T
  baseline: Ref<T>
  changedFields: Ref<Array<keyof T>>
  changedCount: Ref<number>
  /** 放弃修改：回到当前 run 状态 */
  discard: () => void
  /** 提交前记录指纹：服务端确认后草稿以新配置为准重置 */
  markSubmitted: (next: T) => void
  /** 撤销未生效的提交指纹（例如确认弹窗被取消） */
  clearSubmitted: () => void
  /** 只挑出与基线不同的字段（补丁语义） */
  buildPatch: (next: T) => Partial<T>
}

/**
 * 草稿-基线-指纹三件套：同一工作流轮询更新时保留未保存编辑；
 * 切换工作流或服务端确认提交后才重置。语义与 WorkflowSettingsPanel 完全一致。
 */
export const useRuntimeDraft = <T extends Record<string, string>>(
  run: Ref<WorkflowRun | null>,
  buildDraft: (run: WorkflowRun | null) => T
): RuntimeDraftController<T> => {
  const sourceDraft = computed(() => buildDraft(run.value))
  const fields = Object.keys(sourceDraft.value) as Array<keyof T>
  const fingerprint = (state: T) => JSON.stringify(fields.map(field => state[field]))

  const draft = reactive({ ...sourceDraft.value }) as T
  const baseline = ref({ ...sourceDraft.value }) as Ref<T>
  const submittedFingerprint = ref('')
  let activeRunId: number | null = null

  const resetDraft = (state: T) => {
    Object.assign(draft, state)
    baseline.value = { ...state }
  }

  const changedFields = computed(() =>
    fields.filter(field => draft[field] !== baseline.value[field])
  )
  const changedCount = computed(() => changedFields.value.length)

  watch(
    () => [run.value?.id || null, fingerprint(sourceDraft.value)] as const,
    ([runId, sourceFingerprint]) => {
      const switchedRun = runId !== activeRunId
      if (
        switchedRun ||
        !changedCount.value ||
        sourceFingerprint === submittedFingerprint.value
      ) {
        activeRunId = runId
        resetDraft(sourceDraft.value)
        if (switchedRun || sourceFingerprint === submittedFingerprint.value) {
          submittedFingerprint.value = ''
        }
      }
    },
    { immediate: true }
  )

  const discard = () => {
    submittedFingerprint.value = ''
    resetDraft(sourceDraft.value)
  }

  const markSubmitted = (next: T) => {
    submittedFingerprint.value = fingerprint(next)
  }

  const clearSubmitted = () => {
    submittedFingerprint.value = ''
  }

  const buildPatch = (next: T) =>
    fields.reduce<Partial<T>>((patch, field) => {
      if (next[field] !== baseline.value[field]) {
        patch[field] = next[field]
      }
      return patch
    }, {})

  return {
    draft,
    baseline,
    changedFields,
    changedCount,
    discard,
    markSubmitted,
    clearSubmitted,
    buildPatch,
  }
}
