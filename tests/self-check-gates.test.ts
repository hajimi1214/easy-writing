/**
 * 自检三闸 · 闸一（规则轨）与闸二（事实账本）的回归用例。
 *
 * 规则数据在 src/config/quality-rules/*.json，改规则后跑 `pnpm test` 即可确认
 * 「生成前注入的约束」与「生成后体检的判定」仍然自洽。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  describeChapterConstraints,
  getActiveBans,
  lintChapterWithRules,
  qualityRulesMeta,
  resolveVolumeOfChapter,
  summarizeGrades,
} from '@/utils/quality-rules'
import { buildLedgerMaterials, scanChapterLedger, scanStyleTics } from '@/utils/fact-ledger'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  filterUnsupportedCriticIssues,
  mergeCriticReport,
  scopeCriticReportToParagraphs,
  toCriticIssues,
} from '@/utils/ai-critic'
import { buildRevealedSettingBrief, stripAuthorNotes } from '@/utils/setting-reveal'
import {
  applyParagraphPatches,
  buildWordCompressionInstruction,
  calibrateWordRewriteTarget,
  deriveRepairScopeParagraphs,
  filterPatchesToAllowedScope,
  requiresGlobalChapterRewrite,
  buildFixOrderLines,
  buildFixOrderText,
  runChapterFixRewrite,
  selectFixableIssues,
  summarizeFixDiff,
} from '@/utils/quality-fixer'
import type { LocalChapter } from '@/storage/local-library-types'
import type { WorkflowQualityIssue, WorkflowQualityNotice } from '@/types/workflow'
import { useAiModelStore } from '@/stores/ai-model'
import { saveLocalAiModel, sceneOfGroup } from '@/storage/local-ai-models'
import {
  blockingIssueFingerprint,
  criticNeedsRetryWithoutRewrite,
  normalizeGeneratedChapterText,
  resolveReviewModelCode,
  resolveWorkflowModelCode,
  shouldContinueChapterDraft,
  shouldPreviewFix,
  shouldRerunFullCriticAfterRepair,
} from '@/utils/local-workflow-writer'
import { runLocalChapterQualityCheck } from '@/utils/local-quality-check'
import {
  DEFAULT_GATE_THIRD_MODE,
  GATE_THIRD_MODE_OPTIONS,
  resolveGateThirdMode,
} from '@/utils/self-check-mode'
import type { LocalWorkflowRun } from '@/storage/local-workflow'
import { shouldAutoResumeBookTask } from '@/utils/local-workflow-auto-resume'
import {
  buildWorkflowSavePayload,
  createInitialWorkflowDraft,
  normalizeSettingResult,
} from '@/views/WorkflowBook/workflow-adapter'
import { assertLocalTxtExportReady, formatExportChapterTitle } from '@/storage/local-library-utils'

const filler = '他走进院子，脚步很轻。'.repeat(180)
const makeChapter = (
  id: number,
  sortNo: number,
  title: string,
  summary: string,
  planMeta: LocalChapter['planMeta'] = null,
) => ({ id, sortNo, title, summary, planMeta, bookId: '1', volumeId: '1' }) as unknown as LocalChapter

describe('闸一 · 生成前约束注入', () => {
  it('第1章列全卷一红线', () => {
    const text = describeChapterConstraints(1)
    expect(text).toContain('第1–36章《买棺人》')
    expect(text).toContain('不得出现「死生门」')
    // 概念类只给描述、不列原文：把禁词直接列给模型反而会诱导它去写
    expect(text).toContain('顾青崖与死生门有关')
    expect(text).toContain('2800–3500')
    expect(text).toContain('300 字内')
  })

  it('第45章「死生门」名已解禁，顾青崖身份与断岁仍禁', () => {
    const text = describeChapterConstraints(45)
    expect(text).not.toContain('不得出现「死生门」')
    expect(text).not.toContain('不得出现「顾青崖」')
    expect(text).toContain('顾青崖与死生门有关')
    expect(text).toContain('不得出现「断岁」')
  })

  it('第31章是黑木签签文的放宽章，写明允许次数', () => {
    expect(describeChapterConstraints(30)).toContain('不得出现「勿记」')
    expect(describeChapterConstraints(31)).toContain('最多出现 1 次')
  })

  it('第537章已超出卷表，只给篇幅约束', () => {
    expect(resolveVolumeOfChapter(537)).toBeNull()
    expect(describeChapterConstraints(537)).not.toContain('本卷')
  })

  it('chapterNo 非法时返回空串，不污染提示词', () => {
    expect(describeChapterConstraints(0)).toBe('')
    expect(describeChapterConstraints(Number.NaN)).toBe('')
  })

  it('8 卷 536 章：卷表连续无重叠，18 条红线在第一章全部生效', () => {
    expect(getActiveBans(1)).toHaveLength(18)
    expect(resolveVolumeOfChapter(1)).toMatchObject({ name: '买棺人', from: 1, to: 36 })
    expect(resolveVolumeOfChapter(36)?.name).toBe('买棺人')
    expect(resolveVolumeOfChapter(37)?.name).toBe('山河旧客')
    expect(resolveVolumeOfChapter(101)?.name).toBe('青槐春秋')
    expect(resolveVolumeOfChapter(217)?.name).toBe('死生门')
    expect(resolveVolumeOfChapter(536)?.name).toBe('长生尽头')
    expect(resolveVolumeOfChapter(537)).toBeNull()
  })

  it('揭晓控制表逐条对齐：解禁章与 §二十八 完全一致', () => {
    const active = (no: number, id: string) => getActiveBans(no).some(ban => ban.id === id)
    // 说破「六十二年前就是流白」第23章才可确认
    expect(active(22, 'SPOIL-LU-62Y-VISIT')).toBe(true)
    expect(active(23, 'SPOIL-LU-62Y-VISIT')).toBe(false)
    // 顾青崖名字最早第24章
    expect(active(23, 'SPOIL-GUQINGYA-NAME')).toBe(true)
    expect(active(24, 'SPOIL-GUQINGYA-NAME')).toBe(false)
    // 「换名术」名称最早第14章，完整原理第27章
    expect(active(13, 'SPOIL-HUANMING-NAME')).toBe(true)
    expect(active(14, 'SPOIL-HUANMING-NAME')).toBe(false)
    expect(active(27, 'SPOIL-HUANMING-PRINCIPLE')).toBe(false)
    // 黑木签为流白所写第31章才可确认
    expect(active(30, 'SPOIL-HMQ-AUTHOR')).toBe(true)
    expect(active(31, 'SPOIL-HMQ-AUTHOR')).toBe(false)
    // 「若仍叫流白，往北」第36章
    expect(active(35, 'SPOIL-GO-NORTH')).toBe(true)
    expect(active(36, 'SPOIL-GO-NORTH')).toBe(false)
    // 顾青崖×死生门锁到第五卷（217）
    expect(active(216, 'SPOIL-GUQINGYA-SSM')).toBe(true)
    expect(active(217, 'SPOIL-GUQINGYA-SSM')).toBe(false)
    // 断岁／岁海锁到第六卷（287）
    expect(active(286, 'SPOIL-DUANSUI')).toBe(true)
    expect(active(287, 'SPOIL-DUANSUI')).toBe(false)
    expect(active(286, 'SPOIL-SUIHAI')).toBe(true)
    expect(active(287, 'SPOIL-SUIHAI')).toBe(false)
    // 晏无终第七卷（367）
    expect(active(366, 'SPOIL-YANWUZHONG')).toBe(true)
    expect(active(367, 'SPOIL-YANWUZHONG')).toBe(false)
    // 流白终极长生原理第八卷（457）
    expect(active(456, 'SPOIL-LU-FINAL-PRINCIPLE')).toBe(true)
    expect(active(457, 'SPOIL-LU-FINAL-PRINCIPLE')).toBe(false)
  })
})

describe('闸一 · 生成后逐章体检', () => {
  it('目标字数是硬门槛，差一字也阻断，达到才放行', () => {
    const check = (text: string) => runLocalChapterQualityCheck({
      chapterId: 1,
      chapterNo: 0,
      chapterTitle: '测试',
      text,
      targetWords: 2800,
      contentVersion: 1,
    })
    expect(check('甲'.repeat(2799)).issues.find(issue => issue.code === 'word_count_low')?.blocking).toBe(true)
    expect(check('甲'.repeat(2800)).issues.find(issue => issue.code === 'word_count_low')).toBeUndefined()
  })

  it('超过目标 500 字同样阻断，不能抢写下一章', () => {
    const check = runLocalChapterQualityCheck({
      chapterId: 1, chapterNo: 0, chapterTitle: '测试', text: '甲'.repeat(3501),
      targetWords: 3000, contentVersion: 1,
    })
    expect(check.issues.find(issue => issue.code === 'word_count_high')?.blocking).toBe(true)
  })

  it('对话引号和冒号式对白都按 P1 阻断', () => {
    const check = runLocalChapterQualityCheck({
      chapterId: 1, chapterNo: 0, chapterTitle: '测试', text: `他说：「流白。」\n${'甲'.repeat(3000)}`,
      targetWords: 3000, contentVersion: 1,
    })
    expect(check.issues.find(issue => issue.code === 'dialogue_quotes_forbidden')?.blocking).toBe(true)
    expect(check.issues.find(issue => issue.code === 'dialogue_colon_format')?.blocking).toBe(true)
  })

  it('本章开头复写上一章结尾时按 P0 阻断', () => {
    const repeated = '雨水顺着残碑往下淌，流白抬手抹去碑角泥痕，又把黑木签收回袖中。他沿石阶继续向北，脚步始终没有停。'
    const check = runLocalChapterQualityCheck({
      chapterId: 2, chapterNo: 0, chapterTitle: '测试', text: `${repeated}\n${'甲'.repeat(3000)}`,
      previousText: `${'乙'.repeat(3000)}\n${repeated}`,
      targetWords: 3000, contentVersion: 1,
    })
    expect(check.issues.find(issue => issue.code === 'adjacent_chapter_repeat')?.grade).toBe('P0')
  })

  it('生成正文统一移除中西式对话引号', () => {
    expect(normalizeGeneratedChapterText('「流白。」他说，“走吧。”『别回头。』'))
      .toBe('流白。他说，走吧。别回头。')
  })

  it('落库前清掉段落协议标签与审查评分，不让平台元数据混进正文', () => {
    expect(normalizeGeneratedChapterText('[P18] 流白把灯挑亮一点。\n您的打分：83/100\n正文继续。'))
      .toBe('流白把灯挑亮一点。\n正文继续。')
  })

  it('章末被截断、近似段落叠加都按硬伤阻断', () => {
    const duplicate = '沈照月把袖子挽到小臂，额角有汗，抬头望向门外渐暗的天色，掌心还攥着那张发潮的旧纸。'
    const check = runLocalChapterQualityCheck({
      chapterId: 1,
      chapterNo: 0,
      chapterTitle: '测试',
      text: `${duplicate}\n${duplicate}她没有说话。\n${'甲'.repeat(3000)}`,
      targetWords: 3000,
      contentVersion: 1,
    })
    expect(check.issues.find(issue => issue.code === 'near_duplicate_paragraph')?.blocking).toBe(true)
    expect(check.issues.find(issue => issue.code === 'chapter_truncated_end')?.blocking).toBe(true)
  })

  it('刷新恢复时，已达标断点直接质检，不会被当半章重复续写', () => {
    expect(shouldContinueChapterDraft('甲'.repeat(2999), 3000)).toBe(true)
    expect(shouldContinueChapterDraft('甲'.repeat(3000), 3000)).toBe(false)
    expect(shouldContinueChapterDraft('甲'.repeat(4300), 3000)).toBe(false)
  })

  it('重复阻断按稳定代码与段落识别，不会被模型换一种文案绕过止循环', () => {
    const issue = (message: string, paragraphs: number[], index: number): WorkflowQualityIssue => ({
      source: 'critic', code: `CRITIC-连续性-${index}`, dimension: '连续性', grade: 'P1', severity: 'high',
      blocking: true, message, paragraphs,
    })
    const first = { issues: [issue('这里重复解释了', [9, 8], 3)] } as never
    const renamed = { issues: [issue('同一处存在复述', [8, 9], 1)] } as never
    expect(blockingIssueFingerprint(first)).toBe(blockingIssueFingerprint(renamed))
  })

  it('审查模型失败或不给精准施工单时只重试审查，不拿写作模型盲目重写正文', () => {
    const unavailable = {
      issues: [{
        source: 'critic', code: 'CRITIC-UNAVAILABLE', dimension: 'AI审查', grade: 'P0', severity: 'high',
        blocking: true, message: '响应超时', fix: '未给出施工单：重新运行AI审查',
      }],
    } as WorkflowQualityNotice
    expect(criticNeedsRetryWithoutRewrite(unavailable)).toBe(true)
    expect(criticNeedsRetryWithoutRewrite({
      ...unavailable,
      issues: [{ ...unavailable.issues[0], fix: '改：P8 → 修正人物状态', paragraphs: [8] }],
    })).toBe(false)
  })

  it('卷一点破死生门 → P0 且阻断', () => {
    const issues = lintChapterWithRules({
      text: `门额上刻着死生门三个字。${filler}`,
      chapterNo: 5,
    })
    const hit = issues.find(issue => issue.code === 'SPOIL-SSM')
    expect(hit).toBeTruthy()
    expect(hit!.grade).toBe('P0')
    expect(hit!.blocking).toBe(true)
    expect(hit!.dimension).toBe('设定红线')
  })

  it('同一句话放到第40章不再算越界', () => {
    const issues = lintChapterWithRules({
      text: `门额上刻着死生门三个字。${filler}`,
      chapterNo: 40,
    })
    expect(issues.find(issue => issue.code === 'SPOIL-SSM')).toBeUndefined()
  })

  it('放宽章超次报错、不超次放行', () => {
    const twice = lintChapterWithRules({ text: `勿记。勿记。${filler}`, chapterNo: 31 })
    expect(twice.find(issue => issue.code === 'SPOIL-HMQ-CONTENT')?.message).toContain('超出限制')
    const once = lintChapterWithRules({ text: `勿记。${filler}`, chapterNo: 31 })
    expect(once.find(issue => issue.code === 'SPOIL-HMQ-CONTENT')).toBeUndefined()
  })

  it('现实年代词 P1、空推句式 P2', () => {
    const issues = lintChapterWithRules({ text: `公元某年的事儿。${filler}`, chapterNo: 10 })
    expect(issues.find(issue => issue.code === 'SPOIL-ERA-WORD')?.grade).toBe('P1')

    const omniscient = lintChapterWithRules({ text: `他一眼看出端倪。${filler}`, chapterNo: 10 })
    expect(omniscient.find(issue => issue.code === 'SPOIL-OMNISCIENT-SEE')?.grade).toBe('P2')
  })

  it('第三章不判剧透（chapterNo<=0 时跳过）', () => {
    const issues = lintChapterWithRules({ text: `死生门。${filler}`, chapterNo: 0 })
    expect(issues.find(issue => issue.code === 'SPOIL-SSM')).toBeUndefined()
  })

  it('字数过短照样拦；多章合订文件不误判', () => {
    const short = lintChapterWithRules({ text: '他推门进去。', chapterNo: 1 })
    expect(short.find(issue => issue.code === 'word_count_low')?.grade).toBe('P0')

    const merged = lintChapterWithRules({ text: '第1章 起\n第2章 承\n他推门进去。', chapterNo: 1 })
    expect(merged.find(issue => issue.code === 'word_count_low')).toBeUndefined()
  })

  it('AI 味模板短语与引号混用都能识别', () => {
    const issues = lintChapterWithRules({
      text: `他指节发白，说「别动」，又说“站住”。${filler}`,
      chapterNo: 10,
    })
    expect(issues.some(issue => issue.code.startsWith('STYLE-TEMPLATE'))).toBe(true)
    expect(issues.find(issue => issue.code === 'STYLE-QUOTE-MIX')).toBeTruthy()
  })

  it('空正文不报任何问题，且结果按 P0→P2 排序', () => {
    expect(lintChapterWithRules({ text: '   ', chapterNo: 1 })).toEqual([])
    const issues = lintChapterWithRules({
      text: `死生门。公元。他一眼看出。${filler}`,
      chapterNo: 10,
    })
    const ranks = issues.map(issue => (issue.grade === 'P0' ? 0 : issue.grade === 'P1' ? 1 : 2))
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
    expect(summarizeGrades(issues).P0).toBeGreaterThan(0)
  })
})

describe('闸二 · 账本素材', () => {
  const chapter = (
    id: number,
    sortNo: number,
    title: string,
    summary: string,
    planMeta: LocalChapter['planMeta'] = null,
  ) => ({ id, sortNo, title, summary, planMeta, bookId: '1', volumeId: '1' }) as unknown as LocalChapter

  it('扫一章能列出出场人物与章末', () => {
    const ledger = scanChapterLedger(
      chapter(1, 1, '起', ''),
      `沈照月抬头看见流白站在院里。${'他走了很久。'.repeat(60)}`
    )
    expect(ledger.characters).toContain('流白')
    expect(ledger.characters).toContain('沈照月')
    expect(ledger.characters).not.toContain('顾青崖')
    expect(ledger.tail.length).toBeLessThanOrEqual(160)
  })

  it('第一章没有前情，素材为空对象', async () => {
    const materials = await buildLedgerMaterials({
      orderedChapters: [chapter(1, 1, '起', '')],
      currentChapterNo: 1,
    })
    expect(materials).toEqual({})
  })

  it('写到第3章时给出全书进度、近期章纲与人物出场表', async () => {
    const withLedger = chapter(1, 1, '起', '沈照月进山', {
      workflowLedger: { chapterNo: 1, title: '起', wordCount: 100, characters: ['沈照月'], tail: '…', updatedAt: '' },
    })
    const materials = await buildLedgerMaterials({
      orderedChapters: [withLedger, chapter(2, 2, '承', '发现墨迹'), chapter(3, 3, '转', '')],
      currentChapterNo: 3,
    })
    expect(materials['全书进度（已写完的章节，按序）']).toContain('第2章《承》')
    expect(materials['全书进度（已写完的章节，按序）']).not.toContain('第3章')
    expect(materials['全书进度（已写完的章节，按序）']).toContain('买棺人')
    expect(materials['近期章纲（最近 12 章，承接用）']).toContain('发现墨迹')
    expect(materials['人物出场表（未列出的人物不得突然出场）']).toContain('沈照月（最近第1章）')
    expect(materials['人物出场表（未列出的人物不得突然出场）']).toContain('尚未出场：流白')
  })
})

describe('闸三 · AI 评审结果解析', () => {
  it('合法条目转成平台契约，脏条目直接丢弃', () => {
    const { issues, orders } = toCriticIssues([
      {
        dimension: '逻辑',
        grade: 'p0',
        message: '他不可能知道这件事',
        quote: '他一眼认出那是国书',
        order: { op: '改', target: '第7段', detail: '改成凭笔迹材质推断' },
      },
      { grade: 'P1' }, // 没有 message，丢弃
      { dimension: '设定越界', grade: 'P2', message: '说法越界', order: { op: '润色一下', detail: 'x' } },
    ])
    expect(issues).toHaveLength(2)
    expect(issues[0].grade).toBe('P0')
    expect(issues[0].blocking).toBe(true)
    expect(issues[0].source).toBe('critic')
    expect(issues[0].fix).toBe('改：第7段 → 改成凭笔迹材质推断')
    expect(issues[0].paragraphs).toEqual([7])
    expect(issues[1].dimension).toBe('其他') // 维度认不出就归"其他"
    expect(issues[1].blocking).toBe(false) // P2 不阻断
    expect(issues[1].fix).toBe('未给出施工单：请人工判断') // op 不是六个动词，不算施工单
    expect(orders).toHaveLength(1)
  })

  it('两份 code 不相撞：同维度多条不会被去重吃掉', () => {
    const { issues } = toCriticIssues([
      { dimension: '逻辑', grade: 'P1', message: 'A' },
      { dimension: '逻辑', grade: 'P1', message: 'B' },
    ])
    expect(new Set(issues.map(issue => issue.code)).size).toBe(2)
    expect(issues.every(issue => issue.blocking)).toBe(true)
  })

  it('跨章累计机械反应句式会注入下一章素材，不能每章单独看都漏过', async () => {
    const previous = Array.from({ length: 6 }, (_, index) => makeChapter(index + 1, index + 1, `章${index + 1}`, '', {
      workflowLedger: {
        chapterNo: index + 1,
        title: `章${index + 1}`,
        wordCount: 3000,
        characters: ['流白'],
        tail: '…',
        styleTics: { 流白点头: 1 },
        updatedAt: '',
      },
    }))
    const materials = await buildLedgerMaterials({
      orderedChapters: [...previous, makeChapter(7, 7, '新章', '')],
      currentChapterNo: 7,
    })
    expect(materials['近期高频反应句式（本章必须换成具体动作或信息推进）']).toContain('流白点头×6')
  })

  it('人物明确死亡后，后章无解释醒来会被跨章闸门拦截', () => {
    const deadLedger = scanChapterLedger(makeChapter(34, 34, '结局', ''), '邢三更死了。周六斤用草纸盖住他的尸体。')
    const previous = makeChapter(34, 34, '结局', '', { workflowLedger: deadLedger })
    const current = makeChapter(35, 35, '往北', '')
    const check = runLocalChapterQualityCheck({
      chapterId: 35,
      chapterNo: 35,
      chapterTitle: '往北',
      text: `邢三更醒过一次，又昏了过去。\n${'甲'.repeat(3000)}。`,
      targetWords: 3000,
      contentVersion: 1,
      orderedChapters: [previous, current],
    })
    expect(deadLedger.characterStates?.邢三更?.state).toBe('dead')
    expect(check.issues.find(issue => issue.code === 'character_state_reversal_邢三更')?.grade).toBe('P0')
  })

  it('合并导出永远带稳定第N章编号，裸章名不会再破坏章节解析', () => {
    expect(formatExportChapterTitle(makeChapter(1, 33, '埋我者，亦埋你', ''))).toBe('第33章 埋我者，亦埋你')
    expect(formatExportChapterTitle(makeChapter(2, 34, '第34章 邢三更的结局', ''))).toBe('第34章 邢三更的结局')
    expect(formatExportChapterTitle(makeChapter(3, 35, '第34章 往北', ''))).toBe('第35章 往北')
  })

  it('工作流导出会拦住缺字章与被合并的多章正文', () => {
    // 写书器写过逐章目标的章：严格按自己的目标卡
    const stampedChapter = {
      ...makeChapter(1, 1, '起', '', { workflowPlanIndex: 1, workflowTargetWords: 3000 }),
      textContent: '甲'.repeat(2999),
    }
    expect(() => assertLocalTxtExportReady([stampedChapter])).toThrow(/未达到 3000 字/)

    // 存量章（没有逐章目标）：按兜底目标 3000 的 90% 判定，
    // 只差几十字的正常章不再被误伤——否则整本第一卷都会被拦在导出外面
    const legacyNormal = {
      ...makeChapter(2, 2, '承', '', { workflowPlanIndex: 2 }),
      textContent: '甲'.repeat(2900),
    }
    expect(() => assertLocalTxtExportReady([legacyNormal])).not.toThrow()

    const legacyShort = {
      ...makeChapter(3, 3, '转', '', { workflowPlanIndex: 3 }),
      textContent: '甲'.repeat(2699),
    }
    expect(() => assertLocalTxtExportReady([legacyShort])).toThrow(/未达到 2700 字/)

    const mergedChapter = {
      ...makeChapter(4, 4, '合', ''),
      textContent: `乙${'甲'.repeat(3000)}\n第3章 转\n${'丙'.repeat(3000)}`,
    }
    expect(() => assertLocalTxtExportReady([mergedChapter])).toThrow(/正文内含另一处章标题/)

    // 存量章的超长上限同样按比例（3000×1.4＝4200）。
    // 第27章 3644 字只超目标 4%，不能误拦——否则整本第一卷卡在一章上导不出去。
    const legacySlightlyLong = {
      ...makeChapter(5, 5, '承', '', { workflowPlanIndex: 5 }),
      textContent: '甲'.repeat(3644),
    }
    expect(() => assertLocalTxtExportReady([legacySlightlyLong])).not.toThrow()

    const legacyTooLong = {
      ...makeChapter(6, 6, '承', '', { workflowPlanIndex: 6 }),
      textContent: '甲'.repeat(4201),
    }
    expect(() => assertLocalTxtExportReady([legacyTooLong])).toThrow(/超过 4200 字/)

    // 写书器盖过逐章目标的章不放宽：仍按自己的目标 +500 卡
    const stampedTooLong = {
      ...makeChapter(7, 7, '承', '', { workflowPlanIndex: 7, workflowTargetWords: 3000 }),
      textContent: '甲'.repeat(3501),
    }
    expect(() => assertLocalTxtExportReady([stampedTooLong])).toThrow(/超过 3500 字/)
  })

  it('动态统计人物机械段首，跨章超限时作为P1阻断并精准给出段号', () => {
    const tics = scanStyleTics('流白没说话。\n沈照月把纸折起。\n流白没有回头。')
    expect(tics['段首:流白没']).toBe(2)
    expect(tics['段首:沈照月把']).toBe(1)

    const previous = Array.from({ length: 5 }, (_, index) => makeChapter(index + 1, index + 1, `章${index + 1}`, '', {
      workflowLedger: {
        chapterNo: index + 1, title: `章${index + 1}`, wordCount: 3000,
        characters: ['流白'], tail: '…', styleTics: { '段首:流白没': 2 }, updatedAt: '',
      },
    }))
    const check = runLocalChapterQualityCheck({
      chapterId: 6,
      chapterNo: 6,
      chapterTitle: '新章',
      text: `流白没接话。\n${'甲'.repeat(3000)}。`,
      targetWords: 3000,
      contentVersion: 1,
      orderedChapters: [...previous, makeChapter(6, 6, '新章', '')],
    })
    expect(check.issues.find(issue => issue.code.includes('段首_流白没'))).toMatchObject({
      grade: 'P1', blocking: true, paragraphs: [1],
    })
  })

  it('合并进质检通知后按 P0→P2 排序并刷新阻断标记', () => {
    const notice = {
      version: 1,
      requiresAction: false,
      chapterId: 1,
      chapterNo: 5,
      chapterTitle: '起',
      wordCount: 3000,
      contentVersion: 1,
      issues: [
        { source: 'rule' as const, code: 'opening_no_hook', dimension: '节奏', message: '开篇没有钩子', severity: 'high' as const, blocking: false, grade: 'P1' as const },
      ],
    }
    const merged = mergeCriticReport(notice, {
      status: 'available',
      issues: [
        { source: 'critic', code: 'CRITIC-逻辑-1', dimension: '逻辑', message: '因果不成立', severity: 'high', blocking: true, grade: 'P0' },
      ],
      orders: [],
      scores: { 逻辑: 8, 时间线: 8, 空间: 8, 设定红线: 8, 人物一致: 8, 连续性: 8, AI味: 8, 情绪落点: 8, 节奏钩子: 8 },
    })
    expect(merged.issues).toHaveLength(2)
    expect(merged.issues[0].grade).toBe('P0')
    expect(merged.requiresAction).toBe(true)
    expect(merged.critic?.status).toBe('available')
    expect(merged.critic?.scores?.逻辑).toBe(8)
  })

  it('审查不可用会阻断；低分进入自动润色但不凭主观评分无限卡死', () => {
    const notice = {
      version: 1, requiresAction: false, chapterId: 1, chapterNo: 1, chapterTitle: '起',
      wordCount: 3000, contentVersion: 1, issues: [],
    }
    const unavailable = mergeCriticReport(notice, {
      status: 'unavailable', issues: [], orders: [], error: '超时',
    })
    expect(unavailable.issues.find(issue => issue.code === 'CRITIC-UNAVAILABLE')?.blocking).toBe(true)

    const low = mergeCriticReport(notice, {
      status: 'available', issues: [], orders: [],
      scores: { 逻辑: 7, 时间线: 8, 空间: 8, 设定红线: 8, 人物一致: 8, 连续性: 8, AI味: 8, 情绪落点: 8, 节奏钩子: 8 },
    })
    expect(low.issues.find(issue => issue.code === 'CRITIC-SCORE-BELOW-8')).toMatchObject({
      grade: 'P2',
      blocking: false,
    })
  })

  it('修复验收只保留命中施工范围的问题，不能换一批问题继续循环', () => {
    const scoped = scopeCriticReportToParagraphs({
      status: 'available',
      issues: [
        { source: 'critic', code: 'inside', dimension: '连续性', message: '修复处仍有问题', severity: 'high', blocking: true, grade: 'P1', paragraphs: [7] },
        { source: 'critic', code: 'outside', dimension: 'AI味', message: '别处可以润色', severity: 'low', blocking: false, grade: 'P2', paragraphs: [21] },
        { source: 'critic', code: 'unlocated', dimension: '逻辑', message: '没有坐标的新问题', severity: 'high', blocking: true, grade: 'P1' },
      ],
      orders: ['旧施工单'],
      scores: { 逻辑: 8, 时间线: 8, 空间: 8, 设定红线: 8, 人物一致: 8, 连续性: 8, AI味: 8, 情绪落点: 8, 节奏钩子: 8 },
    }, [6, 7, 8])

    expect(scoped.issues.map(issue => issue.code)).toEqual(['inside'])
    expect(scoped.orders).toEqual([])
  })
})

describe('写书任务自动接续', () => {
  const task = (status: string, interruptedReason?: string, errorMessage?: string) => ({
    id: 1,
    runId: 1,
    bookId: 1,
    bizType: 'book_generate',
    status,
    interruptedReason,
    errorMessage,
  }) as never

  it('接回关页中断和可恢复失败，但不覆盖用户暂停或不可恢复配置错误', () => {
    expect(shouldAutoResumeBookTask(task('queued'))).toBe(true)
    expect(shouldAutoResumeBookTask(task('interrupted', 'app_closed'))).toBe(true)
    expect(shouldAutoResumeBookTask(task('failed', undefined, '请求失败（HTTP 400）：Body is not valid JSON'))).toBe(true)
    expect(shouldAutoResumeBookTask(task('failed', undefined, '账户余额不足，请到供应商后台充值'))).toBe(true)
    expect(shouldAutoResumeBookTask(task('failed', undefined, '请求失败（HTTP 402）：insufficient balance'))).toBe(true)
    expect(shouldAutoResumeBookTask(task('failed', undefined, '第63章自检尚未通过，平台守护器将自动接续'))).toBe(true)
    expect(shouldAutoResumeBookTask(task('canceled', undefined, '同一本书已有生成器在其他页签运行，本页签重复任务已停止'))).toBe(true)
    expect(shouldAutoResumeBookTask(task('canceled', undefined, '用户已取消'))).toBe(false)
    expect(shouldAutoResumeBookTask(task('failed', undefined, '模型配置不完整'))).toBe(false)
    expect(shouldAutoResumeBookTask(task('paused'))).toBe(false)
    expect(shouldAutoResumeBookTask(task('running'))).toBe(false)
  })
})

describe('闸三 · 施工单修复执行器', () => {
  const issue = (patch: Record<string, unknown>) =>
    ({ source: 'rule', code: 'x', dimension: '篇幅', message: 'm', severity: 'high', blocking: true, grade: 'P0', ...patch }) as unknown as WorkflowQualityIssue

  it('P0/P1/P2 只要带动作都自动修；空话排除', () => {
    const picked = selectFixableIssues([
      issue({ code: 'a', fix: '删减至 1 次以内' }),
      issue({ code: 'b', grade: 'P2', fix: '检查是否注水' }),
      issue({ code: 'c', fix: '未给出施工单：请人工判断' }),
      issue({ code: 'd', fix: '' }),
    ])
    expect(picked.map(item => item.code)).toEqual(['a', 'b'])
  })

  it('施工单文本带上来源、等级、命中原句与执行动作', () => {
    const text = buildFixOrderText([
      issue({ code: 'SPOIL-SSM', dimension: '设定红线', message: '剧透红线越界', fix: '删去该句', quotes: ['门额上刻着死生门三个字'] }),
    ])
    expect(text).toContain('[规则·P0·设定红线]')
    expect(text).toContain('命中原句：门额上刻着死生门三个字')
    expect(text).toContain('执行：删去该句')
    expect(buildFixOrderLines([])).toEqual([])
  })

  it('diff 摘要能数出保留段、改写段与字数变化', () => {
    const before = ['第一段甲。', '第二段乙。', '第三段丙。'].join('\n')
    const after = ['第一段甲。', '第二段改过了。', '第三段丙。'].join('\n')
    const diff = summarizeFixDiff(before, after)
    expect(diff.keptParagraphs).toBe(2)
    expect(diff.removedParagraphs).toBe(1)
    expect(diff.addedParagraphs).toBe(1)
    expect(diff.changedSamples[0]).toContain('第二段乙')
    expect(diff.afterWords - diff.beforeWords).toBe(2) // 「第二段乙。」→「第二段改过了。」多 2 字
  })

  it('段落补丁只修改命中段，其他正文连换行都逐字保留', () => {
    const before = '第一段原文。\r\n\r\n第二段有问题。\r\n第三段保持不动。'
    const result = applyParagraphPatches(before, [{
      startParagraph: 2,
      endParagraph: 2,
      anchor: '第二段有问题',
      replacement: '第二段已经精准修好。',
    }])
    expect(result).toMatchObject({ ok: true, changedParagraphs: 1 })
    expect(result.text).toBe('第一段原文。\r\n\r\n第二段已经精准修好。\r\n第三段保持不动。')
  })

  it('段号越界、补丁重叠或锚点不符时整批拒绝，不猜位置', () => {
    const text = '第一段。\n第二段。\n第三段。'
    expect(applyParagraphPatches(text, [{
      startParagraph: 4, endParagraph: 4, anchor: '第四段', replacement: '改',
    }]).ok).toBe(false)
    expect(applyParagraphPatches(text, [
      { startParagraph: 1, endParagraph: 2, anchor: '第一段', replacement: '改一。' },
      { startParagraph: 2, endParagraph: 3, anchor: '第二段', replacement: '改二。' },
    ]).error).toContain('重叠')
    const mismatch = applyParagraphPatches(text, [{
      startParagraph: 2, endParagraph: 2, anchor: '不存在的原句', replacement: '改',
    }])
    expect(mismatch.ok).toBe(false)
    expect(mismatch.text).toBe(text)
    expect(mismatch.error).toContain('锚点不匹配')
  })

  it('模型夹带越界补丁时只丢弃越界项，保留施工单范围内补丁', () => {
    const filtered = filterPatchesToAllowedScope([
      { startParagraph: 1, endParagraph: 2, anchor: '正文', replacement: '合法修改' },
      { startParagraph: 108, endParagraph: 108, anchor: '越界', replacement: '不得写回' },
    ], [1, 2, 3])
    expect(filtered).toEqual([
      { startParagraph: 1, endParagraph: 2, anchor: '正文', replacement: '合法修改' },
    ])
  })

  it('平台从段号、施工单文本和命中原句合成可信修复范围', () => {
    const text = ['第一段。', '第二段有问题。', '第三段。', '第四段也有问题。', '第五段。'].join('\n\n')
    const scope = deriveRepairScopeParagraphs(text, [
      issue({ paragraphs: [2], quotes: ['第四段也有问题'], fix: '改：第2段 → 精准修改' }),
    ])
    // 两个命中点及其相邻段覆盖全文；段号来自平台，不依赖模型重抄原文。
    expect(scope).toEqual([1, 2, 3, 4, 5])
  })

  it('明确写到文末的删除单只从可信起点开放尾部范围', () => {
    const text = Array.from({ length: 8 }, (_, index) => `第${index + 1}段。`).join('\n')
    const scope = deriveRepairScopeParagraphs(text, [
      issue({ paragraphs: [4], fix: '删：第4段至全章 → 删除越界后戏' }),
    ])
    expect(scope).toEqual([3, 4, 5, 6, 7, 8])
  })

  it('没有可执行施工单时不发模型调用', async () => {
    const result = await runChapterFixRewrite({
      modelCode: 'deepseek-chat',
      materials: {},
      chapterText: '正文',
      issues: [issue({ code: 'b', grade: 'P2', fix: '未给出施工单：请人工判断' })],
    })
    expect(result.ok).toBe(false)
    expect(result.orderCount).toBe(0)
    expect(result.error).toContain('没有可执行的施工单')
  })

  it('篇幅改写后重新初审，不拿字数施工单做语义验收', () => {
    expect(shouldRerunFullCriticAfterRepair([
      issue({ code: 'word_count_high', fix: '压缩到 3000–3500 字' }),
    ])).toBe(true)
    expect(shouldRerunFullCriticAfterRepair([
      issue({ code: 'CRITIC-逻辑-1', dimension: '逻辑', fix: '改：P3 → 修正因果' }),
    ])).toBe(false)
  })

  it('模型稳定少写时按实际比例放大下一轮提示目标', () => {
    const first = calibrateWordRewriteTarget({
      targetWords: 3000,
      maximumWords: 3500,
      desiredCenter: 3125,
      actualWords: 2940,
    })
    expect(first).toBeGreaterThanOrEqual(3425)
    const second = calibrateWordRewriteTarget({
      targetWords: 3000,
      maximumWords: 3500,
      desiredCenter: 3125,
      actualWords: 2940,
      lastRequestedCenter: first,
    })
    expect(second).toBeGreaterThan(first)
  })

  it('短稿可整章补写，长稿只做段落压缩补丁', () => {
    expect(requiresGlobalChapterRewrite(issue({ code: 'word_count_low' }))).toBe(true)
    expect(requiresGlobalChapterRewrite(issue({ code: 'word_count_high' }))).toBe(false)
    const instruction = buildWordCompressionInstruction(3681, 3500)
    expect(instruction).toContain('超出 181 字')
    expect(instruction).toContain('281–431 字')
    expect(instruction).toContain('2–12 个')
  })
})

describe('闸三 · AI 审查证据校验', () => {
  const issue = (message: string) => ({
    source: 'critic',
    code: 'CRITIC-设定红线-1',
    dimension: '设定红线',
    message,
    severity: 'high',
    blocking: true,
    grade: 'P1',
    fix: '改：P2 → 修改',
    paragraphs: [2],
  }) as WorkflowQualityIssue

  it('正文没有禁用符号时，丢弃“禁止直接对白”的模型误报', () => {
    const issues = filterUnsupportedCriticIssues([
      issue('独立成行的直接对话违反正文硬规则，应全部改成间接转述'),
      issue('铜钱位置前后不一致'),
    ], '他敲了敲门。\n牛三家的，开门。')
    expect(issues.map(item => item.message)).toEqual(['铜钱位置前后不一致'])
  })

  it('正文确有对话引号或冒号对白时保留审查问题', () => {
    const claimed = issue('直接对话违反禁止对话引号的硬规则')
    expect(filterUnsupportedCriticIssues([claimed], '他说：「开门。」')).toHaveLength(1)
    expect(filterUnsupportedCriticIssues([claimed], '他说：开门。')).toHaveLength(1)
  })
})

describe('闸一 v6 · 吸收黑名单 v6 的实证特征', () => {
  const codes = (text: string, chapterNo = 10) =>
    lintChapterWithRules({ text, chapterNo }).map(issue => issue.code)

  it('段首零回指评论：段首命中，句中不算（区分力最强的一项）', () => {
    expect(codes(`值得注意的是，他没有再提那件事。${filler}`)).toContain('AI-LEAD-EVAL')
    // 负控：同一个词出现在句子中间，不属于"段首零回指"
    expect(codes(`他说的那句话值得注意的是，但其实没人接。${filler}`)).not.toContain('AI-LEAD-EVAL')
  })

  it('译文句式按 minHits=2 判定：真人语料每章最多 1 处', () => {
    expect(codes(`然而，他没有回头。${filler}`)).not.toContain('AI-TRANSLATIONESE')
    expect(codes(`然而，他没有回头。然而，他也没有停下。${filler}`)).toContain('AI-TRANSLATIONESE')
    const issues = lintChapterWithRules({ text: `然而，他没有回头。然而，他也没有停下。${filler}`, chapterNo: 10 })
    expect(issues.find(issue => issue.code === 'AI-TRANSLATIONESE')?.metrics?.minHits).toBe(2)
  })

  it('拟人化喻体与反问必自答都能识别', () => {
    expect(codes(`他像一位智慧的导师般开口。${filler}`)).toContain('AI-HUMAN-METAPHOR')
    expect(codes(`难道他早就知道？当然是知道的。${filler}`)).toContain('AI-RHETORICAL-SELF-ANSWER')
  })

  it('两条禁令：只有设问不算 AI 味，只有比喻也不算', () => {
    expect(codes(`他为什么要走？没有人回答。${filler}`)).not.toContain('AI-RHETORICAL-SELF-ANSWER')
    expect(codes(`他像一棵老树，站在门口不动。${filler}`)).not.toContain('AI-HUMAN-METAPHOR')
  })

  it('符号密度按本书自身 p95 判：超阈才报，低密度不报', () => {
    expect(codes(`标题：内容。${filler}`)).not.toContain('AI-COLON-DENSE')
    expect(codes('标题：内容。'.repeat(200))).toContain('AI-COLON-DENSE')

    expect(codes(`他去过——他知道。${filler}`)).not.toContain('AI-DASH-DENSE')
    expect(codes('他去过——他知道。'.repeat(200))).toContain('AI-DASH-DENSE')

    expect(codes(`他、我、你。${filler}`)).not.toContain('AI-DUNHAO-DENSE')
    expect(codes('他、我、你、他、我、你、他、我、你、他、我、你。'.repeat(60))).toContain('AI-DUNHAO-DENSE')
  })

  it('生成前注入同时给出用词禁令与行为禁令', () => {
    const text = describeChapterConstraints(1)
    expect(text).toContain('段首零回指评论')
    expect(text).toContain('译文句式')
    expect(text).toContain('标准答案式')
    expect(text).toContain('规避：永远知道所有答案')
    expect(text).toContain('符号密度上限')
  })

  it('规则元信息能反映 v6 的新增规模', () => {
    expect(qualityRulesMeta.densityMetricCount).toBe(3)
    expect(qualityRulesMeta.behavioralPatternCount).toBe(6)
  })
})

/**
 * 独立校验器（自检/lint.mjs）与平台引擎读的是同一份 JSON，但**是两套实现**。
 * v6 那轮只改了平台引擎、忘了改 CLI，于是 CLI 完全不知道 densityMetrics / minHits 的存在
 * —— 「平台里跑的」和「命令行跑的」判定不一致，恰好违反这套设计赖以成立的前提。
 * 这组用例把两者的判定钉在一起：改任何一边，另一边不同步就会红。
 */
