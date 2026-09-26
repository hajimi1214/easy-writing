<template>
  <section class="ai-model-settings" :class="{ 'page-mode': mode === 'page' }">
    <div v-if="showHead" class="pane-head">
      <h3>AI模型</h3>
      <p>配置自己的供应商模型，并为写作、生图和工作流选择默认模型。</p>
    </div>

    <div class="provider-grid">
      <button
        v-for="preset in providerPresets"
        :key="preset.provider"
        type="button"
        class="provider-card"
        :class="{ active: form.provider === preset.provider }"
        :aria-pressed="form.provider === preset.provider"
        @click="applyProvider(preset)"
      >
        <span class="provider-icon" :class="{ 'is-custom': !preset.iconSrc }">
          <img v-if="preset.iconSrc" :src="preset.iconSrc" :alt="`${preset.label} logo`" loading="lazy" />
          <i v-else class="fa-solid fa-plus"></i>
        </span>
        <span class="provider-info">
          <strong>{{ preset.label }}</strong>
          <small>{{ preset.description }}</small>
        </span>
        <span v-if="form.provider === preset.provider" class="provider-check" aria-hidden="true">
          <i class="fa-solid fa-check"></i>
        </span>
      </button>
    </div>

    <div class="model-grid">
      <section class="model-card model-form-card">
        <div class="card-head">
          <div>
            <h4>{{ editingId ? '编辑模型' : '添加模型' }}</h4>
            <p>当前支持 OpenAI 兼容协议。</p>
          </div>
          <button v-if="editingId" class="ink-btn ink-btn-outline compact-btn" type="button" @click="resetForm">
            新增
          </button>
        </div>

        <div class="form-grid">
          <label class="field">
            <span>使用场景</span>
            <el-select v-model="form.scene" size="small" popper-class="ai-model-select-popper">
              <el-option label="文字生成" value="text" />
              <el-option label="图像生成" value="image" />
            </el-select>
          </label>
          <label class="field">
            <span>服务商</span>
            <el-select v-model="form.provider" size="small" popper-class="ai-model-select-popper">
              <el-option
                v-for="preset in providerPresets"
                :key="preset.provider"
                :label="preset.label"
                :value="preset.provider"
              />
            </el-select>
          </label>
          <label class="field">
            <span>模型名称</span>
            <el-input v-model="form.name" size="small" maxlength="80" placeholder="我的 DeepSeek" />
          </label>
          <label ref="modelCodeFieldRef" class="field model-code-field">
            <span>模型代码</span>
            <div class="model-code-control">
              <el-input
                v-model="form.modelCode"
                size="small"
                maxlength="120"
                placeholder="deepseek-chat"
                @focus="showRemoteModelPanel"
                @input="remoteModelPanelVisible = false"
              />
              <button
                class="fetch-model-btn"
                type="button"
                :disabled="remoteModelLoading"
                @click.prevent="fetchRemoteModels"
              >
                <i v-if="remoteModelLoading" class="fa-solid fa-spinner fa-spin"></i>
                <i v-else class="fa-solid fa-cloud-arrow-down"></i>
                拉取
              </button>
            </div>
            <div v-if="remoteModelPanelVisible" class="remote-model-panel">
              <button
                v-for="code in remoteModels"
                :key="code"
                type="button"
                :class="{ active: form.modelCode === code }"
                @click.prevent="selectRemoteModel(code)"
              >
                {{ code }}
              </button>
            </div>
          </label>
          <label class="field wide">
            <span>Base URL</span>
            <el-input v-model="form.baseUrl" size="small" maxlength="500" placeholder="https://api.example.com/v1" />
          </label>
          <label class="field">
            <span>API Key<small class="key-local-hint">（只保存在本机，不会上传）</small></span>
            <el-input
              v-model="form.apiKey"
              size="small"
              type="password"
              show-password
              :placeholder="editingId ? '留空则不修改' : '请输入 API Key'"
            />
          </label>
          <label class="field">
            <span>最大上下文</span>
            <el-input-number
              v-model="form.maxContext"
              size="small"
              :min="1024"
              :max="1000000"
              :step="1024"
              controls-position="right"
            />
          </label>
          <label class="field">
            <span>最大输出 Tokens</span>
            <el-input-number
              v-model="form.maxOutputTokens"
              size="small"
              :min="128"
              :max="form.maxContext"
              :step="512"
              controls-position="right"
            />
          </label>
        </div>

        <div class="form-footer">
          <el-switch v-model="modelEnabled" active-text="启用" inactive-text="禁用" />
          <div class="form-actions">
            <button class="ink-btn ink-btn-outline" type="button" :disabled="testingCurrent" @click="testCurrentModel">
              <i v-if="testingCurrent" class="fa-solid fa-spinner fa-spin"></i>
              <i v-else class="fa-solid fa-plug-circle-check"></i>
              测试连接
            </button>
            <button class="ink-btn ink-btn-primary" type="button" :disabled="saving" @click="saveModel">
              <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
              <i v-else class="fa-solid fa-floppy-disk"></i>
              保存模型
            </button>
          </div>
        </div>
      </section>

      <section class="model-card test-card">
        <div class="card-head">
          <div>
            <h4>连接测试</h4>
            <p>生图模型测试会真实请求供应商接口。</p>
          </div>
        </div>
        <div class="test-result" :class="testResultClass">
          <div class="test-icon">
            <i v-if="testingCurrent" class="fa-solid fa-spinner fa-spin"></i>
            <i v-else-if="testResult?.ok" class="fa-solid fa-check"></i>
            <i v-else-if="testResult" class="fa-solid fa-xmark"></i>
            <i v-else class="fa-solid fa-signal"></i>
          </div>
          <div class="test-body">
            <strong>{{ testResultTitle }}</strong>
            <span>{{ testResultMessage }}</span>
          </div>
        </div>
        <dl class="test-meta">
          <div>
            <dt>请求地址</dt>
            <dd :title="testResult?.url || form.baseUrl">{{ testResult?.url || form.baseUrl || '-' }}</dd>
          </div>
          <div>
            <dt>耗时</dt>
            <dd>{{ testResult?.latency ? `${testResult.latency}ms` : '-' }}</dd>
          </div>
          <div>
            <dt>测试时间</dt>
            <dd>{{ testResult?.testedAt || '-' }}</dd>
          </div>
        </dl>
      </section>
    </div>

    <section class="model-card default-card">
      <div class="card-head inline-head">
        <div>
          <h4>默认模型</h4>
          <p>保存到当前账号，所有 AI 调用会优先使用该模型。</p>
        </div>
        <button class="ink-btn ink-btn-outline compact-btn" type="button" @click="refreshModels">
          刷新
        </button>
      </div>
      <div class="default-grid">
        <label class="field">
          <span>写作助手</span>
          <el-select v-model="textModelValue" size="small" class="model-select" popper-class="ai-model-select-popper">
            <template #prefix>
              <span class="model-select-prefix">
                <img v-if="getSelectedModelIcon('text_assist')" :src="getSelectedModelIcon('text_assist')" alt="" />
                <i v-else class="fa-solid fa-wand-magic-sparkles"></i>
              </span>
            </template>
            <el-option label="智能推荐" value="">
              <span class="model-select-option">
                <span class="model-option-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
                <span>智能推荐</span>
              </span>
            </el-option>
            <el-option
              v-for="model in aiModelStore.textModels"
              :key="model.code"
              :label="getModelOptionLabel(model)"
              :value="model.code"
            >
              <span class="model-select-option">
                <span class="model-option-icon">
                  <img v-if="getModelProviderIcon(model)" :src="getModelProviderIcon(model)" alt="" />
                  <i v-else class="fa-solid fa-cube"></i>
                </span>
                <span class="model-option-copy">
                  <span class="model-option-name">{{ getModelOptionLabel(model) }}</span>
                  <span v-if="model.description" class="model-option-desc">{{ model.description }}</span>
                </span>
              </span>
            </el-option>
          </el-select>
        </label>
        <label class="field">
          <span>工作流建书</span>
          <el-select v-model="workflowModelValue" size="small" class="model-select" popper-class="ai-model-select-popper">
            <template #prefix>
              <span class="model-select-prefix">
                <img v-if="getSelectedModelIcon('workflow_book')" :src="getSelectedModelIcon('workflow_book')" alt="" />
                <i v-else class="fa-solid fa-wand-magic-sparkles"></i>
              </span>
            </template>
            <el-option label="智能推荐" value="">
              <span class="model-select-option">
                <span class="model-option-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
                <span>智能推荐</span>
              </span>
            </el-option>
            <el-option
              v-for="model in aiModelStore.workflowModels"
              :key="model.code"
              :label="getModelOptionLabel(model)"
              :value="model.code"
            >
              <span class="model-select-option">
                <span class="model-option-icon">
                  <img v-if="getModelProviderIcon(model)" :src="getModelProviderIcon(model)" alt="" />
                  <i v-else class="fa-solid fa-cube"></i>
                </span>
                <span class="model-option-copy">
                  <span class="model-option-name">{{ getModelOptionLabel(model) }}</span>
                  <span v-if="model.description" class="model-option-desc">{{ model.description }}</span>
                </span>
              </span>
            </el-option>
          </el-select>
        </label>
        <label class="field">
          <span>审核模型</span>
          <el-select v-model="reviewModelValue" size="small" class="model-select" popper-class="ai-model-select-popper">
            <template #prefix>
              <span class="model-select-prefix">
                <img v-if="getSelectedModelIcon('workflow_review')" :src="getSelectedModelIcon('workflow_review')" alt="" />
                <i v-else class="fa-solid fa-clipboard-check"></i>
              </span>
            </template>
            <el-option label="跟随写作模型" value="">
              <span class="model-select-option">
                <span class="model-option-icon"><i class="fa-solid fa-clipboard-check"></i></span>
                <span>跟随写作模型</span>
              </span>
            </el-option>
            <el-option
              v-for="model in aiModelStore.reviewModels"
              :key="model.code"
              :label="getModelOptionLabel(model)"
              :value="model.code"
            >
              <span class="model-select-option">
                <span class="model-option-icon">
                  <img v-if="getModelProviderIcon(model)" :src="getModelProviderIcon(model)" alt="" />
                  <i v-else class="fa-solid fa-cube"></i>
                </span>
                <span class="model-option-copy">
                  <span class="model-option-name">{{ getModelOptionLabel(model) }}</span>
                  <span v-if="model.description" class="model-option-desc">{{ model.description }}</span>
                </span>
              </span>
            </el-option>
          </el-select>
        </label>
        <label class="field">
          <span>图像生成</span>
          <el-select v-model="imageModelValue" size="small" class="model-select" popper-class="ai-model-select-popper">
            <template #prefix>
              <span class="model-select-prefix">
                <img v-if="getSelectedModelIcon('image_generation')" :src="getSelectedModelIcon('image_generation')" alt="" />
                <i v-else class="fa-solid fa-image"></i>
              </span>
            </template>
            <el-option label="智能推荐" value="">
              <span class="model-select-option">
                <span class="model-option-icon"><i class="fa-solid fa-image"></i></span>
                <span>智能推荐</span>
              </span>
            </el-option>
            <el-option
              v-for="model in aiModelStore.imageModels"
              :key="model.code"
              :label="getModelOptionLabel(model)"
              :value="model.code"
            >
              <span class="model-select-option">
                <span class="model-option-icon">
                  <img v-if="getModelProviderIcon(model)" :src="getModelProviderIcon(model)" alt="" />
                  <i v-else class="fa-solid fa-cube"></i>
                </span>
                <span class="model-option-copy">
                  <span class="model-option-name">{{ getModelOptionLabel(model) }}</span>
                  <span v-if="model.description" class="model-option-desc">{{ model.description }}</span>
                </span>
              </span>
            </el-option>
          </el-select>
        </label>
      </div>
      <p class="grid-tip">审核模型用于闸三 AI 评审（挑错），写作模型用于生成与改稿；留空即跟随写作模型。</p>
    </section>

    <section class="model-card list-card">
      <div class="list-toolbar">
        <div>
          <h4>我的模型列表</h4>
          <p>{{ filteredModels.length }} 个模型</p>
        </div>
        <div class="list-filters">
          <el-input v-model="keyword" size="small" clearable placeholder="搜索名称或代码">
            <template #prefix>
              <i class="fa-solid fa-magnifying-glass"></i>
            </template>
          </el-input>
          <el-select v-model="statusFilter" size="small" popper-class="ai-model-select-popper">
            <el-option label="全部状态" value="all" />
            <el-option label="启用" value="enabled" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </div>
      </div>

      <div v-if="loading" class="empty-state">模型加载中...</div>
      <div v-else-if="!filteredModels.length" class="empty-state">暂无自定义模型</div>
      <div v-else class="model-table-wrap">
        <table class="model-table">
          <thead>
            <tr>
              <th>模型名称</th>
              <th>模型代码</th>
              <th>场景</th>
              <th>状态</th>
              <th>测试</th>
              <th>接口</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in filteredModels" :key="model.code">
              <td>
                <strong class="cell-title" :title="model.name">{{ model.name }}</strong>
                <small>{{ getProviderLabel(model.provider) }}</small>
              </td>
              <td class="mono-cell" :title="model.modelCode || model.code">{{ model.modelCode || model.code }}</td>
              <td>{{ sceneLabels[model.scene] || model.scene }}</td>
              <td>
                <span class="status-pill" :class="model.status === 1 ? 'enabled' : 'disabled'">
                  {{ model.status === 1 ? '启用' : '禁用' }}
                </span>
              </td>
              <td>
                <span class="status-pill" :class="getTestClass(model.testStatus)">
                  {{ getTestLabel(model.testStatus) }}
                </span>
                <small v-if="model.lastLatency">{{ model.lastLatency }}ms</small>
              </td>
              <td class="url-cell" :title="model.baseUrl || ''">
                {{ model.baseUrl || '-' }}
                <small v-if="model.lastError" class="error-text">{{ model.lastError }}</small>
              </td>
              <td>
                <div class="row-actions">
                  <button type="button" :disabled="testingRowId === model.id" @click="testRowModel(model)">
                    {{ testingRowId === model.id ? '测试中' : '测试' }}
                  </button>
                  <button type="button" @click="editModel(model)">编辑</button>
                  <button type="button" @click="toggleStatus(model)">
                    {{ model.status === 1 ? '禁用' : '启用' }}
                  </button>
                  <button type="button" class="danger" @click="deleteModel(model)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { showApiError } from '@/utils/api-error'
