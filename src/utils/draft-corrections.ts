/**
 * 存量内容修正（一次性 · 幂等 · 只认锚点）
 *
 * 背景：导出链路已经会剥离工程残留（[Pn] 段号 / 评分行 / 章号串位），
 * 但那些"内容本身"的毛病——重复句、硬禁词、时序倒挂、同一段信息说两遍——
 * 洗不掉，因为它们就长在正文里。这一类只能改库。
 *
 * 为什么做成平台自检而不是外部脚本：
 *   浏览器版的正文存在 IndexedDB（库 ew-writing-local / 表 chapter_contents），
 *   不在磁盘上，外部工具碰不到。所以让平台自己在页面加载时修一次。
 *
 * 安全设计：
 *   1. 只认书名精确匹配 + 章标题精确匹配的章节，其余一律不碰
 *   2. 每条改动先做锚点断言：命中不是 1 次就跳过并记进 problems，绝不猜
 *   3. 幂等：跑完把标志位写进 localStorage；已改过的条目会识别出来并跳过
 *   4. 只有 problems 为空时才置完成标志，否则下次加载重试（避免半途而废却以为改完了）
 *   5. 只走平台自己的保存通道（saveChapterLocal），不生写存储记录
 */

import { getLocalLibraryStorage, LOCAL_USER_ID } from '@/storage/local-library'
import { getWritingStorage } from '@/storage'
import { countWords } from '@/utils/word-count'

/** 完成标志。改动清单变更时请升版本，否则已置位的客户端不会再跑。 */
const FLAG_KEY = 'ew.content-corrections.v1.done'

/** 前缀去重的最小长度：低于这个长度的短对白（「坐。」「行。」）不参与前缀判定，避免误删。 */
const MIN_DUP_LEN = 8

interface Correction {
  /** 章标题（不带「第N章」前缀） */
  ch: string
  /** 说明，只用于报告 */
  note: string
  /** 平台原文里必须精确命中 1 次的片段 */
  from: string
  /** 替换成什么；空串表示删除 */
  to: string
}

interface CorrectionReport {
  /** 是否因为已跑过而跳过 */
  skipped: boolean
  /** 实际写入的章节数 */
  chapters: number
  /** 应用的改动条数 */
  applied: number
  /** 剥掉的工程残留条数 */
  artifacts: number
  /** 删掉的相邻重复行条数 */
  dupLines: number
  /** 未能应用的条目说明 */
  problems: string[]
}

