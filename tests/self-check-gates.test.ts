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
import { buildLedgerMaterials, scanChapterLedger } from '@/utils/fact-ledger'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mergeCriticReport, toCriticIssues } from '@/utils/ai-critic'
import { buildRevealedSettingBrief, stripAuthorNotes } from '@/utils/setting-reveal'
import {
  buildFixOrderLines,
  buildFixOrderText,
  runChapterFixRewrite,
  selectFixableIssues,
  summarizeFixDiff,
} from '@/utils/quality-fixer'
import type { LocalChapter } from '@/storage/local-library-types'
import type { WorkflowQualityIssue } from '@/types/workflow'
import { useAiModelStore } from '@/stores/ai-model'
import { saveLocalAiModel, sceneOfGroup } from '@/storage/local-ai-models'
import { resolveReviewModelCode, shouldPreviewFix } from '@/utils/local-workflow-writer'
import {
  DEFAULT_GATE_THIRD_MODE,
  GATE_THIRD_MODE_OPTIONS,
  resolveGateThirdMode,
} from '@/utils/self-check-mode'
import type { LocalWorkflowRun } from '@/storage/local-workflow'

const filler = '他走进院子，脚步很轻。'.repeat(140) // 1540 个中文字，跨过字数下限

describe('闸一 · 生成前约束注入', () => {
  it('第1章列全卷一红线', () => {
    const text = describeChapterConstraints(1)
    expect(text).toContain('槐坡32号')
    expect(text).toContain('不得出现「死生门」')
    expect(text).toContain('活人顶替死人') // 概念类只给描述，不列原文
    expect(text).toContain('2500–3500')
    expect(text).toContain('300 字内')
  })

  it('第45章死生门解禁，无名仙朝与归来者句仍禁', () => {
    const text = describeChapterConstraints(45)
    expect(text).not.toContain('不得出现「死生门」')
    expect(text).toContain('不得出现「无名仙朝」')
    expect(text).toContain('归来者')
  })

  it('第30章是放宽章，写明允许次数', () => {
    expect(describeChapterConstraints(30)).toContain('最多出现 1 次')
  })

  it('第229章已超出卷表，只给篇幅约束', () => {
    expect(resolveVolumeOfChapter(229)).toBeNull()
    expect(describeChapterConstraints(229)).not.toContain('本卷')
  })

  it('chapterNo 非法时返回空串，不污染提示词', () => {
    expect(describeChapterConstraints(0)).toBe('')
    expect(describeChapterConstraints(Number.NaN)).toBe('')
  })

  it('13 条红线在第一章全部生效', () => {
    expect(getActiveBans(1)).toHaveLength(13)
    expect(resolveVolumeOfChapter(101)?.name).toBe('无名仙朝')
  })
})

describe('闸一 · 生成后逐章体检', () => {
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
    const twice = lintChapterWithRules({ text: `死生门。死生门。${filler}`, chapterNo: 30 })
    expect(twice.find(issue => issue.code === 'SPOIL-SSM')?.message).toContain('超出限制')
    const once = lintChapterWithRules({ text: `死生门。${filler}`, chapterNo: 30 })
    expect(once.find(issue => issue.code === 'SPOIL-SSM')).toBeUndefined()
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
      `宁墨抬头看见流白站在院里。${'他走了很久。'.repeat(60)}`
    )
    expect(ledger.characters).toContain('流白')
    expect(ledger.characters).toContain('宁墨')
    expect(ledger.characters).not.toContain('顾九归')
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
    const withLedger = chapter(1, 1, '起', '宁墨进山', {
      workflowLedger: { chapterNo: 1, title: '起', wordCount: 100, characters: ['宁墨'], tail: '…', updatedAt: '' },
    })
    const materials = await buildLedgerMaterials({
      orderedChapters: [withLedger, chapter(2, 2, '承', '发现墨迹'), chapter(3, 3, '转', '')],
      currentChapterNo: 3,
    })
    expect(materials['全书进度（已写完的章节，按序）']).toContain('第2章《承》')
    expect(materials['全书进度（已写完的章节，按序）']).not.toContain('第3章')
    expect(materials['全书进度（已写完的章节，按序）']).toContain('槐坡32号')
    expect(materials['近期章纲（最近 12 章，承接用）']).toContain('发现墨迹')
    expect(materials['人物出场表（未列出的人物不得突然出场）']).toContain('宁墨（最近第1章）')
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
      scores: { 逻辑: 3 },
    })
    expect(merged.issues).toHaveLength(2)
    expect(merged.issues[0].grade).toBe('P0')
    expect(merged.requiresAction).toBe(true)
    expect(merged.critic?.status).toBe('available')
    expect(merged.critic?.scores).toEqual({ 逻辑: 3 })
  })
})