import type { AiModelGroupCode, AiModelOption } from '@/types/ai-model'
// 开源版：BYOK 模型走本地库+直连供应商（@/storage/local-ai-models + @/utils/local-ai-client），
// 函数形状对齐原服务端接口，调用点不动；API Key 只存本机
import {
  deleteLocalAiModel as deleteUserAiModelApi,
  listLocalAiModels as getUserAiModelsApi,
  saveLocalAiModel as saveUserAiModelApi,
  setLocalAiModelStatus as setUserAiModelStatusApi,
} from '@/storage/local-ai-models'
import {
  listLocalAiRemoteModels as listUserAiRemoteModelsApi,
  testLocalAiModel as testUserAiModelApi,
} from '@/utils/local-ai-client'
import type { UserAiModelSavePayload, UserAiModelTestResult } from '@/types/user-ai-model'
import { useAiModelStore } from '@/stores/ai-model'

type ProviderPreset = {
  label: string
  provider: string
  baseUrl: string
  icon: string
  iconSrc?: string
  description: string
}

withDefaults(defineProps<{
  showHead?: boolean
  mode?: 'pane' | 'page'
}>(), {
  showHead: true,
  mode: 'pane',
})

const providerPresets: ProviderPreset[] = [
  { label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', icon: 'AI', iconSrc: '/provider-icons/openai.svg', description: 'OpenAI 兼容接口' },
  { label: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', icon: 'DS', iconSrc: '/provider-icons/deepseek.ico', description: 'DeepSeek 官方接口' },
  { label: 'MiniMax', provider: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', icon: 'MM', iconSrc: '/provider-icons/minimax.ico', description: 'MiniMax 官方接口' },
  { label: '通义千问', provider: 'aliyun', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', icon: 'QW', iconSrc: '/provider-icons/tongyi.svg', description: '阿里百炼兼容接口' },
  { label: '火山方舟', provider: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', icon: 'ARK', iconSrc: '/provider-icons/volcengine.png', description: '豆包/方舟兼容接口' },
  { label: '智谱', provider: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', icon: 'GLM', iconSrc: '/provider-icons/bigmodel.png', description: '智谱开放平台' },
  { label: '硅基流动', provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', icon: 'SF', iconSrc: '/provider-icons/siliconflow.ico', description: '多模型聚合接口' },
  { label: 'OpenRouter', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', icon: 'OR', iconSrc: '/provider-icons/openrouter.ico', description: '路由聚合接口' },
  { label: 'Gemini兼容', provider: 'gemini_openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', icon: 'G', iconSrc: '/provider-icons/gemini.svg', description: 'Google 兼容接口' },
  { label: 'Claude', provider: 'claude', baseUrl: 'https://api.anthropic.com/v1', icon: 'C', iconSrc: '/provider-icons/claude.svg', description: 'Anthropic Claude 接口' },
  { label: 'xAI Grok', provider: 'xai', baseUrl: 'https://api.x.ai/v1', icon: 'X', iconSrc: '/provider-icons/xai.svg', description: 'xAI Grok 接口' },
  { label: '自定义', provider: 'custom', baseUrl: '', icon: '+', description: '自定义兼容接口' },
]

const sceneLabels: Record<string, string> = {
  text: '文字',
  image: '生图',
}

const aiModelStore = useAiModelStore()
const loading = ref(false)
const saving = ref(false)
const testingCurrent = ref(false)
const testingRowId = ref<number | null>(null)
const remoteModelLoading = ref(false)
const remoteModelPanelVisible = ref(false)
const modelCodeFieldRef = ref<HTMLElement | null>(null)
const editingId = ref<number | null>(null)
const models = ref<AiModelOption[]>([])
const remoteModels = ref<string[]>([])
const keyword = ref('')
const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all')
const testResult = ref<UserAiModelTestResult | null>(null)

const form = reactive<UserAiModelSavePayload>({
  name: '',
  scene: 'text',
  provider: 'openai',
  protocol: 'openai_compatible',
  modelCode: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  maxContext: 128000,
  maxOutputTokens: 8192,
  status: 1,
  sort: 0,
})

const modelEnabled = computed({
  get: () => form.status === 1,
  set: value => {
    form.status = value ? 1 : 0
  },
})

const textModelValue = computed({
  get: () => aiModelStore.textModel,
  set: value => {
    void aiModelStore.setTextModel(String(value || ''))
  },
})

const workflowModelValue = computed({
  get: () => aiModelStore.workflowModel,
  set: value => {
    void aiModelStore.setWorkflowModel(String(value || ''))
  },
})

const reviewModelValue = computed({
  get: () => aiModelStore.reviewModel,
  set: value => {
    void aiModelStore.setReviewModel(String(value || ''))
  },
})

const imageModelValue = computed({
  get: () => aiModelStore.imageModel,
  set: value => {
    void aiModelStore.setImageModel(String(value || ''))
  },
})

const filteredModels = computed(() => {
  const term = keyword.value.trim().toLowerCase()
  return models.value.filter(model => {
    if (statusFilter.value === 'enabled' && model.status !== 1) return false
    if (statusFilter.value === 'disabled' && model.status === 1) return false
    if (!term) return true
    return `${model.name} ${model.modelCode || model.code} ${model.provider || ''}`.toLowerCase().includes(term)
  })
})

const testResultClass = computed(() => {
  if (testingCurrent.value) return 'testing'
  if (!testResult.value) return 'idle'
  return testResult.value.ok ? 'success' : 'error'
})

const testResultTitle = computed(() => {
  if (testingCurrent.value) return '正在测试'
  if (!testResult.value) return '等待测试'
  return testResult.value.ok ? '连接成功' : '连接失败'
})

const testResultMessage = computed(() => {
  if (testingCurrent.value) return '正在请求供应商接口'
  if (!testResult.value) return '保存前可先测试当前配置'
  return testResult.value.message
})

onMounted(async () => {
  document.addEventListener('click', closeRemoteModelPanelOnOutside)
  await refreshModels()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeRemoteModelPanelOnOutside)
})

const applyProvider = (preset: ProviderPreset) => {
  form.provider = preset.provider
  if (preset.baseUrl) form.baseUrl = preset.baseUrl
  testResult.value = null
  clearRemoteModels()
}

const refreshModels = async () => {
  loading.value = true
  try {
    const { data } = await getUserAiModelsApi()
    models.value = data || []
    await aiModelStore.loadAll(true)
  } catch (error) {
    showApiError(error, '加载模型失败')
  } finally {
    loading.value = false
  }
}

const saveModel = async () => {
  if (!validateForm()) return
  saving.value = true
  try {
    const payload = buildPayload()
    const { data } = await saveUserAiModelApi(payload)
    ElMessage.success(editingId.value ? '模型已更新' : '模型已保存')
    editingId.value = data?.id || null
    form.apiKey = ''
    await refreshModels()
  } catch (error) {
    showApiError(error, '保存模型失败')
  } finally {
    saving.value = false
  }
}

const testCurrentModel = async () => {
  if (!validateForm(true)) return
  testingCurrent.value = true
  try {
    const { data } = await testUserAiModelApi(buildPayload())
    testResult.value = data || null
    if (data?.ok) {
      ElMessage.success('连接成功')
    } else {
      ElMessage.error(data?.message || '连接失败')
    }
    await refreshModels()
  } catch (error) {
    showApiError(error, '连接测试失败')
  } finally {
    testingCurrent.value = false
  }
}

const testRowModel = async (model: AiModelOption) => {
  testingRowId.value = model.id
  try {
    const { data } = await testUserAiModelApi({ id: model.id })
    testResult.value = data || null
    if (data?.ok) {
      ElMessage.success('连接成功')
    } else {
      ElMessage.error(data?.message || '连接失败')
    }
    await refreshModels()
  } catch (error) {
    showApiError(error, '连接测试失败')
  } finally {
    testingRowId.value = null
  }
}

const fetchRemoteModels = async () => {
  // 模型列表由服务端代理拉取，输入框仍保留手动填写能力。
  if (!validateRemoteModelFetch()) return
  remoteModelLoading.value = true
  remoteModelPanelVisible.value = false
  try {
    const { data } = await listUserAiRemoteModelsApi(buildRemoteModelPayload())
    remoteModels.value = data?.models || []
    remoteModelPanelVisible.value = remoteModels.value.length > 0
    if (remoteModels.value.length) {
      ElMessage.success(`已拉取 ${remoteModels.value.length} 个模型`)
    } else {
      ElMessage.info('未拉取到模型列表')
    }
  } catch (error) {
    showApiError(error, '拉取模型列表失败')
  } finally {
    remoteModelLoading.value = false
  }
}

const selectRemoteModel = (code: string) => {
  form.modelCode = code
  remoteModelPanelVisible.value = false
}

const showRemoteModelPanel = () => {
  remoteModelPanelVisible.value = remoteModels.value.length > 0
}

const closeRemoteModelPanelOnOutside = (event: MouseEvent) => {
  if (!remoteModelPanelVisible.value) return
  const target = event.target as Node | null
  if (target && modelCodeFieldRef.value?.contains(target)) return
  // 点击字段外部时收起浮层，避免遮挡后续表单。
  remoteModelPanelVisible.value = false
}

const editModel = (model: AiModelOption) => {
  editingId.value = model.id
  form.name = model.name || ''
  form.scene = model.scene === 'image' ? 'image' : 'text'
  form.provider = model.provider || 'custom'
  form.protocol = 'openai_compatible'
  form.modelCode = model.modelCode || ''
  form.baseUrl = model.baseUrl || ''
  form.apiKey = ''
  form.maxContext = Number(model.maxContext || 4096)
  form.maxOutputTokens = Number(model.maxOutputTokens || 8192)
  form.status = model.status === 0 ? 0 : 1
  testResult.value = null
  clearRemoteModels()
  ElMessage.info('API Key 留空则不修改')
}

const toggleStatus = async (model: AiModelOption) => {
  try {
    await setUserAiModelStatusApi(model.id, model.status === 1 ? 0 : 1)
    ElMessage.success(model.status === 1 ? '已禁用' : '已启用')
    await refreshModels()
  } catch (error) {
    showApiError(error, '状态更新失败')
  }
}

const deleteModel = async (model: AiModelOption) => {
  try {
    await inkConfirm(`确定删除「${model.name}」吗？`, '删除模型', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await deleteUserAiModelApi(model.id)
    ElMessage.success('模型已删除')
    if (editingId.value === model.id) resetForm()
    await refreshModels()
  } catch (error) {
    showApiError(error, '删除模型失败')
  }
}

const resetForm = () => {
  editingId.value = null
  form.name = ''
  form.scene = 'text'
  form.provider = 'openai'
  form.protocol = 'openai_compatible'
  form.modelCode = ''
  form.baseUrl = 'https://api.openai.com/v1'
  form.apiKey = ''
  form.maxContext = 128000
  form.maxOutputTokens = 8192
  form.status = 1
  form.sort = 0
  testResult.value = null
  clearRemoteModels()
}

const buildPayload = (): UserAiModelSavePayload => ({
  id: editingId.value || undefined,
  name: form.name.trim(),
  scene: form.scene,
  provider: form.provider,
  protocol: 'openai_compatible',
  modelCode: form.modelCode.trim(),
  baseUrl: form.baseUrl.trim(),
  apiKey: form.apiKey?.trim() || undefined,
  maxContext: Number(form.maxContext || 4096),
  maxOutputTokens: Number(form.maxOutputTokens || 8192),
  status: form.status,
  sort: Number(form.sort || 0),
})

const buildRemoteModelPayload = (): Partial<UserAiModelSavePayload> => ({
  id: editingId.value || undefined,
  scene: form.scene,
  provider: form.provider,
  protocol: 'openai_compatible',
  modelCode: form.modelCode.trim(),
  baseUrl: form.baseUrl.trim(),
  apiKey: form.apiKey?.trim() || undefined,
  maxContext: Number(form.maxContext || 4096),
  maxOutputTokens: Number(form.maxOutputTokens || 8192),
  status: form.status,
  sort: Number(form.sort || 0),
})

const validateRemoteModelFetch = () => {
  if (!form.baseUrl.trim()) {
    ElMessage.warning('请填写 Base URL')
    return false
  }
  if (
    !Number.isInteger(Number(form.maxOutputTokens)) ||
    Number(form.maxOutputTokens) < 128 ||
    Number(form.maxOutputTokens) > Number(form.maxContext)
  ) {
    ElMessage.warning('最大输出 Tokens 必须为 128 到最大上下文之间的整数')
    return false
  }
  if (!editingId.value && !form.apiKey?.trim()) {
    ElMessage.warning('拉取前请填写 API Key')
    return false
  }
  return true
}

const clearRemoteModels = () => {
  remoteModels.value = []
  remoteModelPanelVisible.value = false
}

const validateForm = (forTest = false) => {
  if (!form.name.trim()) {
    ElMessage.warning('请填写模型名称')
    return false
  }
  if (!form.modelCode.trim()) {
    ElMessage.warning('请填写模型代码')
    return false
  }
  if (!form.baseUrl.trim()) {
    ElMessage.warning('请填写 Base URL')
    return false
  }
  if (
    !Number.isInteger(Number(form.maxOutputTokens)) ||
    Number(form.maxOutputTokens) < 128 ||
    Number(form.maxOutputTokens) > Number(form.maxContext)
  ) {
    ElMessage.warning('最大输出 Tokens 必须为 128 到最大上下文之间的整数')
    return false
  }
  if (!editingId.value && !form.apiKey?.trim()) {
    ElMessage.warning(forTest ? '测试前请填写 API Key' : '请填写 API Key')
    return false
  }
  return true
}

const getProviderLabel = (provider?: string) => {
  return providerPresets.find(item => item.provider === provider)?.label || provider || '自定义'
}

const normalizeProvider = (provider?: string, code?: string) => {
  const raw = `${provider || ''} ${code || ''}`.toLowerCase()
  // claude/gemini 必须先于 openai 判断：provider 值 gemini_openai、代码 openai-gpt-*
  // 都含 "openai" 字样，顺序反了会全部套上 OpenAI 图标
  if (raw.includes('claude') || raw.includes('anthropic')) return 'claude'
  if (raw.includes('gemini')) return 'gemini_openai'
  if (raw.includes('grok') || raw.includes('xai')) return 'xai'
  if (raw.includes('deepseek')) return 'deepseek'
  if (raw.includes('openai') || raw.includes('gpt')) return 'openai'
  if (raw.includes('qwen') || raw.includes('tongyi') || raw.includes('aliyun')) return 'aliyun'
  if (raw.includes('doubao') || raw.includes('volc') || raw.includes('ark')) return 'volcengine'
  if (raw.includes('glm') || raw.includes('zhipu') || raw.includes('bigmodel')) return 'bigmodel'
  if (raw.includes('silicon')) return 'siliconflow'
  if (raw.includes('openrouter')) return 'openrouter'
  return provider || 'custom'
}

const getModelProviderIcon = (model?: AiModelOption | null) => {
  if (!model) return ''
  const provider = normalizeProvider(model.provider, `${model.name || ''} ${model.modelCode || model.code || ''}`)
  return providerPresets.find(item => item.provider === provider)?.iconSrc || ''
}

const getModelOptionLabel = (model: AiModelOption) => {
  const name = model.name || model.modelCode || model.code
  return model.ownerType === 'user' ? `${name} · 自定义` : name
}

const getSelectedModel = (groupCode: AiModelGroupCode) => {
  const selectedCode = groupCode === 'text_assist'
    ? aiModelStore.textModel
    : groupCode === 'workflow_book'
      ? aiModelStore.workflowModel
      : groupCode === 'workflow_review'
        ? aiModelStore.reviewModel
        : aiModelStore.imageModel
  const models = aiModelStore.groups[groupCode]?.models || []
  return models.find(item => item.code === selectedCode) || aiModelStore.groups[groupCode]?.defaultModel || null
}

const getSelectedModelIcon = (groupCode: AiModelGroupCode) => {
  return getModelProviderIcon(getSelectedModel(groupCode))
}

const getTestLabel = (status?: number) => {
  if (status === 1) return '已连接'
  if (status === 2) return '失败'
  return '未测试'
}

const getTestClass = (status?: number) => {
  if (status === 1) return 'success'
  if (status === 2) return 'error'
  return 'idle'
}
</script>

<style scoped lang="scss">
.ai-model-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--ink-main);
}

.pane-head {
  h3 {
    margin: 0 0 8px;
    font-size: 18px;
    line-height: 1.4;
  }

  p {
    margin: 0;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: 13px;
    line-height: 1.7;
  }
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: 12px;
}

.provider-card,
.model-card {
  border: 1px solid var(--ui-border);
  background: var(--card-bg, var(--ui-glass-bg));
  box-shadow: var(--card-shadow, var(--ui-shadow));
  backdrop-filter: blur(12px);
}

.provider-card {
  position: relative;
  min-height: 84px;
  padding: 14px 38px 14px 14px;
  border-radius: 8px;
  color: var(--ink-main);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  overflow: hidden;
  transition: border-color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease;

  &::before {
    position: absolute;
    left: 0;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 0 999px 999px 0;
    background: var(--ink-accent);
    opacity: 0;
    content: '';
  }

  &:hover {
    border-color: var(--ink-accent);
    background: var(--card-bg-hover, var(--ui-glass-bg-hover));
    box-shadow: 0 12px 28px color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }

  &.active {
    border-color: var(--ink-accent);
    background: linear-gradient(135deg, rgba(var(--ink-accent-rgb, 180, 100, 40), 0.08), transparent 56%), var(--card-bg-hover, var(--ui-glass-bg-hover));
    box-shadow: inset 0 0 0 1px var(--ink-accent), 0 12px 30px rgba(var(--ink-accent-rgb, 180, 100, 40), 0.14), var(--card-shadow, var(--ui-shadow));

    &::before {
      opacity: 1;
    }
  }
}

.provider-icon {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--input-bg) 82%, var(--bg-main) 18%);
  border: 1px solid color-mix(in srgb, var(--input-border) 72%, var(--bg-main) 28%);
  color: var(--ink-accent);
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bg-main) 72%, transparent);

  img {
    display: block;
    width: 34px;
    height: 34px;
    object-fit: contain;
  }

  &.is-custom {
    background: rgba(var(--ink-accent-rgb, 180, 100, 40), 0.1);
    border-color: rgba(var(--ink-accent-rgb, 180, 100, 40), 0.24);
  }
}

.provider-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;

  strong,
  small {
    display: block;
    overflow-wrap: anywhere;
  }

  strong {
    font-size: 13px;
    line-height: 1.35;
  }

  small {
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: 11px;
    line-height: 1.45;
  }
}

.provider-check {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: var(--ink-accent);
  color: var(--btn-primary-color, #fff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  box-shadow: 0 6px 16px rgba(var(--ink-accent-rgb, 180, 100, 40), 0.24);
}

.model-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
  gap: 12px;
}

.model-card {
  border-radius: 8px;
  padding: 14px;
  min-width: 0;
}

.card-head,
.list-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;

  h4 {
    margin: 0 0 4px;
    font-size: 15px;
    line-height: 1.4;
  }

  p {
    margin: 0;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: 12px;
    line-height: 1.6;
  }
}

