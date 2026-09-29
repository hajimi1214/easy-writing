import type { WorkflowQualityIssue, WorkflowQualityNotice } from '@/types/workflow'
import { scanSensitiveText } from '@/storage/local-sensitive-words'
import type { LocalChapter } from '@/storage/local-library-types'
import {
  buildArtifactTotals,
  buildLatestCharacterStates,
  readChapterLedger,
  scanCharacterStateClaims,
  scanStyleTics,
} from '@/utils/fact-ledger'
import { lintChapterWithRules, summarizeGrades } from '@/utils/quality-rules'
import { countWords } from '@/utils/word-count'

/**
 * 逐章生文的本地规则质检（服务端"规则 + AI 评审"双轨里的规则轨 = 自检三闸的「闸一」）。
 *
 * 开源版不跑 AI 评审（每章多一次付费调用，收益不稳），critic 如实标 unavailable，
 * 只把规则轨的结果按 P0/P1/P2 分级报出来；AI 评审（闸三）由外部工具接 DeepSeek 补上。
 * 规则收得很紧：只拦"明显写坏了"的硬伤（字数严重不足、整段复读、**剧透红线越界**），
 * 敏感词、字数偏多、AI 味词表只作提示不拦截——拦截意味着生成停机等确认，误拦比漏报更伤。
 *
 * 规则数据来自 src/config/quality-rules/*.json，与生成前的提示词注入（quality-rules.ts）
 * 共用同一份，保证「写之前告诉模型什么不能写」和「写完之后检查有没有违规」口径一致。
 */

// 用户要求的是“目标字数”硬门槛：少 1 字也不能进入下一章；上限固定放宽 500 字，
// 既允许章间有自然轻重，也不允许模型把下一章剧情一起写进来。
const WORD_HIGH_ALLOWANCE = 500
const REPEAT_MIN_PARAGRAPH_CHARS = 16
const QUOTE_MAX = 3
const QUOTE_SLICE = 60

const clipQuote = (value: string) => {
  const text = String(value || '').trim()
  return text.length > QUOTE_SLICE ? `${text.slice(0, QUOTE_SLICE)}…` : text
}

const checkWordCount = (words: number, targetWords: number): WorkflowQualityIssue[] => {
  if (!targetWords) return []
  const minimumWords = targetWords
  if (words < minimumWords) {
    return [{
      source: 'rule',
      code: 'word_count_low',
      dimension: '篇幅',
      message: `本章只有 ${words} 字，未达到目标 ${minimumWords} 字，不能进入下一章`,
      severity: 'high',
      grade: 'P0',
      blocking: true,
      fix: '由平台模型继续补写或整章重生成，直到达到字数下限',
      metrics: { wordCount: words, targetWords, minimumWords },
    }]
  }
  const maximumWords = targetWords + WORD_HIGH_ALLOWANCE
  if (words > maximumWords) {
    return [{
      source: 'rule',
      code: 'word_count_high',
      dimension: '篇幅',
      message: `本章 ${words} 字，超过允许上限 ${maximumWords} 字，容易抢写下一章`,
      severity: 'high',
      grade: 'P1',
      blocking: true,
      fix: `压缩到 ${targetWords}–${maximumWords} 字，只删冗余，不得改变剧情事件`,
      metrics: { wordCount: words, targetWords, maximumWords },
    }]
  }
  return []
}

/** 按行切分，与 quality-fixer 的 locateParagraphs 同口径——两边算出的「第几段」必须一致。 */
const paragraphsOf = (text: string) => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)

/**
 * 把正则命中定位到「第几段」（1 为起点），供面板标注与施工单定位共用。
 *
 * 为什么必须给段号：施工单里只有被截断的原句时，模型要在几百段正文里靠片段自己找位置，
 * 找错段号就会触发 applyParagraphPatches 的「锚点不匹配，拒绝错位写回」，精修整批失败；
 * 而精修失败又不回退整章重写，于是自检永远修不过。段号是这条链路上唯一的硬坐标。
 */
const locateParagraphHits = (text: string, regex: RegExp, limit = QUOTE_MAX) => {
  const scan = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
  const hits: { paragraphNo: number; quote: string }[] = []
  paragraphsOf(text).forEach((paragraph, index) => {
    if (hits.length >= limit) return
    scan.lastIndex = 0
    if (scan.test(paragraph)) hits.push({ paragraphNo: index + 1, quote: clipQuote(paragraph) })
  })
  return hits
}