const CORRECTIONS: Correction[] = [
  {
    ch: '买棺人',
    note: '剧透边缘：直接断言了身份',
    from: '若那买棺人就是今夜来的老人，那他凭什么认为，六十二年前站在柜台后头的人，是流白本人。',
    to: '若那买棺人就是今夜来的老人，那他凭什么认定，六十二年前站在柜台后头的人，今日还站在柜台后头。',
  },
  {
    ch: '人死在铺里',
    note: '硬禁词「鼻息」#1',
    from: '流白蹲下先探鼻息，气很浅，进出都慢。',
    to: '流白蹲下先看胸口，起伏很浅，进出都慢。',
  },
  {
    ch: '人死在铺里',
    note: '硬禁词「鼻息」#2',
    from: '鼻息没了，颈侧也不再动。',
    to: '胸口不再起伏，颈侧也不再动。',
  },
  {
    ch: '槐坡三十二号',
    note: '同一件事连说两遍（下一句信息更全）',
    from: '\n你哥也叫宋九斤。\n',
    to: '\n',
  },
  {
    ch: '你一点没变',
    note: '相邻重复行',
    from: '就这些。\n就这些。',
    to: '就这些。',
  },
  {
    ch: '流白不记得',
    note: '筷子还没拿出来就「停在半空」（时序倒挂）',
    from: '流白把灯挑亮一点，拿筷子的手停在半空。那半笔你见过吗。',
    to: '流白把灯挑亮一点。那半笔你见过吗。',
  },
  {
    ch: '流白不记得',
    note: '同一问句隔 3 行问两遍，且写着「把这事转开」却又问同一个问题',
    from: '流白没接话，把这事转开。你见过那半笔吗。\n流白从柜台里拿了两双竹筷，递过去一双。',
    to: '流白没接话，把这事搁下。他从柜台里拿了两双竹筷，递过去一双。',
  },
  {
    ch: '流白不记得',
    note: '同一段信息连说两遍：删掉第一遍（信息在下一条保留一次）',
    from: '沈家旧档最早一次被动过，在六十多年前。签押的名字对不上人，那字没在别处出现过，像凭空多出来一笔。',
    to: '',
  },
  {
    ch: '流白不记得',
    note: '同一段信息连说两遍：第二遍只说一次，并去掉重复的那次递纸片',
    from: '昨晚没细说。从六十多年前就有人借过。最早那次留下的签押，对不上人了，那名字没在别处出现过，像凭空多出来一个字。她一边说，一边从袖口抽出一张折角的小纸片递过去。纸上只记着一个字，墨淡。',
    to: '昨晚没细说。沈家旧档最早一次被动过，在六十多年前。那次留下的签押对不上人，那名字没在别处出现过，像凭空多出来一笔。',
  },
  {
    ch: '流白不记得',
    note: '同一个比喻隔 16 行说了两遍（叙述一遍，又借人物说一遍）',
    from: '但从不是这样，整段日子像被人抽了轴，前后还能接上，中间空得干净。',
    to: '但从不是这样，中间那段不是记不清，是根本没有过。',
  },
  {
    ch: '他在看谁',
    note: '改稿器把章号写进了正文',
    from: '第17章你给过我几页旧葬录抄本，',
    to: '你给过我几页旧葬录抄本，',
  },
  {
    ch: '我见过你',
    note: '同一个「站在门外、挽着袖子、额角有汗」的动作连写两遍，上一行结尾已写过一次',
    from: '\n沈照月站在门槛外，袖子挽到小臂，额角有汗。\n',
    to: '\n',
  },
  {
    ch: '流白不记得',
    note: '「沈照月一愣。」又成了下一行的开头（只有 6 字，够不上净化器的 12 字门槛）',
    from: '沈照月一愣。\n沈照月一愣。门外巷子里有人踩翻竹篓，',
    to: '沈照月一愣。门外巷子里有人踩翻竹篓，',
  },
  {
    ch: '流白不记得',
    note: '巷子里踩翻竹篓这一段又写了一遍（标点不同，净化器只认"相同/首尾包含"，不认"相似"）',
    from: '\n门外巷子里有人踩翻竹篓。声音不大，就一下。流白没追，看了一眼沈照月，把水患簿递回。\n',
    to: '\n',
  },
]

/** 剥掉自动改稿留下的段号与模型自作主张吐出的评分行 */
const stripArtifacts = (text: string) => {
  let n = 0
  const out = String(text || '')
    .replace(/\[\s*[Pp]\s*\d+\s*\]\s*/g, () => {
      n += 1
      return ''
    })
    .replace(
      /(?:您的打分|审查评分|综合评分|本章评分|AI评分)\s*[：:]?\s*\d+\s*\/\s*\d+\s*/g,
      () => {
        n += 1
        return ''
      },
    )
  return { out, n }
}

/**
 * 删相邻重复行：整行相同，或整行是邻行的前缀（自动改稿分段落盘时的常见残留）。
 * 前缀判定要求较短那行 >= MIN_DUP_LEN，否则会误删「坐。」「行。」这类短对白。
 */
const dropDupLines = (text: string) => {
  const lines = String(text || '').split('\n')
  const keep: string[] = []
  let n = 0
  for (const line of lines) {
    const cur = line.trim()
    const prev = keep.length ? keep[keep.length - 1].trim() : ''
    const isDup =
      Boolean(cur) &&
      Boolean(prev) &&
      (cur === prev ||
        ((prev.startsWith(cur) || cur.startsWith(prev)) &&
          Math.min(cur.length, prev.length) >= MIN_DUP_LEN))
    if (isDup) {
      n += 1
      continue
    }
    keep.push(line)
  }
  return { out: keep.join('\n'), n }
}