.form-grid,
.default-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
  margin-top: 12px;
}

.default-grid {
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
}

.grid-tip {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--settings-muted-color, var(--ink-sec));
}

.model-select {
  width: 100%;

  :deep(.el-select__wrapper) {
    min-height: 36px;
    padding-left: 9px;
  }
}

.model-select-prefix,
.model-option-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--input-bg) 78%, var(--bg-main));
  border: 1px solid color-mix(in srgb, var(--input-border) 76%, transparent);
  color: var(--ink-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;

  img {
    display: block;
    width: 21px;
    height: 21px;
    object-fit: contain;
  }

  i {
    font-size: 13px;
  }
}

.model-select-option {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  line-height: 1;

  > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &.wide {
    grid-column: 1 / -1;
  }

  span {
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: 12px;
    font-weight: 600;
  }
}

.model-code-field {
  position: relative;
  z-index: 12;
}

.model-code-control {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.fetch-model-btn {
  min-width: 72px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: var(--settings-control-bg, var(--input-bg));
  color: var(--ink-accent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;

  &:hover:not(:disabled) {
    border-color: var(--ink-accent);
    background: var(--settings-control-hover-bg, var(--input-focus-bg));
  }

  &:disabled {
    color: var(--settings-muted-color, var(--ink-sec));
    cursor: not-allowed;
  }
}

/* 模型列表使用浮层，避免撑开表单布局。 */
.remote-model-panel {
  position: absolute;
  z-index: 24;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  max-height: 178px;
  overflow: auto;
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--bg-main);
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.14);

  button {
    min-width: 0;
    min-height: 28px;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--ink-main);
    cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
    overflow-wrap: anywhere;

    &:hover,
    &.active {
      border-color: var(--ink-accent);
      background: var(--nav-active-bg);
      color: var(--nav-active-color, var(--ink-main));
    }
  }
}