const bigramsOf = (value: string) => {
  const text = String(value || '').replace(/[\s，。！？、；：“”「」『』：,.!?;:'"—…（）()]/g, '')
  const grams = new Set<string>()
  for (let index = 0; index + 1 < text.length; index += 1) grams.add(text.slice(index, index + 2))
  return grams
}

const diceSimilarity = (left: string, right: string) => {
  const a = bigramsOf(left)
  const b = bigramsOf(right)
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const gram of a) if (b.has(gram)) overlap += 1
  return (2 * overlap) / (a.size + b.size)
}

const checkAdjacentRepeat = (text: string, previousText?: string): WorkflowQualityIssue[] => {
  if (!previousText?.trim()) return []
  const previous = paragraphsOf(previousText).filter(item => item.length >= 40).slice(-12)
  const current = paragraphsOf(text)
    .map((item, index) => ({ text: item, paragraphNo: index + 1 }))
    .filter(item => item.text.length >= 40)
    .slice(0, 12)
  let best: { score: number; paragraph: string; paragraphNo: number } | null = null
  for (const left of previous) {
    for (const right of current) {
      const score = diceSimilarity(left, right.text)
      if (!best || score > best.score) best = { score, paragraph: right.text, paragraphNo: right.paragraphNo }
    }
  }
  if (!best || best.score < 0.86) return []
  return [{
    source: 'rule',
    code: 'adjacent_chapter_repeat',
    dimension: '连续性',
    grade: 'P0',
    severity: 'high',
    blocking: true,
    message: `本章开头与上一章结尾高度重复（相似度 ${Math.round(best.score * 100)}%）`,
    quotes: [clipQuote(best.paragraph)],
    paragraphs: [best.paragraphNo],
    fix: '删除重复起笔，从上一章已经完成的状态之后重新开章',
    metrics: { similarity: Number(best.score.toFixed(3)) },
  }]
}

const checkNearDuplicateParagraphs = (text: string): WorkflowQualityIssue[] => {
  const paragraphs = paragraphsOf(text)
    .map((paragraph, index) => ({ paragraph, paragraphNo: index + 1 }))
    .filter(item => item.paragraph.length >= 32)
  let best: { score: number; left: typeof paragraphs[number]; right: typeof paragraphs[number] } | null = null
  for (let leftIndex = 0; leftIndex < paragraphs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paragraphs.length; rightIndex += 1) {
      const left = paragraphs[leftIndex]
      const right = paragraphs[rightIndex]
      if (right.paragraphNo - left.paragraphNo > 12) break
      const score = diceSimilarity(left.paragraph, right.paragraph)
      if (score >= 0.86 && (!best || score > best.score)) best = { score, left, right }
    }
  }
  if (!best) return []
  return [{
    source: 'rule',
    code: 'near_duplicate_paragraph',
    dimension: '重复',
    grade: 'P1',
    severity: 'high',
    blocking: true,
    message: `第 ${best.left.paragraphNo}、${best.right.paragraphNo} 段内容高度重复（相似度 ${Math.round(best.score * 100)}%），疑似修复稿叠加`,
    paragraphs: [best.left.paragraphNo, best.right.paragraphNo],
    quotes: [clipQuote(best.left.paragraph), clipQuote(best.right.paragraph)],
    fix: `合并第 ${best.left.paragraphNo}、${best.right.paragraphNo} 段，只保留一次信息与动作，并接顺上下文`,
    metrics: { similarity: Number(best.score.toFixed(3)) },
  }]
}

/**
 * 「段尾句被复制成下一段」——修复稿叠加最常见的形态，也是最短的一段。
 *
 * 为什么 checkNearDuplicateParagraphs 必然抓不到它：
 * 那条规则要求两段**都** ≥32 字、且**整段**相似度 ≥0.86。而这种形态是
 * 「长段结尾的那一句」被单独复制成下一段——短的那段会被长度门槛直接滤掉，
 * 两段整体相似度也到不了 0.86（分母被长段撑大了）。
 * 《墨痕长生》第一卷里的 6 处重复全是这个形态，一条都没报出来，只能靠人工逐行比对发现。
 *
 * 判据换成**句级包含率**：相邻两段中较短的那段，有多大比例被较长的那段"覆盖"
 * （用最长公共子串长度 / 短段长度）。逐字复制的重复会接近 1.0。
 */
