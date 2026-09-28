/**
 * 正文净化 —— 平台协议痕迹的单一真源
 * ---------------------------------------------------------------------------
 * 为什么需要单独一个文件：
 * 之前「剥段号 / 删审查评分」的正则散在两处（生成侧的 normalizeGeneratedChapterText、
 * 修复侧的 stripParagraphLabel），且两处的严格程度不一样。改一处漏一处，
 * 于是模型回写的段号在生成侧被剥掉了、在修复侧却留下了。
 *
 * 更关键的是：这两处都只跑在**生成/修复落库的那一刻**，
 * 洗不到已经躺在章库里的存量正文。所以导出侧与「一键清洗全书」也必须共用这一份。
 *
 * 设计原则：宁可漏剥，不可误删正文。只认形态稳定的平台标记，
 * 不认「看起来像标记」的自由文本（例如故事里出现 [P3] 这种巧合留给人工判断）。
 */

/** 平台段号：[P88] / [P 88] / [p7]。带方括号才认，避免误伤正文里的字母数字组合。 */
const PARAGRAPH_LABEL = /\[\s*[Pp]\s*\d+\s*\]\s*/g

/**
 * 审查评分：您的打分：83/100。
 * 分母不再限定 100（模型也写过 /120、/10），但只要「打分/评分 + 数字/数字」这个形态。
 */
const REVIEW_SCORE = /(?:您的打分|审查评分|综合评分|本章评分|AI评分)\s*[：:]?\s*\d+\s*\/\s*\d+/g

/** 供「只报告不改」模式与检测规则复用：扫出一处命中就够定位 */
export type ChapterArtifactHit = {
  kind: 'paragraph_label' | 'review_score'
  /** 1 为起点的行号 */
  lineNo: number
  /** 命中所在的原行（截断） */
  text: string
}

const clip = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** 扫出正文里的平台痕迹（不修改文本） */
export const scanChapterArtifacts = (value: string): ChapterArtifactHit[] => {
  const hits: ChapterArtifactHit[] = []
  String(value || '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (PARAGRAPH_LABEL.test(line)) {
        hits.push({ kind: 'paragraph_label', lineNo: index + 1, text: clip(line.trim()) })
      }
      // 注意：带 g 的正则 test 会推进 lastIndex，这里先复位再用
      PARAGRAPH_LABEL.lastIndex = 0
      REVIEW_SCORE.lastIndex = 0
      if (REVIEW_SCORE.test(line)) {
        hits.push({ kind: 'review_score', lineNo: index + 1, text: clip(line.trim()) })
      }
      REVIEW_SCORE.lastIndex = 0
    })
  return hits
}

/** 正文里是否混有平台痕迹 */
export const hasChapterArtifact = (value: string): boolean => scanChapterArtifacts(value).length > 0

/**
 * 相邻重复行的最小长度。
 * 低于这个长度的短对白（「不。」「走。」「谁。」）可能是有意的重复，不参与判定。
 */
const DUP_LINE_MIN_LEN = 8

/**
 * 「整句被重复成上一行开头/结尾」的最小长度。
 * 这个判定比"完全相同"激进，所以门槛定得更高（12 字），
 * 避免把正文里恰好和上一行首尾撞上的短句误删。
 */
const DUP_LINE_CONTAIN_MIN_LEN = 12

/**
 * 删掉相邻重复行 —— 自动改稿分段落盘时最常见的残留。
 *
 * 只认两种形态，都是改稿器写回时的机械签名：
 *   1. 相邻两行完全相同
 *   2. 后一整行是上一行的开头或结尾（改稿器把段落的头/尾又写了一遍）
 *
 * 不认"相似"：相似度判定会误伤刻意的重复语气，那类留给人工判断。
 * 空行不参与判定，否则会吃掉正常的段落分隔。
 */
/**
 * @param containMinLen 「是上一行开头/结尾」判定的最小长度。
 *   默认 12：用于导出/生成侧，宁可漏删不可误删。
 *   改稿器会传更小的值——那里发现重复是「整批拒绝让模型重来」，代价可恢复，
 *   所以可以查得更严；误删正文则不可恢复。
 */
export const dropDuplicateLines = (value: string, containMinLen = DUP_LINE_CONTAIN_MIN_LEN): string => {
  const out: string[] = []
  for (const line of String(value || '').split(/\r?\n/)) {
    const cur = line.trim()
    const prev = out.length ? out[out.length - 1].trim() : ''
    const isSame = cur !== '' && cur === prev && cur.length >= DUP_LINE_MIN_LEN
    // 双向判定：短行可能在长行前面（改稿器把上一行拆成两行时就会这样），
    // 也可能在后面（改稿器把上一行的头或尾又写成一行）。只判一个方向会漏掉一半。
    const isHeadOrTail =
      cur !== '' &&
      Math.min(cur.length, prev.length) >= containMinLen &&
      (prev.startsWith(cur) || prev.endsWith(cur) || cur.startsWith(prev) || cur.endsWith(prev))
    if (isSame || isHeadOrTail) continue
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 剥掉平台格式噪声：段号与审查评分。
 * 与删重复行分开，是因为二者的处置方式不同——
 * 格式噪声是机械的，直接剥掉即可；重复行可能是改写出错，有时需要退回让模型重来。
 *
 * - 段号：任意位置、任意多个（旧的 `^\[?P\d+\]?` 只剥开头一个，这是残留的真因）
 * - 评分：整行只有评分时丢掉整行；评分跟在正文后时只删评分片段
 */
export const stripChapterArtifacts = (value: string): string => {
  const text = String(value || '')
  if (!text) return text
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const next = line.replace(PARAGRAPH_LABEL, '').replace(REVIEW_SCORE, '')
    // 原本非空、清完只剩空白 => 这一整行就是平台痕迹，整体丢弃
    if (line.trim() !== '' && next.trim() === '') continue
    out.push(next.replace(/\s+$/, ''))
  }
  return out.join('\n')
}

/**
 * 净化单章正文：剥掉段号与审查评分，并删掉相邻重复行。
 * 生成侧与导出侧共用同一份，存量正文靠导出兜底。
 */
export const sanitizeChapterText = (value: string): string => {
  const text = String(value || '')
  if (!text) return text
  return dropDuplicateLines(stripChapterArtifacts(text))
}

/**
 * 修复侧专用：模型回写的段号形态更多（可能一个 replacement 里带好几个），
 * 且与正文同处一行。这里全局剥离，不改变定位语义（段号本来就不是正文）。
 */
export const stripParagraphLabel = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(PARAGRAPH_LABEL, '')
    // 兼容旧行为：无方括号的行首段号（如 "P7 正文…"）也剥掉
    .replace(/^[Pp]\s*\d+\s+/, '')
