
export type AiModelGroupCode = 'text_assist' | 'workflow_book' | 'workflow_review' | 'image_generation'

export interface AiModelOption {
  id: number
  name: string
  code: string
  modelCode?: string
  scene: 'text' | 'image' | string
  provider?: string
  description?: string
  protocol?: string
  baseUrl?: string
  ownerType?: 'user'
  isMine?: boolean
  isDefault?: boolean
  maxContext?: number
  maxOutputTokens?: number
  status?: number
  testStatus?: number
  lastTestAt?: string
  lastLatency?: number | null
  lastError?: string
  apiKeyMask?: string
}

export interface AiModelPolicyOption {
  groupCode: AiModelGroupCode | string
  groupName: string
  scene: 'text' | 'image' | string
  defaultModelId?: number | null
  selectableModelIds?: number[]
  allowUserSelect: boolean
  lockOnFirstUse: boolean
  status: number
}

export interface AiModelOptionsResult {
  policy: AiModelPolicyOption | null
  defaultModel: AiModelOption | null
  selectedModelCode?: string
  selectedModel?: AiModelOption | null
  models: AiModelOption[]
}
