import type { LocalChatMessageInput } from '@/utils/local-ai-client'
import { promptText, renderPromptText } from '@/storage/local-prompts'

/**
 * 逐章自动生文的提示词库（工作流建书第五步起的所有 AI 调用）。
 *
 * 与 ai-prompts.ts 的分工：那边是写作台小件（润色/取名/灵感等），
 * 这边是工作流引擎专用（章纲规划、细纲、正文流式、重写、调整）。
 * 素材文本由引擎组装好传入，组装器只负责拼消息，保持纯函数可测。
 */

const materialBlock = (materials: Record<string, string>) =>
  Object.entries(materials)
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `【${key}】\n${String(value).trim()}`)
    .join('\n\n')

// 平台级硬护栏不放在可编辑提示词槽位里：旧项目即使缓存了上一版默认提示词，
// 也会立刻得到结构去重约束；用户自定义提示词仍可保留，但不能关闭交付底线。
const CONTENT_STRUCTURE_GUARD = '【平台结构去重】对照近期章纲，不得连续复用“发现物证—检查痕迹—问答确认—转往新地点”或其他同构事件链；若章纲必须调查，必须改变取证方式、阻力或结算结果，并结算一条旧信息。避免连续用“人物名＋没／把／说／问／看／走／站”作为段首。'
const CRITIC_STRUCTURE_GUARD = '【平台结构验收】与近期章纲比较：连续三章以上复用同构调查链判 P1；人物名后紧跟“没／把／说／问／看／走／站”等动作骨架形成跨章机械段首也判 P1。施工单必须给本章命中段号并做最小替换，不得整章泛化润色。'

const jsonSystem = (shape: string, extra = '') =>
  renderPromptText('workflow-writer', 'jsonSystem', { JSON形状: shape, 补充要求: extra })

/** 批量规划本卷接下来的章纲（标题 + 80-150 字章纲） */
export const buildChapterPlanMessages = (params: {
  materials: Record<string, string>
  count: number
  startChapterNo: number
  isFinalStretch: boolean
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(promptText('workflow-writer', 'planShape')),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      [
        `【任务】${renderPromptText('workflow-writer', 'planTask', { 起始章号: params.startChapterNo, 数量: params.count })}`,
        promptText('workflow-writer', 'planNote'),
        params.isFinalStretch ? promptText('workflow-writer', 'planFinal') : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n'),
  },
]

/** 把一章章纲展开成细纲（3-10 拍，每拍 ≤80 字） */
export const buildChapterBeatsMessages = (params: {
  materials: Record<string, string>
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(promptText('workflow-writer', 'beatsShape'), promptText('workflow-writer', 'beatsNote')),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      `【任务】${promptText('workflow-writer', 'beatsTask')}`,
    ].join('\n\n'),
  },
]

/** 正文生成（流式）：全新开写或断点续写共用 */
export const buildChapterContentMessages = (params: {
  materials: Record<string, string>
  targetWords: number
  /** 断点续写时传已写部分，提示模型无缝接着写 */
  partialText?: string
  /** 重写模式的补充要求（为空表示常规生成） */
  rewriteInstruction?: string
}): LocalChatMessageInput[] => {
  const partial = String(params.partialText || '').trim()
  const instruction = String(params.rewriteInstruction || '').trim()
  return [
    {
      role: 'system',
      content: [
        renderPromptText('workflow-writer', 'contentSystem', {
          目标字数: params.targetWords,
          字数上限: params.targetWords + 500,
        }),
        CONTENT_STRUCTURE_GUARD,
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        materialBlock(params.materials),
        instruction ? renderPromptText('workflow-writer', 'rewriteNote', { 要求: instruction }) : '',
        partial
          ? [
              '【已写部分】',
              partial,
              `【任务】${promptText('workflow-writer', 'continueTask')}`,
            ].join('\n')
          : `【任务】${promptText('workflow-writer', 'freshTask')}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ]
}

/** 剧情模式重写：先出新章纲候选（标题 + 章纲），确认后再生成正文 */
export const buildPlotOutlineMessages = (params: {
  materials: Record<string, string>
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(promptText('workflow-writer', 'plotShape')),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      `【任务】${promptText('workflow-writer', 'plotRewriteTask')}`,
    ].join('\n\n'),
  },
]

/** 确认面板"AI 修改此段"：只改这一段，返回纯文本 */
export const buildParagraphPolishMessages = (params: {
  materials: Record<string, string>
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: promptText('workflow-writer', 'paragraphSystem'),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      `【任务】${promptText('workflow-writer', 'paragraphTask')}`,
    ].join('\n\n'),
  },
]

/**
 * 闸三·AI 评审：审查用的素材与写正文时**完全同一份**。
 * 审查者若拿不到设定与红线，只能凭常识挑刺，那挑出来的都是一眼能看出的废话。
 */
export const buildChapterCriticMessages = (params: {
  materials: Record<string, string>
  chapterText: string
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: [
      promptText('workflow-writer', 'criticSystem'),
      CRITIC_STRUCTURE_GUARD,
      renderPromptText('workflow-writer', 'jsonSystem', {
        JSON形状: promptText('workflow-writer', 'criticShape'),
        补充要求: 'scores 与 issues 两个字段都必须给出；本章确实没问题时 issues 返回空数组。',
      }),
    ].join('\n\n'),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      ['【本章正文】', params.chapterText].join('\n'),
      `【任务】${promptText('workflow-writer', 'criticTask')}`,
    ].join('\n\n'),
  },
]

/** 闸三·自动修复：拿着施工单做一次性定向改写，只动被指到的地方 */
export const buildChapterFixMessages = (params: {
  materials: Record<string, string>
  chapterText: string
  order: string
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: promptText('workflow-writer', 'fixSystem'),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      renderPromptText('workflow-writer', 'fixNote', { 施工单: params.order }),
      ['【待修改正文】', params.chapterText].join('\n'),
    ].join('\n\n'),
  },
]

/** 大纲"按要求调整"：输出与当前大纲同构的完整 JSON */
export const buildOutlineAdjustMessages = (params: {
  materials: Record<string, string>
  scopeLabel: string
  instruction: string
  preserveLabels: string[]
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(
      promptText('workflow-wizard', 'outlineShape'),
      promptText('workflow-wizard', 'outlineAdjustNote')
    ),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      [
        `【任务】只调整：${params.scopeLabel}。`,
        `调整要求：${params.instruction || promptText('workflow-wizard', 'outlineAdjustFallback')}`,
        params.preserveLabels.length ? `必须保持不变：${params.preserveLabels.join('、')}。` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n'),
  },
]

/** 设定"按要求调整"：输出与当前设定同构的完整 JSON */
export const buildSettingAdjustMessages = (params: {
  materials: Record<string, string>
  scopeLabel: string
  instruction: string
  preserveLabels: string[]
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(
      promptText('workflow-wizard', 'settingShape'),
      promptText('workflow-wizard', 'settingAdjustNote')
    ),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      [
        `【任务】只调整：${params.scopeLabel}。`,
        `调整要求：${params.instruction || promptText('workflow-wizard', 'settingAdjustFallback')}`,
        params.preserveLabels.length ? `必须保持不变：${params.preserveLabels.join('、')}。` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n'),
  },
]