/** 章标题去掉「第N章」前缀后比较，兼容库里两种写法 */
const bareTitle = (value: string) => String(value || '').trim().replace(/^第\d+章\s*/, '')

/**
 * 跑一次存量修正。
 * @param bookTitle 书名（精确匹配）
 * @param force 强制重跑（忽略完成标志），用于手动重试
 */
export const runContentCorrections = async (
  bookTitle = '墨痕长生',
  force = false,
): Promise<CorrectionReport> => {
  const empty: CorrectionReport = {
    skipped: false,
    chapters: 0,
    applied: 0,
    artifacts: 0,
    dupLines: 0,
    problems: [],
  }

  if (!force && localStorage.getItem(FLAG_KEY) === '1') {
    return { ...empty, skipped: true }
  }

  const library = getLocalLibraryStorage()
  const writing = getWritingStorage()

  const books = await library.listLocalBooks({})
  const book = books.find((item) => String(item.title || '').trim() === bookTitle)
  // 书还没建（新装、换机器）不算失败，下次加载再看
  if (!book) return empty

  // getLocalBookTree 直接返回卷数组，章节挂在每卷的 children 上
  const tree = await library.getLocalBookTree(book.id)
  const chapters = tree.flatMap((volume) => volume.children || [])

  const report: CorrectionReport = { ...empty }
  const targets = [...new Set(CORRECTIONS.map((item) => item.ch))]

  for (const title of targets) {
    const matched = chapters.filter((item) => bareTitle(item.title) === title)
    if (matched.length !== 1) {
      report.problems.push(`章标题「${title}」匹配到 ${matched.length} 章，跳过`)
      continue
    }
    const chapter = matched[0]
    const draft = await writing.getChapterByIdentity(LOCAL_USER_ID, String(book.id), chapter.id)
    if (!draft) {
      report.problems.push(`读不到正文：${title}`)
      continue
    }

    let text = String(draft.textContent || '').replace(/\r\n/g, '\n')
    const original = text

    // 1) 先剥工程残留
    const stripped = stripArtifacts(text)
    if (stripped.n) {
      text = stripped.out
      report.artifacts += stripped.n
    }

    // 2) 逐条应用改动
    for (const item of CORRECTIONS.filter((correction) => correction.ch === title)) {
      const times = text.split(item.from).length - 1
      if (times === 1) {
        text = text.replace(item.from, item.to)
        report.applied += 1
      } else if (times === 0) {
        // 已经改过了就当成功，否则记问题
        if (!item.to || !text.includes(item.to)) {
          report.problems.push(`锚点未命中｜${title}｜${item.note}`)
        }
      } else {
        report.problems.push(`锚点命中 ${times} 次｜${title}｜${item.note}`)
      }
    }

    // 3) 改动可能新造出相邻重复行，再清一遍
    const deduped = dropDupLines(text)
    if (deduped.n) {
      text = deduped.out
      report.dupLines += deduped.n
    }

    if (text === original) continue

    await writing.saveChapterLocal({
      ...draft,
      textContent: text,
      updatedAt: Date.now(),
      dirty: true,
    })
    await library.updateLocalChapterContentMeta({
      bookId: book.id,
      chapterId: chapter.id,
      wordCount: countWords(text),
      title: chapter.title,
    })
    report.chapters += 1
  }

  // 只有全部落地才置完成标志，否则下次加载重试
  if (!report.problems.length) {
    localStorage.setItem(FLAG_KEY, '1')
  } else {
    console.warn('[存量修正] 有条目没落地，下次加载会重试：', report.problems)
  }

  return report
}

/** 清掉完成标志，让下次加载重跑一遍（排查用） */
export const resetContentCorrections = () => localStorage.removeItem(FLAG_KEY)