.form-footer {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.compact-btn {
  min-height: 30px;
  padding: 0 12px;
  font-size: 12px;
}

.test-card {
  display: flex;
  flex-direction: column;
}

.test-result {
  margin-top: 14px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  display: flex;
  gap: 10px;
  align-items: center;

  &.success {
    border-color: var(--state-success-border);
    background: var(--state-success-surface);
    color: var(--state-success-on);
  }

  &.error {
    border-color: var(--state-danger-border);
    background: var(--state-danger-surface);
    color: var(--state-danger-on);
  }

  &.testing {
    border-color: var(--state-warning-border);
    background: var(--state-warning-surface);
    color: var(--state-warning-on);
  }
}

.test-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid currentColor;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.test-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    font-size: 12px;
  }
}

.test-meta {
  margin: 12px 0 0;
  display: grid;
  gap: 8px;

  div {
    display: grid;
    grid-template-columns: 70px minmax(0, 1fr);
    gap: 8px;
  }

  dt,
  dd {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
  }

  dt {
    color: var(--settings-muted-color, var(--ink-sec));
  }

  dd {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.inline-head {
  align-items: center;
}

.list-toolbar {
  align-items: center;
}

.list-filters {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 118px;
  gap: 8px;
  width: min(420px, 50%);
}

.empty-state {
  margin-top: 12px;
  padding: 28px 12px;
  border-radius: 8px;
  border: 1px dashed var(--input-border);
  color: var(--settings-muted-color, var(--ink-sec));
  text-align: center;
  font-size: 13px;
}

.model-table-wrap {
  margin-top: 12px;
  overflow-x: auto;
}

.model-table {
  width: 100%;
  min-width: 820px;
  border-collapse: collapse;
  font-size: 12px;

  th,
  td {
    padding: 9px 8px;
    border-bottom: 1px solid var(--ui-border);
    text-align: left;
    vertical-align: middle;
  }

  th {
    color: var(--settings-muted-color, var(--ink-sec));
    font-weight: 600;
    white-space: nowrap;
  }

  td {
    color: var(--ink-main);
  }

  small {
    display: block;
    margin-top: 3px;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: 11px;
  }
}

.cell-title,
.mono-cell,
.url-cell {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-title {
  display: block;
}

.mono-cell {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.url-cell {
  max-width: 160px;
}

.error-text {
  color: var(--state-danger) !important;
}

.status-pill {
  min-width: 52px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--settings-muted-color, var(--ink-sec));
  white-space: nowrap;

  &.enabled,
  &.success {
    border-color: var(--state-success-border);
    background: var(--state-success-surface);
    color: var(--state-success-on);
  }

  &.disabled,
  &.error {
    border-color: var(--state-danger-border);
    background: var(--state-danger-surface);
    color: var(--state-danger-on);
  }
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;

  button {
    border: 0;
    background: transparent;
    color: var(--ink-accent);
    cursor: pointer;
    font-size: 12px;

    &:disabled {
      color: var(--settings-muted-color, var(--ink-sec));
      cursor: not-allowed;
    }

    &.danger {
      color: var(--state-danger);
    }
  }
}

:deep(.el-input__wrapper),
:deep(.el-select__wrapper) {
  min-height: 34px;
  border-radius: 7px;
  background: var(--input-bg);
  box-shadow: 0 0 0 1px var(--input-border) inset;
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-select__wrapper.is-focused) {
  background: var(--input-focus-bg);
  box-shadow: 0 0 0 1px var(--input-focus-border) inset;
}

:deep(.el-input-number) {
  width: 100%;
}

:global(.ai-model-select-popper .el-select-dropdown__item) {
  // 两行选项（模型名 + 卖点备注）需要自适应高度
  height: auto;
  min-height: 38px;
  padding: 5px 12px;
  border-radius: 6px;
  line-height: 1.45;
  // 弹层底色是主题玻璃色，选项文字必须跟主题走，不能用 element-plus 浅色默认值
  color: var(--ink-sec);
}

:global(.ai-model-select-popper .model-option-copy) {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

:global(.ai-model-select-popper .model-option-desc) {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.72;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:global(.ai-model-select-popper .el-select-dropdown__item.is-selected) {
  color: var(--ink-accent);
  font-weight: 600;
  background: var(--selection-bg-color);
}

:global(.ai-model-select-popper) {
  border: 1px solid var(--ui-border) !important;
  border-radius: 8px !important;
  background: var(--ui-glass-bg) !important;
  box-shadow: 0 18px 48px color-mix(in srgb, var(--ink-main) 20%, transparent) !important;
  backdrop-filter: blur(18px);
  overflow: hidden;
}

:global(.ai-model-select-popper .el-select-dropdown__list) {
  padding: 6px !important;
}

:global(.ai-model-select-popper .el-select-dropdown__item.hover),
:global(.ai-model-select-popper .el-select-dropdown__item:hover) {
  background: var(--nav-active-bg);
  color: var(--ink-accent);
}

:global(.ai-model-select-popper .model-select-option) {
  width: 100%;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

:global(.ai-model-select-popper .model-option-icon) {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--ink-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
}

:global(.ai-model-select-popper .model-option-icon img) {
  width: 21px;
  height: 21px;
  object-fit: contain;
}

:global(.ai-model-select-popper .el-popper__arrow::before) {
  background: var(--ui-glass-bg) !important;
  border-color: var(--ui-border) !important;
}

@media (max-width: 920px) {
  .provider-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .model-grid,
  .default-grid {
    grid-template-columns: 1fr;
  }

  .list-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .list-filters {
    width: 100%;
  }
}

@media (max-width: 560px) {
  .provider-grid {
    grid-template-columns: 1fr;
  }

  .provider-card {
    min-height: 72px;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .model-code-control {
    grid-template-columns: 1fr;
  }

  .fetch-model-btn {
    width: 100%;
  }
}

.key-local-hint {
  margin-left: 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--ink-sec);
}
</style>
