/**
 * 自检闸三（AI 评审 + 施工单自动改稿）的档位契约。
 *
 * 单独成文件，是为了让「写正文的引擎」和「规则面板的界面」共用同一份判定，
 * 不在两边各写一遍 if —— 档位判错一次，要么白烧评审额度，要么悄悄改坏正文。
 *
 * 存 run.config.selfCheckMode（'off' / 'review' / 'fix'）。旧数据的
 * criticEnabled / autoFix 两个键继续兼容，新键在场时以新键为准。
 */

export type GateThirdMode = 'off' | 'review' | 'fix'

/**
 * 默认档 = 只评审不改稿。
 *
 * 这也是加档位之前**实际**发生的事：评审一直在跑（只有显式 criticEnabled:false 才跳过），
 * 而改稿因为"改了才写记录、没记录就一直判首次试跑"，从没真正落盘过。
 * 所以设成默认不改变升级前的行为，只是把白烧掉的那次改写调用省下来。
 */
export const DEFAULT_GATE_THIRD_MODE: GateThirdMode = 'review'

/** 界面选项：默认档排第一，作者多数时候只需要确认它 */
export const GATE_THIRD_MODE_OPTIONS: Array<{ value: GateThirdMode; label: string }> = [
  { value: 'review', label: '只评审不改稿' },
  { value: 'fix', label: '评审后自动改稿' },
  { value: 'off', label: '关闭评审' },
]

const isGateThirdMode = (value: unknown): value is GateThirdMode =>
  value === 'off' || value === 'review' || value === 'fix'

/**
 * 从 run.config（或任意配置对象）解析闸三档位。
 *
 * 优先级：selfCheckMode > criticEnabled=false > autoFix > 默认「只评审不改稿」。
 * 旧键只在没有新键时参与判定，所以界面上改过一次档位后，存量脏值不会再抢权。
 */
export const resolveGateThirdMode = (config: unknown): GateThirdMode => {
  const raw = (config || {}) as Record<string, unknown>
  if (isGateThirdMode(raw.selfCheckMode)) return raw.selfCheckMode
  if (raw.criticEnabled === false) return 'off'
  if (raw.autoFix === true || raw.autoFix === 'dry') return 'fix'
  return DEFAULT_GATE_THIRD_MODE
}
