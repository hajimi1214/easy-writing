import { describe, expect, it } from 'vitest'
import { runLocalChapterQualityCheck } from '@/utils/local-quality-check'
import { applyParagraphPatches, buildFixOrderText } from '@/utils/quality-fixer'
import type { WorkflowQualityIssue } from '@/types/workflow'

/**
 * 「精准定位」的契约测试。
 *
 * 核心断言不是"有没有报问题"，而是"报出来的段号能不能被修复器直接用"：
 * 规则报 P7，修复器按 P7 套补丁就必须套得上去。段号一旦错位，
 * applyParagraphPatches 会因锚点不匹配整批拒绝，精修失败又不回退整章重写，
 * 自检就永远修不过——这正是之前死锁的第二层原因。
 */

/**
 * 注意：不能用 padEnd 凑长度——paragraphsOf 会 trim，而 JS 的 trim 连全角空格也吃，
 * 填充会被整段抹掉。邻章重复规则只比较 40 字以上的段落，必须给真实长度的句子。
 */
const buildChapter = (paragraphs: string[]) => paragraphs.join('\n')

const runCheck = (text: string, previousText?: string) =>
  runLocalChapterQualityCheck({
    chapterId: 1,
    chapterNo: 1,
    chapterTitle: '测试章',
    text,
    previousText,
    targetWords: 10,
    contentVersion: 1,
  })

const pick = (issues: WorkflowQualityIssue[], code: string) =>
  issues.find(issue => issue.code === code)

describe('自检规则给出可落地的段落定位', () => {
  it('引号违规报出的段号，修复器能按这个段号精准套用补丁', () => {
    const paragraphs = [
      '第一章的开头叙述，雨下得很稳。',
      '他沿着青石台阶往上走，脚步声被雨声盖住了。',
      '门内有人抬眼看了他一下，又低下头去。',
      '案上的灯芯爆了一下，火光颤了颤。',
      '他把手里的东西放下，没有立刻开口。',
      '对面的人终于抬起头，目光落在他脸上。',
      '他摇头道：「不必了。」',
      '屋外的雨还在下，没有停的意思。',
    ]
    const text = buildChapter(paragraphs)
    const issue = pick(runCheck(text).issues, 'dialogue_quotes_forbidden')
    expect(issue, '应当报出引号违规').toBeTruthy()
    // 第 7 段（1 为起点）才是对白段
    expect(issue!.paragraphs).toContain(7)

    // 端到端：拿规则报的段号直接让修复器套补丁，套得上才算真定位
    const target = issue!.paragraphs![0]
    const applied = applyParagraphPatches(text, [
      {
        startParagraph: target,
        endParagraph: target,
        anchor: '不必了',
        replacement: '他摇头。\n不必了。',
      },
    ])
    expect(applied.ok, `段号 P${target} 应当能套上补丁：${applied.error || ''}`).toBe(true)
    expect(applied.text).toContain('不必了。')
    expect(applied.text).not.toContain('「')
  })

  it('段号错位时修复器拒绝写回，而不是悄悄改错地方', () => {
    const paragraphs = [
      '第一章的开头叙述，雨下得很稳。',
      '他沿着青石台阶往上走，脚步声被雨声盖住了。',
      '他摇头道：「不必了。」',
    ]
    const text = buildChapter(paragraphs)
    const issue = pick(runCheck(text).issues, 'dialogue_quotes_forbidden')
    expect(issue!.paragraphs).toEqual([3])

    // 故意报错段号：锚点应该在 P3，却说 P1
    const applied = applyParagraphPatches(text, [
      { startParagraph: 1, endParagraph: 1, anchor: '不必了', replacement: '他摇头。\n不必了。' },
    ])
    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('锚点不匹配')
    expect(applied.text).toBe(text)
  })

  it('施工单带上「命中段落」，模型不用靠片段猜位置', () => {
    const text = buildChapter([
      '第一章的开头叙述，雨下得很稳。',
      '他摇头道：不必了。',
      '屋外的雨还在下，没有停的意思。',
    ])
    const notice = runCheck(text)
    const order = buildFixOrderText(notice.issues)
    // 冒号式对白在第 2 段，施工单必须写出 P2
    expect(order).toContain('P2')
    expect(order).toContain('命中段落')
  })

  it('邻章重复报出的是本章开头那一段的段号', () => {
    const tail = '他站在门口，回头看了一眼那条长长的巷子，雨还在下，青石板上积了一层薄薄的水光，把檐下的灯笼影子拉得很长很长。'
    const previous = buildChapter([
      '上一章的结尾叙述，事情到这里已经告一段落，该交代的都交代完了。',
      tail,
    ])
    const text = buildChapter([
      tail,
      '这一章换了完全不同的场景与人物，写的是另一处院落里发生的另一件事，与方才那条巷子毫无关系。',
    ])
    const issue = pick(runCheck(text, previous).issues, 'adjacent_chapter_repeat')
    expect(issue, '应当报出邻章重复').toBeTruthy()
    expect(issue!.paragraphs).toEqual([1])
  })
})

describe('规则轨的点名型问题同样带段号', () => {
  it('剧透红线（P0 阻断项）报出的段号能直接用于精准修复', async () => {
    const { getActiveBans } = await import('@/utils/quality-rules')
    // 自证不空转：第 1 章必须有生效的禁语，否则这条用例会一声不响地绿过去
    const ban = getActiveBans(1).find(item => (item.terms || []).some(Boolean))
    expect(ban, '第 1 章应当有生效的剧透禁语').toBeTruthy()
    const term = (ban!.terms || []).find(Boolean)!

    const paragraphs = [
      '夜色压下来，巷口的灯笼只亮了一盏，雨水顺着檐角往下淌。',
      '他推开门，没有说话，径直走到案前站定。',
      '老头抬眼看了看他，忽然笑了一声。',
      '屋子里安静下来，只剩下两个人的呼吸声。',
      `那人报出一个名字，正是${term}，说完便不再开口。`,
      '沈砚没有动，只是看着门外的雨。',
    ]
    const text = paragraphs.join('\n')

    const issue = runCheck(text).issues.find(item => item.code === ban!.id)
    expect(issue, `应当报出剧透红线 ${ban!.id}`).toBeTruthy()
    expect(issue!.paragraphs).toContain(5)

    // 端到端：拿规则报的段号直接精准改写，不该牵动别的段落
    const target = issue!.paragraphs![0]
    const applied = applyParagraphPatches(text, [
      {
        startParagraph: target,
        endParagraph: target,
        anchor: term,
        replacement: '那人报出一个名字，说完便不再开口。',
      },
    ])
    expect(applied.ok, `段号 P${target} 应当能套上补丁：${applied.error || ''}`).toBe(true)
    expect(applied.text).not.toContain(term)
    expect(applied.text).toContain('沈砚没有动，只是看着门外的雨。')
  })
})