const ECHO_MIN_CHARS = 16
const ECHO_MAX_CHARS = 80
const ECHO_COVER = 0.7

const longestCommonSubstringLength = (left: string, right: string): number => {
  const short = left.length <= right.length ? left : right
  const long = left.length <= right.length ? right : left
  if (!short.length || !long.length) return 0
  let previous = new Array<number>(long.length + 1).fill(0)
  let best = 0
  for (let i = 1; i <= short.length; i += 1) {
    const current = new Array<number>(long.length + 1).fill(0)
    for (let j = 1; j <= long.length; j += 1) {
      if (short[i - 1] === long[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}

const checkTailSentenceEcho = (text: string): WorkflowQualityIssue[] => {
  const paragraphs = paragraphsOf(text)
  const issues: WorkflowQualityIssue[] = []
  for (let index = 0; index + 1 < paragraphs.length; index += 1) {
    const left = paragraphs[index]
    const right = paragraphs[index + 1]
    const shorter = left.length <= right.length ? left : right
    const longer = left.length <= right.length ? right : left
    if (shorter.length < ECHO_MIN_CHARS || shorter.length > ECHO_MAX_CHARS) continue
    const cover = longestCommonSubstringLength(shorter, longer) / shorter.length
    if (cover < ECHO_COVER) continue
    issues.push({
      source: 'rule',
      code: 'tail_sentence_echo',
      dimension: '重复',
      grade: 'P1',
      severity: 'high',
      blocking: true,
      message: `第 ${index + 1}、${index + 2} 段疑似修复稿叠加：较短的一段有 ${Math.round(cover * 100)}% 与邻段逐字重复`,
      paragraphs: [index + 1, index + 2],
      quotes: [clipQuote(shorter)],
      fix: `删除第 ${index + 2} 段（或第 ${index + 1} 段结尾）重复的那句，只保留一次`,
      metrics: { cover: Number(cover.toFixed(3)) },
    })
  }
  return issues
}

const checkWorkflowArtifactLeak = (text: string): WorkflowQualityIssue[] => {
  const markerHits = locateParagraphHits(text, /(?:^|\s)\[P\d+\]|(?:您的打分|审查评分|综合评分)\s*[：:]?\s*\d+\s*\/\s*100/i)
  if (!markerHits.length) return []
  return [{
    source: 'rule',
    code: 'workflow_artifact_leak',
    dimension: '正文纯净度',
    grade: 'P0',
    severity: 'high',
    blocking: true,
    message: `正文混入 ${markerHits.length} 处平台段号或审查评分文本`,
    paragraphs: markerHits.map(item => item.paragraphNo),
    quotes: markerHits.map(item => item.quote),
    fix: `删除第 ${markerHits.map(item => item.paragraphNo).join('、')} 段中的 [P数字] 标签或审查评分，只保留小说正文`,
    metrics: { hits: markerHits.length },
  }]
}

const checkTruncatedEnding = (text: string): WorkflowQualityIssue[] => {
  const paragraphs = paragraphsOf(text)
  const last = paragraphs[paragraphs.length - 1] || ''
  if (!last || /[。！？…）】]$/.test(last)) return []
  return [{
    source: 'rule',
    code: 'chapter_truncated_end',
    dimension: '完整性',
    grade: 'P0',
    severity: 'high',
    blocking: true,
    message: `章末没有完整句号，疑似生成被截断：${clipQuote(last)}`,
    paragraphs: [paragraphs.length],
    quotes: [clipQuote(last)],
    fix: `补完第 ${paragraphs.length} 段及本章未完成的收束，保持章纲事件完整，不得提前写下一章`,
  }]
}

const checkCrossChapterCharacterState = (
  text: string,
  chapterNo: number,
  orderedChapters?: LocalChapter[],
): WorkflowQualityIssue[] => {
  if (!orderedChapters?.length || chapterNo <= 1) return []
  const previous = buildLatestCharacterStates(orderedChapters, chapterNo)
  const current = scanCharacterStateClaims(text)
  const hasExplicitRevival = /(?:复活|还魂|死而复生|起死回生|从死(?:亡|人)中回来)/.test(text)
  if (hasExplicitRevival) return []
  const contradictions = Object.entries(current)
    .filter(([name, claim]) => previous[name]?.state === 'dead' && claim.state !== 'dead')
  return contradictions.map(([name, claim]) => {
    const before = previous[name]
    const hit = locateParagraphHits(text, new RegExp(`${name}[^。！？\\n]{0,72}(?:醒来|醒了|醒过|睁开眼|开口|说话|站起|起身|走来|走去|活着|受伤|重伤|伤势|伤口|昏迷|昏过去)`), 1)[0]
    return {
      source: 'rule',
      code: `character_state_reversal_${name}`,
      dimension: '跨章连续性',
      grade: 'P0',
      severity: 'high',
      blocking: true,
      message: `${name}在第${before.chapterNo}章已明确死亡，本章却直接变为${claim.state === 'injured' ? '受伤/昏迷' : '清醒或行动'}，正文没有复生解释`,
      paragraphs: hit ? [hit.paragraphNo] : undefined,
      quotes: [clipQuote(before.evidence), clipQuote(hit?.quote || claim.evidence)],
      fix: `以第${before.chapterNo}章“${clipQuote(before.evidence)}”为既定事实，改写本章涉及${name}的段落；若确需复生，必须补齐本章章纲允许的明确机制与因果`,
    } satisfies WorkflowQualityIssue
  })
}

const checkBookwideNarrativeTics = (
  text: string,
  chapterNo: number,
  orderedChapters?: LocalChapter[],
): WorkflowQualityIssue[] => {
  if (!orderedChapters?.length) return []
  const current = scanStyleTics(text)
  const previous = orderedChapters
    .filter(chapter => Number(chapter.sortNo || 0) < chapterNo)
    .slice(-12)
  const limits: Record<string, number> = {
    '没动/没有动': 12,
    '流白点头': 8,
    '停了一下': 7,
    '沉默回应': 14,
  }
  const issues: WorkflowQualityIssue[] = []
  for (const [label, currentCount] of Object.entries(current)) {
    if (!currentCount) continue
    const previousCount = previous.reduce(
      (sum, chapter) => sum + Number(readChapterLedger(chapter)?.styleTics?.[label] || 0),
      0,
    )
    const total = previousCount + currentCount
    const dynamicOpening = label.startsWith('段首:')
    const limit = dynamicOpening ? 10 : (limits[label] || 12)
    if (total <= limit) continue
    const dynamicLiteral = label.slice('段首:'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const literal = dynamicOpening
      ? new RegExp(`^${dynamicLiteral}`)
      : label === '没动/没有动'
      ? /没动|没有动/
      : label === '流白点头'
        ? /流白点头|流白点了点头/
        : label === '停了一下'
          ? /停了一下/
          : /没再说|没再问|没说话|没接话/
    const hits = locateParagraphHits(text, literal, 8)
    issues.push({
      source: 'rule',
      code: `bookwide_narrative_tic_${label.replace(/[^\w\u4e00-\u9fff]+/g, '_')}`,
      dimension: '全书文风',
      grade: dynamicOpening ? 'P1' : 'P2',
      severity: dynamicOpening ? 'high' : 'low',
      blocking: dynamicOpening,
      message: `最近12章“${dynamicOpening ? label.slice('段首:'.length) : label}”累计 ${total} 次（本章 ${currentCount} 次），已形成跨章机械节拍`,
      paragraphs: hits.map(item => item.paragraphNo),
      quotes: hits.slice(0, QUOTE_MAX).map(item => item.quote),
      fix: `仅改写本章第 ${hits.map(item => item.paragraphNo).join('、') || '命中'} 段的段首句式，保留事实和剧情结果，换成环境反应、物件变化、对方动作或直接信息推进；不得整章重写`,
      metrics: { total, currentCount, limit },
    })
  }
  return issues
}

const checkDialogueFormat = (text: string): WorkflowQualityIssue[] => {
  const quoteCount = (String(text || '').match(/[「」『』“”]/g) || []).length
  const colonDialogue = String(text || '').match(/(?:说|问|道|喊|答|开口|低声|小声)[^。！？\n]{0,12}[：:]/g) || []
  const quoteHits = locateParagraphHits(text, /[「」『』“”]/)
  const colonHits = locateParagraphHits(text, /(?:说|问|道|喊|答|开口|低声|小声)[^。！？\n]{0,12}[：:]/)
  const issues: WorkflowQualityIssue[] = []
  if (quoteCount) {
    issues.push({
      source: 'rule',
      code: 'dialogue_quotes_forbidden',
      dimension: '排版',
      grade: 'P1',
      severity: 'high',
      blocking: true,
      message: `正文仍含 ${quoteCount} 个对话引号符号${quoteHits.length ? `，分布在第 ${quoteHits.map(item => item.paragraphNo).join('、')} 段` : ''}`,
      fix: '去掉对话引号，并同步改写成自然独立对白，不能只机械删符号',
      paragraphs: quoteHits.map(item => item.paragraphNo),
      quotes: quoteHits.map(item => item.quote),
      metrics: { quoteCount },
    })
  }
  if (colonDialogue.length) {
    issues.push({
      source: 'rule',
      code: 'dialogue_colon_format',
      dimension: '排版',
      grade: 'P1',
      severity: 'high',
      blocking: true,
      message: `发现 ${colonDialogue.length} 处冒号式对白，删除引号后句法仍不自然${colonHits.length ? `，分布在第 ${colonHits.map(item => item.paragraphNo).join('、')} 段` : ''}`,
      quotes: colonHits.map(item => item.quote),
      paragraphs: colonHits.map(item => item.paragraphNo),
      fix: '改成独立对白段，或改成“人物动作。\n对白。”，正文不得使用冒号引出对白',
      metrics: { hits: colonDialogue.length },
    })
  }
  return issues
}

const checkNarrativeTics = (text: string): WorkflowQualityIssue[] => {
  const body = String(text || '')
  const groups = [
    { label: '沉默反应', regex: /(?:没|没有)(?:说话|接话|回答|作声)/g, limit: 5 },
    { label: '看了一眼', regex: /看了一眼/g, limit: 4 },
    { label: '忽然', regex: /忽然/g, limit: 7 },
  ]
  const hits = groups
    .map(group => ({
      ...group,
      count: (body.match(group.regex) || []).length,
      located: locateParagraphHits(body, group.regex),
    }))
    .filter(group => group.count > group.limit)
  if (!hits.length) return []
  const located = Array.from(new Set(hits.flatMap(group => group.located.map(item => item.paragraphNo)))).sort((a, b) => a - b)
  return [{
    source: 'rule',
    code: 'narrative_tic_density',
    dimension: 'AI味',
    grade: 'P2',
    severity: 'low',
    blocking: false,
    message: `人物反应模板重复：${hits.map(item => `${item.label}×${item.count}`).join('、')}${located.length ? `，集中在第 ${located.slice(0, 6).join('、')} 段` : ''}`,
    fix: '保留少量必要反应，其余改为能推进信息、关系或动作结果的具体行为',
    paragraphs: located,
    quotes: hits.flatMap(group => group.located.map(item => item.quote)).slice(0, QUOTE_MAX),
    metrics: Object.fromEntries(hits.map(item => [item.label, item.count])),
  }]
}

const checkParagraphRepeat = (text: string): WorkflowQualityIssue[] => {
  const seen = new Map<string, number>()
  const repeated: Array<{ paragraph: string; first: number; second: number }> = []
  let paragraphNo = 0
  for (const raw of String(text || '').split(/\n+/)) {
    const paragraph = raw.trim()
    if (!paragraph) continue
    paragraphNo += 1
    if (paragraph.length < REPEAT_MIN_PARAGRAPH_CHARS) continue
    const first = seen.get(paragraph)
    if (first) repeated.push({ paragraph, first, second: paragraphNo })
    else seen.set(paragraph, paragraphNo)
  }
  if (!repeated.length) return []
  return [{
    source: 'rule',
    code: 'paragraph_repeat',
    dimension: '重复',
    message: `发现 ${repeated.length} 处整段重复内容，正文疑似复读`,
    severity: 'high',
    blocking: true,
    paragraphs: Array.from(new Set(repeated.flatMap(item => [item.first, item.second]))),
    quotes: repeated.slice(0, QUOTE_MAX).map(item => clipQuote(item.paragraph)),
    fix: `删除或合并第 ${Array.from(new Set(repeated.flatMap(item => [item.first, item.second]))).join('、')} 段的重复内容，并接顺上下文`,
  }]
}

const checkSensitiveWords = (text: string): WorkflowQualityIssue[] => {
  const result = scanSensitiveText(text)
  if (!result.hasSensitive) return []
  const top = result.matches.slice(0, 5)
  const quotes: string[] = []
  for (const item of top) {
    if (quotes.length >= QUOTE_MAX) break
    const index = text.indexOf(item.word)
    if (index === -1) continue
    quotes.push(clipQuote(text.slice(Math.max(0, index - 12), index + item.word.length + 24)))
  }
  return [{
    source: 'rule',
    code: 'sensitive_words',
    dimension: '敏感词',
    message: `命中本地敏感词 ${result.total} 处：${top.map(item => `${item.word}×${item.count}`).join('、')}`,
    severity: 'low',
    blocking: false,
    quotes,
    fix: '发布前可在编辑器里用敏感词检查逐处替换',
  }]
}

const gradeRank = (grade?: string) => (grade === 'P0' ? 0 : grade === 'P1' ? 1 : 2)

export const runLocalChapterQualityCheck = (params: {
  chapterId: number
  chapterNo: number
  chapterTitle: string
  text: string
  targetWords: number
  contentVersion: number
  modelCode?: string
  previousText?: string
  /**
   * 全书按序章列表：用来从闸二账本里取「截至上一章各可数物件的累计数」。
   * 账本读的是各章 planMeta 缓存，**同步**即可，不需要 await。
   * 不传就跳过数量平衡校验（没有前账就没有比对基准）。
   */
  orderedChapters?: LocalChapter[]
}): WorkflowQualityNotice => {
  const words = countWords(params.text)
  const baseIssues = [
    ...checkWordCount(words, params.targetWords),
    ...checkWorkflowArtifactLeak(params.text),
    ...checkTruncatedEnding(params.text),
    ...checkParagraphRepeat(params.text),
    ...checkNearDuplicateParagraphs(params.text),
    ...checkTailSentenceEcho(params.text),
    ...checkAdjacentRepeat(params.text, params.previousText),
    ...checkCrossChapterCharacterState(params.text, params.chapterNo, params.orderedChapters),
    ...checkBookwideNarrativeTics(params.text, params.chapterNo, params.orderedChapters),
    ...checkDialogueFormat(params.text),
    ...checkNarrativeTics(params.text),
    ...checkSensitiveWords(params.text),
  ]

  // 闸一扩展：剧透红线按章排期、AI 味词表/句式、节奏与开篇钩子。
  // 与生成前注入用的是同一份规则 JSON，所以「模型被要求别写」和「写完被判违规」是同一套标准。
  const artifactTotals = params.orderedChapters
    ? buildArtifactTotals(params.orderedChapters, params.chapterNo)
    : undefined
  const ruleIssues = lintChapterWithRules({
    text: params.text,
    chapterNo: params.chapterNo,
    targetWords: params.targetWords,
    artifactTotals,
  })

  // 两套规则会有同名 code（字数、敏感词），按 code 去重且基础规则优先，避免面板里同一问题报两遍。
  const seenCodes = new Set<string>()
  const issues = [...baseIssues, ...ruleIssues]
    .filter(issue => {
      if (seenCodes.has(issue.code)) return false
      seenCodes.add(issue.code)
      return true
    })
    .map(issue => ({
      ...issue,
      // 自动生成模式下 P0/P1 都是交付失败；P2进入自动润色，但不单独阻断。
      blocking: issue.blocking || issue.grade === 'P0' || issue.grade === 'P1',
    }))
    .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade))

  const grades = summarizeGrades(issues)
  const hasGradeHit = grades.P0 + grades.P1 + grades.P2 > 0

  return {
    version: 1,
    requiresAction: issues.some(issue => issue.blocking),
    chapterId: params.chapterId,
    chapterNo: params.chapterNo,
    chapterTitle: params.chapterTitle,
    issues,
    wordCount: words,
    contentVersion: params.contentVersion,
    modelCode: params.modelCode,
    createdAt: new Date().toISOString(),
    critic: {
      status: 'unavailable',
      error: hasGradeHit
        ? `开源版未接入 AI 评审；本地规则轨已跑：P0 ${grades.P0} / P1 ${grades.P1} / P2 ${grades.P2}（共 ${issues.length} 项）`
        : '开源版暂未接入 AI 评审，仅做规则检查；本章本地规则零命中',
    },
  }
}
