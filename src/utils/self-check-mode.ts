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
 * 默认档 = 评审后自动改稿（2026-09-27 作者定档）。
 *
 * 改稿侧有三道安全网兜着，所以敢默认开：① 首次只试跑，并把 applied:false 的试跑记录落库，
 * 下一章起才真改；② 改前强制存正文快照（绕开 5 分钟节流）；③ 改写后字数漂移出 0.7–1.5 倍
 * 即判失败、正文一个字不动。想先只看不改，把闸三档位切回「只评审不改稿」即可。
 *
 * 注意：默认值只影响「从没表过态」的书。旧数据里显式写过 criticEnabled:true 或
 * autoFix:false 的，仍按「只评审」读（见下方 resolveGateThirdMode）—— 不会把别人
 * 明确设过的"只看不改"悄悄升级成自动改稿。
 */
export const DEFAULT_GATE_THIRD_MODE: GateThirdMode = 'fix'

/** 界面选项：默认档排第一，作者多数时候只需要确认它 */
export const GATE_THIRD_MODE_OPTIONS: Array<{ value: GateThirdMode; label: string }> = [
  { value: 'fix', label: '评审后自动改稿' },
  { value: 'review', label: '只评审不改稿' },
  { value: 'off', label: '关闭评审' },
]

const isGateThirdMode = (value: unknown): value is GateThirdMode =>
  value === 'off' || value === 'review' || value === 'fix'

/**
 * 从 run.config（或任意配置对象）解析闸三档位。
 *
 * 优先级：selfCheckMode > criticEnabled=false（关闭） > autoFix=true/dry（改稿） >
 *        criticEnabled=true 或 autoFix=false（旧数据的「只评审」） > 默认档。
 *
 * 旧键只在没有新键时参与判定，所以界面上改过一次档位后，存量脏值不会再抢权。
 * 第四档必须显式写出来：旧配置只写了 criticEnabled:true，语义是"评审开、改稿关"，
 * 默认档改成 fix 之后若不留这一档，这些书会被悄悄升级成自动改稿。
 */
export const resolveGateThirdMode = (config: unknown): GateThirdMode => {
  const raw = (config || {}) as Record<string, unknown>
  if (isGateThirdMode(raw.selfCheckMode)) return raw.selfCheckMode
  if (raw.criticEnabled === false) return 'off'
  if (raw.autoFix === true || raw.autoFix === 'dry') return 'fix'
  if (raw.criticEnabled === true || raw.autoFix === false) return 'review'
  return DEFAULT_GATE_THIRD_MODE
}