describe('闸三 · 施工单修复执行器', () => {
  const issue = (patch: Record<string, unknown>) =>
    ({ source: 'rule', code: 'x', dimension: '篇幅', message: 'm', severity: 'high', blocking: true, grade: 'P0', ...patch }) as unknown as WorkflowQualityIssue

  it('只挑 P0/P1 且带动作的项；P2 与空话排除', () => {
    const picked = selectFixableIssues([
      issue({ code: 'a', fix: '删减至 1 次以内' }),
      issue({ code: 'b', grade: 'P2', fix: '检查是否注水' }),
      issue({ code: 'c', fix: '未给出施工单：请人工判断' }),
      issue({ code: 'd', fix: '' }),
    ])
    expect(picked.map(item => item.code)).toEqual(['a'])
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

  it('没有可执行施工单时不发模型调用', async () => {
    const result = await runChapterFixRewrite({
      modelCode: 'deepseek-chat',
      materials: {},
      chapterText: '正文',
      issues: [issue({ code: 'b', grade: 'P2', fix: '检查是否注水' })],
    })
    expect(result.ok).toBe(false)
    expect(result.orderCount).toBe(0)
    expect(result.error).toContain('没有可执行的施工单')
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

// ---------------------------------------------------------------------------
// 闸一·素材侧 · 设定泄底闸门
//
// 背景：正文提示词的「主要人物 / 力量体系 / 故事线」直接取自 seed-volume1.json，
// 而那是**全书写完后**的作者设定稿 —— 曾经同一份提示词里既有红线「不得出现『死生门』」，
// 又有素材「死生门与无名仙朝」「（第七卷才反转点破保护规则）」「真相：流白当年留下的守门人」。
// 闸一在生成后拦，提示词却在生成前递刀。这组用例就是钉死这件事不再复发。
// ---------------------------------------------------------------------------

/** 卷一（第 5 章）生成素材里绝对不该出现的词 */
const VOLUME1_FORBIDDEN = [
  '死生门', '无名仙朝', '归来者', '飞升', '轮回',
  '守门人', '民国', '第四卷', '第五卷', '第六卷', '第七卷',
]

/** 读真实 seed；缺文件时不判失败（与 runCli 的容错口径一致） */
const loadSeedSetting = (): Record<string, unknown> | null => {
  const file = resolve(process.cwd(), 'public', 'seed-volume1.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe('闸一·素材侧 · 设定泄底闸门', () => {
  it('第5章素材里没有任何后卷泄底词', () => {
    const seed = loadSeedSetting()
    if (!seed) return
    const brief = buildRevealedSettingBrief(seed, 5)
    const blob = [brief.characters, brief.power, brief.storylines].join('\n')
    expect(blob.length).toBeGreaterThan(0)
    for (const word of VOLUME1_FORBIDDEN) {
      expect(blob, `第5章素材不该出现「${word}」`).not.toContain(word)
    }
  })

  it('后卷人物卷一不注入，到了排期章才解禁', () => {
    const seed = loadSeedSetting()
    if (!seed) return
    const early = buildRevealedSettingBrief(seed, 5).characters
    expect(early).toContain('流白')
    expect(early).toContain('宁墨')
    expect(early).not.toContain('顾九归')
    expect(early).not.toContain('执灯人')
    expect(early).not.toContain('九人旧信')
    // 顾九归按排期卷六（165）开闸
    expect(buildRevealedSettingBrief(seed, 165).characters).toContain('顾九归')
  })

  it('力量体系只列已解禁境界，飞升与无名在卷一不出现', () => {
    const seed = loadSeedSetting()
    if (!seed) return
    const early = buildRevealedSettingBrief(seed, 5).power
    expect(early).toContain('染墨')
    expect(early).not.toContain('飞升')
    expect(early).not.toContain('无名')
    expect(buildRevealedSettingBrief(seed, 133).power).toContain('飞升')
  })

  it('故事线只注入本卷与已过卷', () => {
    const seed = loadSeedSetting()
    if (!seed) return
    const early = buildRevealedSettingBrief(seed, 5).storylines
    expect(early).toContain('槐坡')
    expect(early).not.toContain('死生门（第二卷）')
    expect(buildRevealedSettingBrief(seed, 31).storylines).toContain('死生门（第二卷）')
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
    const seed = loadSeedSetting()
    if (!seed) return
    expect(buildRevealedSettingBrief(seed, 0).characters).toContain('顾九归')
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

  it('fix 档只在「从没试跑过」时试跑一次，不会永远停在试跑（死锁回归）', () => {
    // 第一次：全书没有任何改稿记录 → 只试跑
    expect(shouldPreviewFix({ config: {}, orderedChapters: chaptersWithRecord(null) })).toBe(true)
    // 试跑落过一条 applied:false 的记录之后，下一章必须真的改稿 —— 原先这里仍是 true，卡死
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