describe('闸一 · 平台引擎与独立 CLI 判定必须一致', () => {
  const FIX_SINGLE = [
    '他推门进去，屋里没点灯。桌上摆着一只空碗：碗底有半圈干掉的水痕。',
    '值得注意的是，这个细节说明了很多东西。',
    '他数了数墙上的裂缝：三条竖的，两条斜的，一条横的。加起来六条。',
    '这意味着，事情并不简单。',
    '他伸手去摸碗沿：凉的。指腹蹭到一点灰。他把手收回来，在衣角上擦了擦。',
    '窗外的槐树响了一声。不是风。他侧过头去听：又是一声。',
    '他把沙挑出来，放在掌心。屋里很静。他忽然想起自己小时候也这样挑过沙，却记不清是在哪里。',
  ].join('\n\n')

  const FIX_DOUBLE = FIX_SINGLE.replace('这意味着，事情并不简单。', '这意味着，事情并不简单。\n\n这意味着，有人比他们先到过这里。')

  /** 跑一次 CLI，返回它报出的 code 列表；找不到 CLI 时返回 null（本地缺文件不判失败） */
  const runCli = async (text: string): Promise<string[] | null> => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const cli = path.resolve(process.cwd(), '..', '自检', 'lint.mjs')
    if (!fs.existsSync(cli)) return null
    const fixture = path.join(os.tmpdir(), `ew-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    fs.writeFileSync(fixture, text, 'utf8')
    try {
      let out = ''
      try {
        out = execFileSync(process.execPath, [cli, fixture, '--chapter', '5', '--json'], {
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
        })
      } catch (error) {
        // CLI 在有问题时可能以非零码退出，stdout 仍然是完整的 JSON
        out = String((error as { stdout?: string })?.stdout || '')
      }
      return (JSON.parse(out).issues as Array<{ code: string }>).map(item => item.code)
    } finally {
      fs.unlinkSync(fixture)
    }
  }

  const platformCodes = (text: string) =>
    lintChapterWithRules({ text, chapterNo: 5 }).map(issue => issue.code)

  it('段首零回指评论：平台报，CLI 也报（单次即报）', async () => {
    expect(platformCodes(FIX_SINGLE)).toContain('AI-LEAD-EVAL')
    const cli = await runCli(FIX_SINGLE)
    if (cli === null) return
    expect(cli).toContain('AI-LEAD-EVAL')
  })

  it('译文句式：单次两边都不报，两次两边都报（minHits=2 必须同步）', async () => {
    expect(platformCodes(FIX_SINGLE)).not.toContain('AI-TRANSLATIONESE')
    expect(platformCodes(FIX_DOUBLE)).toContain('AI-TRANSLATIONESE')

    const single = await runCli(FIX_SINGLE)
    const double = await runCli(FIX_DOUBLE)
    if (single === null || double === null) return
    expect(single).not.toContain('AI-TRANSLATIONESE')
    expect(double).toContain('AI-TRANSLATIONESE')
  })

  it('符号密度：两边都报（CLI 曾经完全不认 densityMetrics）', async () => {
    expect(platformCodes(FIX_SINGLE)).toContain('AI-COLON-DENSE')
    const cli = await runCli(FIX_SINGLE)
    if (cli === null) return
    expect(cli).toContain('AI-COLON-DENSE')
  })

  it('两边报出的 code 集合完全一致', async () => {
    const cli = await runCli(FIX_DOUBLE)
    if (cli === null) return
    expect([...cli].sort()).toEqual([...platformCodes(FIX_DOUBLE)].sort())
  })
})

/**
 * 《墨痕长生》reveal 闸门夹具（内联）。
 *
 * 这组用例直接读取当前《墨痕长生》资料包，
 * App 早已不读它（buildChapterMaterials 取的是工作流 run 上的 settingResult），
 * 只剩测试还在用它，等于让用例守住一本不存在的书。改为内联夹具后，
 * 断言对象与平台实际消费的 WorkflowSettingResult 形状、与 00-spoiler-ban.json
 * 的排期章号完全对齐。
 */
const MOHEN_SETTING: Record<string, unknown> = {
  characters: [
    { name: '流白', gender: '男', identity: '棺材铺掌柜', background: '不知道自己活了多久的长生者。', motivation: '查清老人和六十二年前旧事' },
    { name: '沈照月', gender: '女', identity: '纸墨铺少女', background: '喜欢把重要事情记下来的少女。', motivation: '查清旧档异常' },
    { name: '陆安年', gender: '男', identity: '买棺老人', background: '一个在临死前来找流白买棺的老人。', motivation: '完成父亲遗命', revealAtChapter: 1 },
    { name: '顾青崖', gender: '女', identity: '六十二年前旧人', background: '六十二年前曾和流白一起出现在槐坡的女子。', motivation: '作者隐藏', revealAtChapter: 24 },
    { name: '晏无终', gender: '男', identity: '不公开', background: '前期不得注入。', motivation: '彻底解决死亡', revealAtChapter: 367 },
  ],
  core: {
    cultivation: {
      realms: [
        { name: '锻体', desc: '当世第一境。', revealAtChapter: 1 },
        { name: '引气', desc: '当世第二境，邢三更在此境。', revealAtChapter: 1 },
        { name: '灵海', desc: '当世第三境。', revealAtChapter: 20 },
        { name: '金丹', desc: '当世第五境。', revealAtChapter: 142 },
        { name: '登仙', desc: '当世第九境，仙门才有的说法。', revealAtChapter: 142 },
      ],
    },
  },
  storylines: [
    { title: '槐坡三十二号', desc: '六十二年前异常下葬留下的档案号。', revealAtChapter: 1 },
    { title: '死生门', desc: '第一卷只出现技术影子，第五卷完整爆发。', revealAtChapter: 217 },
    { title: '断岁遗城', desc: '从历史里消失的古城。', revealAtChapter: 287 },
  ],
}

describe('闸一·素材侧 · 设定泄底闸门', () => {
  it('第5章素材里没有任何后卷泄底词', () => {
    const brief = buildRevealedSettingBrief(MOHEN_SETTING, 5)
    const blob = [brief.characters, brief.power, brief.storylines].join('\n')
    expect(blob.length).toBeGreaterThan(0)
    for (const word of ['顾青崖', '晏无终', '死生门', '断岁', '岁海', '登仙']) {
      expect(blob, `第5章素材不该出现「${word}」`).not.toContain(word)
    }
  })

  it('后卷人物卷一不注入，到了排期章才解禁', () => {
    const early = buildRevealedSettingBrief(MOHEN_SETTING, 5).characters
    expect(early).toContain('流白')
    expect(early).toContain('沈照月')
    expect(early).not.toContain('顾青崖')
    expect(early).not.toContain('晏无终')
    // 顾青崖按 §二十八 第 24 章开闸
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 24).characters).toContain('顾青崖')
    // 晏无终按 §二十八 第七卷（367）开闸
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 366).characters).not.toContain('晏无终')
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 367).characters).toContain('晏无终')
  })

  it('力量体系只列已解禁境界', () => {
    const early = buildRevealedSettingBrief(MOHEN_SETTING, 5).power
    expect(early).toContain('锻体')
    expect(early).toContain('引气')
    expect(early).not.toContain('灵海')
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 20).power).toContain('灵海')
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 5).power).not.toContain('登仙')
  })

  it('故事线只注入本卷与已过卷', () => {
    const early = buildRevealedSettingBrief(MOHEN_SETTING, 5).storylines
    expect(early).toContain('槐坡三十二号')
    expect(early).not.toContain('死生门')
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 217).storylines).toContain('死生门')
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 286).storylines).not.toContain('断岁遗城')
  })

  it('作者批注消毒：卷次批注、【写作纪律】、真相句一律剔掉', () => {
    expect(stripAuthorNotes('动作慢半步。真相：流白当年留下的守门人。')).toBe('动作慢半步。')
    expect(stripAuthorNotes('受命调查。【写作纪律】：第一卷禁止牵扯死生门。')).toBe('受命调查。')
    expect(stripAuthorNotes('发现葬契（第六卷回收：他的死是引路）。')).toBe('发现葬契。')
  })

  it('旧数据没写 revealAtChapter 时行为不变：始终可见', () => {
    const brief = buildRevealedSettingBrief(
      {
        characters: [
          { name: '某人', gender: '男', identity: '路人', background: '背景一句', motivation: '动机一句' },
        ],
      },
      5,
    )
    expect(brief.characters).toContain('某人')
    expect(brief.characters).toContain('背景一句')
  })

  it('规划阶段（章号未知）不设闸门，避免把设定整体抹空', () => {
    expect(buildRevealedSettingBrief(MOHEN_SETTING, 0).characters).toContain('晏无终')
  })

  // 归一化是闸门链条上唯一一处「静默丢件」风险点：`buildWorkflowSavePayload` 是拿
  // 归一化后的 draft.settingResult 去 clone 出 workflowSettingUi 的，而生成正文读的正是
  // workflowSettingUi。归一化一旦不认 revealAtChapter / briefBackground，门槛就永久失效——
  // 表现为「单元测试里闸门好用，真实流程里后卷角色从第 1 章起整张卡进提示词」。
  it('归一化往返不丢揭晓闸门与安全简介', () => {
    const normalized = normalizeSettingResult(MOHEN_SETTING)
    expect(normalized.characters.find(item => item.name === '顾青崖')?.revealAtChapter).toBe(24)
    expect(normalized.characters.find(item => item.name === '晏无终')?.revealAtChapter).toBe(367)
    expect(normalized.storylines.some(item => item.revealAtChapter === 217)).toBe(true)
    // 境界是原样数组透传，顺手锁住
    expect(normalized.core.cultivation.realms.find(item => item.name === '灵海')?.revealAtChapter).toBe(20)

    // 走真实链路：草稿 → buildWorkflowSavePayload → workflowSettingUi → 闸门
    const draft = createInitialWorkflowDraft()
    draft.settingResult = normalized
    const payload = buildWorkflowSavePayload(draft) as unknown as {
      summary: { workflowSettingUi: Record<string, unknown> }
    }
    const ui = payload.summary.workflowSettingUi
    expect(buildRevealedSettingBrief(ui, 5).characters).not.toContain('顾青崖')
    expect(buildRevealedSettingBrief(ui, 24).characters).toContain('顾青崖')
  })
})

/**
 * 闸二 · 可数物件账本（数字连续性）。
 *
 * 起因是第 5 章正文写「加上纸坊里那枚，共十一枚」，实际只交代了 6~7 枚。
 * 这类错误是**算术**不是理解，横扫实测两个最快的直答型模型一条都没抓到，
 * 所以下沉到本地账本：生成前注入「截至上一章共 N 枚」，生成后拿累计声明比对。
 * 设计原则与作者口径一致：宁可漏报不可过报，而且**存疑不拦停**。
 */
describe('闸二 · 可数物件账本与数量平衡校验', () => {
  const BALANCE_CODE = 'ARTIFACT-BALANCE-corner_coin'
  const balanceHits = (text: string, totals?: Record<string, number>) =>
    lintChapterWithRules({ text: `${text}${filler}`, chapterNo: 5, artifactTotals: totals })
      .filter(issue => issue.code === BALANCE_CODE)

  it('扫一章记下明确新增；裸列举与指代都不算新增', () => {
    const ledger = scanChapterLedger(
      { sortNo: 5, title: '第五章' } as LocalChapter,
      '他拾起三枚铜钱。桌上还散着七枚铜钱，他没动。',
    )
    expect(ledger.artifacts).toEqual({ corner_coin: 3 })
  })

  it('累计声明超过账本 → P1 且 blocking=false（存疑提示，不拦停）', () => {
    const hit = balanceHits('他拾起三枚铜钱。其余的他没数。共十一枚。', { corner_coin: 1 })[0]
    expect(hit).toBeDefined()
    expect(hit.grade).toBe('P1')
    expect(hit.blocking).toBe(false)
    expect(hit.quotes?.[0]).toContain('共十一枚')
    expect(hit.message).toContain('差 7')
  })

  it('章内自洽不误报：本章自己列出过同一数值（裸列举或指代）', () => {
    expect(balanceHits('桌上散着五枚铜钱。共五枚。', { corner_coin: 1 })).toHaveLength(0)
    expect(balanceHits('他把那五枚铜钱收进怀里。共五枚。', { corner_coin: 1 })).toHaveLength(0)
  })

  it('差量在容忍范围内不报；没有前账更是不判', () => {
    expect(balanceHits('他拾起三枚铜钱。加上先前那两枚，共五枚。', { corner_coin: 1 })).toHaveLength(0)
    expect(balanceHits('共十一枚。')).toHaveLength(0)
  })

  it('真实样本正文的「共十一枚」必须被抓出来（这是本模块存在的理由）', () => {
    const sample = resolve(process.cwd(), '../模型写作样本/deepseek-v4-pro-0813.txt')
    if (!existsSync(sample)) return
    const codes = lintChapterWithRules({
      text: readFileSync(sample, 'utf8'),
      chapterNo: 5,
      artifactTotals: { corner_coin: 1 },
    }).map(issue => issue.code)
    expect(codes).toContain(BALANCE_CODE)
  })

  it('生成前就把账本摊给模型看（治本的一半）', async () => {
    const materials = await buildLedgerMaterials({
      orderedChapters: [
        {
          sortNo: 1,
          title: '第一章',
          summary: '第一章梗概',
          planMeta: {
            workflowLedger: {
              chapterNo: 1,
              title: '第一章',
              wordCount: 1800,
              characters: ['流白'],
              tail: '章末',
              artifacts: { corner_coin: 1 },
              updatedAt: '2026-09-26T00:00:00.000Z',
            },
          },
        } as unknown as LocalChapter,
      ],
      currentChapterNo: 2,
    })
    expect(materials['可数物件账本（写数量时必须对上）']).toContain('磨字铜钱：截至上一章共 1枚')
  })
})
describe('闸三 · 审核模型槽位', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  const seedTextModel = (name: string, modelCode: string) =>
    saveLocalAiModel({
      name,
      scene: 'text',
      provider: 'openai-compatible',
      protocol: 'openai_compatible',
      modelCode,
      baseUrl: 'http://127.0.0.1:9000/v1',
      maxContext: 128000,
      maxOutputTokens: 8192,
      status: 1,
    })

  it('审核分组复用文本模型库，不是生图库', () => {
    expect(sceneOfGroup('workflow_review')).toBe('text')
  })

  it('写作槽位与审核槽位各自独立记忆：同一个模型池里挑两个不同的模型', async () => {
    const writer = await seedTextModel('写作-直答型', 'deepseek-v4-pro')
    const reviewer = await seedTextModel('审核-思考型', 'qwen3.8-max')
    const store = useAiModelStore()
    await store.loadWorkflowModels(true)
    await store.loadReviewModels(true)
    // 两个槽位共用同一份文本模型清单，都能选到池子里的模型
    expect(store.workflowModels.map(item => item.code)).toContain(writer.data.code)
    expect(store.reviewModels.map(item => item.code)).toContain(reviewer.data.code)

    await store.setWorkflowModel(writer.data.code)
    await store.setReviewModel(reviewer.data.code)
    expect(store.workflowModel).toBe(writer.data.code)
    expect(store.reviewModel).toBe(reviewer.data.code)

    // 重新加载后仍各自保持：偏好分键落库，两个槽位不会互相覆盖
    await store.loadWorkflowModels(true)
    await store.loadReviewModels(true)
    expect(store.workflowModel).toBe(writer.data.code)
    expect(store.reviewModel).toBe(reviewer.data.code)
  })

  it('审核槽位留空时回落写作模型，升级前的行为不变', async () => {
    const writer = await seedTextModel('写作-直答型', 'deepseek-v4-pro')
    const store = useAiModelStore()
    await store.loadTextModels(true)
    await store.loadWorkflowModels(true)
    await store.loadReviewModels(true)
    await store.setTextModel(writer.data.code)
    await store.setWorkflowModel(writer.data.code)
    await store.setReviewModel('') // 用户在界面上选「跟随写作模型」

    expect(store.reviewModel).toBe('')
    const code = await resolveReviewModelCode({ config: {} } as unknown as LocalWorkflowRun)
    expect(code).toBe(writer.data.code)
  })

  it('正文生成真正使用工作流写作槽位，不被普通文本默认模型覆盖', async () => {
    const text = await seedTextModel('普通文本模型', 'text-default')
    const writer = await seedTextModel('长篇写作模型', 'novel-writer')
    const store = useAiModelStore()
    await store.loadTextModels(true)
    await store.loadWorkflowModels(true)
    await store.setTextModel(text.data.code)
    await store.setWorkflowModel(writer.data.code)

    await expect(resolveWorkflowModelCode({ config: {} } as unknown as LocalWorkflowRun)).resolves.toBe(writer.data.code)
  })

  it('活动任务热切换到最新写作与审核模型，不再被启动时的旧模型钉死', async () => {
    const writer = await seedTextModel('新写作模型', 'cheap-writer')
    const reviewer = await seedTextModel('新审核模型', 'cheap-reviewer')
    const store = useAiModelStore()
    await store.loadWorkflowModels(true)
    await store.loadReviewModels(true)
    await store.setWorkflowModel(writer.data.code)
    await store.setReviewModel(reviewer.data.code)

    const oldRun = {
      modelCode: 'old-expensive-writer',
      config: { modelCode: 'old-expensive-writer', reviewModelCode: 'old-expensive-reviewer' },
    } as unknown as LocalWorkflowRun
    await expect(resolveWorkflowModelCode(oldRun)).resolves.toBe(writer.data.code)
    await expect(resolveReviewModelCode(oldRun)).resolves.toBe(reviewer.data.code)
  })

  it('运行配置里显式指定的审核模型优先级最高', async () => {
    const run = { config: { reviewModelCode: 'qwen3.8-max' } } as unknown as LocalWorkflowRun
    await expect(resolveReviewModelCode(run)).resolves.toBe('qwen3.8-max')
  })
})

describe('闸三 · 三档开关', () => {
  const chaptersWithRecord = (record: Record<string, unknown> | null) =>
    [{ planMeta: record ? { qualityFix: record } : {} }] as unknown as LocalChapter[]

  it('默认档是「评审后自动改稿」：从没表过态的书走自动改稿', () => {
    expect(resolveGateThirdMode(null)).toBe('fix')
    expect(resolveGateThirdMode({})).toBe('fix')
    expect(resolveGateThirdMode({ selfCheckMode: '乱写的值' })).toBe('fix')
  })

  it('默认档改成 fix 后，旧数据的「只评审」不能被悄悄升级成改稿', () => {
    // criticEnabled:true 是旧版的"评审开、改稿关"，语义就是 review，绝不能跳到 fix
    expect(resolveGateThirdMode({ criticEnabled: true })).toBe('review')
    expect(resolveGateThirdMode({ autoFix: false })).toBe('review')
    expect(resolveGateThirdMode({ criticEnabled: true, writingRules: '随便写点什么' })).toBe('review')
  })

  it('selfCheckMode 三档直读，且新键在场时旧键不再抢权', () => {
    expect(resolveGateThirdMode({ selfCheckMode: 'off' })).toBe('off')
    expect(resolveGateThirdMode({ selfCheckMode: 'review' })).toBe('review')
    expect(resolveGateThirdMode({ selfCheckMode: 'fix' })).toBe('fix')
    expect(resolveGateThirdMode({ selfCheckMode: 'review', autoFix: true })).toBe('review')
    expect(resolveGateThirdMode({ selfCheckMode: 'fix', criticEnabled: false })).toBe('fix')
  })

  it('旧数据兼容：criticEnabled=false 读成关闭，autoFix=true/dry 读成自动改稿', () => {
    expect(resolveGateThirdMode({ criticEnabled: false })).toBe('off')
    expect(resolveGateThirdMode({ autoFix: true })).toBe('fix')
    expect(resolveGateThirdMode({ autoFix: 'dry' })).toBe('fix')
    expect(resolveGateThirdMode({ criticEnabled: true, autoFix: false })).toBe('review')
  })

  it('界面选项把默认档排第一，三档齐备', () => {
    expect(GATE_THIRD_MODE_OPTIONS.map(item => item.value)).toEqual(['fix', 'review', 'off'])
    expect(GATE_THIRD_MODE_OPTIONS[0].value).toBe(DEFAULT_GATE_THIRD_MODE)
    expect(GATE_THIRD_MODE_OPTIONS[0].label).toBe('评审后自动改稿')
  })

  it('fix 档直接自动改稿，只有显式 dry 才试跑', () => {
    expect(shouldPreviewFix({ config: {}, orderedChapters: chaptersWithRecord(null) })).toBe(false)
    expect(shouldPreviewFix({
      config: {},
      orderedChapters: chaptersWithRecord({ applied: false }),
    })).toBe(false)
    // 落过真正改过的记录同理
    expect(shouldPreviewFix({
      config: {},
      orderedChapters: chaptersWithRecord({ applied: true }),
    })).toBe(false)
    // 「dry」是长期档位，永远只试跑，与有没有记录无关
    expect(shouldPreviewFix({
      config: { autoFix: 'dry' },
      orderedChapters: chaptersWithRecord({ applied: true }),
    })).toBe(true)
  })
})


// ---------------------------------------------------------------------------
// 闸一 · 《流白》AI 味手册规则包（05-liubai-ai-flavor.json）
//
// 来源：C:\Users\30317\Desktop\Liubai_AI_Writing_Guide.docx（V1.0 / 2026-09-27）。
// 作者定档：① 规则每次生成都生效；② 命中交给模型修复 —— 所以硬禁词必须是 P1
// （quality-fixer 只吃 P0/P1）且 fix 里带上 §2.5 的替换方向，否则模型无从下手。
// ---------------------------------------------------------------------------
describe('闸一 · 《流白》AI 味手册规则包', () => {
  const BAN_SAMPLE = '流白端着杯子，没有喝。他攥着那枚铜钱，指节泛白，眸光微沉。'
  const SENTENCE_SAMPLE = [
    '他不知道，这一次推门进去会发生什么。',
    '真正的风暴才刚刚开始。',
    '并非他不愿说，而是不能说。',
    '这一刻，他终于明白了。',
  ].join('\n')

  it('规则包按手册 §2 全量落地（词库 A/B/C + 模板句 + 替换表）', () => {
    expect(qualityRulesMeta.liubaiWordCount).toBeGreaterThanOrEqual(45)
    expect(qualityRulesMeta.liubaiSentenceCount).toBeGreaterThanOrEqual(9)
  })

  it('生成前注入：本章约束带上手册硬禁词与 §2.5 替换表', () => {
    const block = describeChapterConstraints(5)
    expect(block).toContain('《流白》AI 味硬禁')
    expect(block).toContain('眸光')
    expect(block).toContain('指节泛白')
    expect(block).toContain('睥睨')
    expect(block).toContain('普通动词优先替换表')
    expect(block).toContain('看、看了看、看向')
    expect(block).toContain('绝对禁区')
  })

  it('生成后检测：词库按 A/B/C 汇总，定级 P1 且不作废整章', () => {
    const issues = lintChapterWithRules({ text: `${filler}\n${BAN_SAMPLE}`, chapterNo: 5 })
    const banned = issues.filter(issue => issue.code.startsWith('LIUBAI-BAN-'))
    expect(banned.map(issue => issue.code).sort()).toEqual(['LIUBAI-BAN-A', 'LIUBAI-BAN-B'])
    for (const issue of banned) {
      expect(issue.grade).toBe('P1')
      expect(issue.blocking).toBe(false)
      expect(String(issue.fix)).toContain('§2.5')
    }
    expect(String(banned.find(issue => issue.code === 'LIUBAI-BAN-A')?.fix)).toContain('看、看了看、看向')
  })

  it('生成后检测：手册 §2.4 模板句逐条命中', () => {
    const codes = lintChapterWithRules({ text: `${filler}\n${SENTENCE_SAMPLE}`, chapterNo: 5 })
      .map(issue => issue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'LB-UNKNOWN-THIS-TIME',
      'LB-STORM-BEGIN',
      'LB-NOT-BUT-VARIANT',
      'LB-FINALLY-UNDERSTAND',
    ]))
  })

  it('本书专用补遗（词库 D）与《墨痕长生》四条套句已落地', () => {
    expect(qualityRulesMeta.liubaiWordCount).toBeGreaterThanOrEqual(50)
    const block = describeChapterConstraints(5)
    expect(block).toContain('本书专用硬禁')
    expect(block).toContain('摩挲')
    const codes = lintChapterWithRules({
      text: `${filler}\n他摩挲着铜钱，垂眸不语。他并不知道，这将改变他的一生。`,
      chapterNo: 5,
    }).map(issue => issue.code)
    expect(codes).toContain('LIUBAI-BAN-D')
    expect(codes).toContain('LB-GOD-NARRATION')
  })

  it('命中后进施工单：模型能拿到「改哪、改成什么」', () => {
    const issues = lintChapterWithRules({ text: `${filler}\n${BAN_SAMPLE}`, chapterNo: 5 })
    expect(buildFixOrderText(issues)).toContain('手册硬禁词库A')
    expect(selectFixableIssues(issues).some(issue => issue.code.startsWith('LIUBAI-BAN-'))).toBe(true)
  })

  it('CLI 与平台必须共用同一份规则包（自检/rules 要同步）', () => {
    const platform = readFileSync(
      resolve(process.cwd(), 'src', 'config', 'quality-rules', '05-liubai-ai-flavor.json'),
      'utf8'
    )
    const cliPath = resolve(process.cwd(), '..', '自检', 'rules', '05-liubai-ai-flavor.json')
    if (!existsSync(cliPath)) return
    expect(readFileSync(cliPath, 'utf8')).toBe(platform)
  })
})

/**
 * 素材侧泄底扫描（端到端）。
 *
 * 上面用 MOHEN_SETTING 那个手写 fixture 只证明「闸门逻辑是对的」；真正会翻车的是
 * **实际喂给模型的那份素材**。这里直接拿《墨痕长生》平台资料包，按 1–536 章逐章过闸门，
 * 再用 00-spoiler-ban.json 里当章仍生效的禁语去扫结果——素材自己提前抖底牌，
 * 本该在开写之前就被这条用例拦住，而不是等正文写完才由闸一事后抓。
 */
describe('闸一·素材侧 · 《墨痕长生》资料包逐章泄底扫描', () => {
  const packPath = resolve(process.cwd(), 'public', 'mohen-pack.json')
  // 资料包不在（尚未交付或已清理）就跳过，不给别的用例平添一条对文件的硬依赖
  if (!existsSync(packPath)) return
  const settingUi = (JSON.parse(readFileSync(packPath, 'utf8')) as {
    run: { summary: { workflowSettingUi: Record<string, unknown> } }
  }).run.summary.workflowSettingUi

  it('1–536 章注入的素材，都不含该章仍生效的禁语', () => {
    const violations: string[] = []
    for (let chapterNo = 1; chapterNo <= 536; chapterNo += 1) {
      const brief = buildRevealedSettingBrief(settingUi, chapterNo)
      const material = [brief.characters, brief.power, brief.storylines].join('\n')
      for (const ban of getActiveBans(chapterNo)) {
        for (const term of ban.terms || []) {
          if (material.includes(term)) violations.push(`第${chapterNo}章 命中 ${ban.id} 的「${term}」`)
        }
        for (const pattern of ban.patterns || []) {
          if (new RegExp(pattern).test(material)) {
            violations.push(`第${chapterNo}章 命中 ${ban.id} 的句式 ${pattern}`)
          }
        }
      }
    }
    expect(violations.slice(0, 10)).toEqual([])
  })

  it('闸门确实在动：后卷角色与境界不会从第 1 章起就出现在素材里', () => {
    const early = buildRevealedSettingBrief(settingUi, 5)
    expect(early.characters).not.toContain('顾青崖')
    expect(early.characters).not.toContain('晏无终')
    expect(early.power).not.toContain('登仙')
    expect(early.storylines).not.toContain('死生门')
    expect(buildRevealedSettingBrief(settingUi, 24).characters).toContain('顾青崖')
    expect(buildRevealedSettingBrief(settingUi, 367).characters).toContain('晏无终')
  })

  // 防「空转通过」：万一哪天禁语表被清空、或闸门变成恒等函数，
  // 上面那条扫描会一声不响地全绿。这条拿一份故意泄底的素材，要求它必须被抓住。
  it('扫描本身有效：故意留一处后卷角色，必须被抓出来', () => {
    const leaky = {
      // 闸门会丢掉「冒号后没有内容」的条目，所以泄底样本必须带 background 才活得下来
      characters: [
        { name: '顾青崖', identity: '六十二年前旧人', background: '六十二年前曾在槐坡出现。' },
      ],
      storylines: [{ title: '某条线', desc: '第一卷只出现技术影子，第五卷完整爆发。' }],
    }
    const brief = buildRevealedSettingBrief(leaky, 1)
    const material = [brief.characters, brief.power, brief.storylines].join('\n')
    expect(material).toContain('顾青崖')
    const caught = getActiveBans(1).some(ban =>
      (ban.terms || []).some(term => material.includes(term))
    )
    expect(caught).toBe(true)
  })
})
