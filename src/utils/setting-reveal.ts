/**
 * 设定素材的剧透闸门（生成前注入约束 · 素材侧）。
 *
 * 为什么需要它：正文提示词的「主要人物 / 力量体系 / 故事线」三块素材，直接取自
 * `public/seed-volume1.json` 的 `characters` / `core.cultivation` / `storylines`，
 * 而那份文件是**全书写完后**的作者视角设定稿 —— 里面写着
 * 「（第七卷才反转点破）」「【写作纪律】：…绝不暴露守门人身份」这类只给作者看的批注，
 * 以及「真相：流白当年留下的守门人」这种一句话捅到底的说明。
 *
 * 结果就是自相矛盾：闸一在生成**后**拦「死生门」，提示词却自己先把「死生门」递到模型嘴边。
 * 实测把这份素材直接丢给 `自检/lint.mjs`，能扫出 8 条违规（含 4 条 P0/P1）。
 *
 * 两条防线，都是「缺省即安全」：
 *   1) `revealAtChapter` —— 条目级闸门。章号没到的条目整条不注入。
 *      缺省视为始终可见（0），所以旧数据行为不变。
 *   2) `stripAuthorNotes` —— 片段级消毒。剔掉卷次批注、【…】注记、「真相/实为」何句。
 *   3) `briefBackground` —— 卷一/当前阶段安全简介。写了它就**只**用它，
 *      gender / identity / motivation 全部不再注入，作者完全掌控喂进去的那句话。
 *
 * 章号口径与闸一共用：见 `src/config/quality-rules/00-spoiler-ban.json` 的 `volumeRanges`
 * 与各条 `bannedUntilChapter`。改排期改那张表，改可见性改 seed。
 */

type AnyRecord = Record<string, unknown>

const asText = (value: unknown): string => String(value ?? '').trim()

/** 没写 revealAtChapter 的条目一律视为「始终可见」 */
export const REVEAL_ALWAYS = 0

/**
 * 该条目在本章是否已解禁。
 * 章号未知（<=0，例如章纲批量规划阶段）时不设闸门，避免把设定整体抹空。
 */
export const isRevealedAt = (item: unknown, chapterNo: number): boolean => {
  const reveal = Number((item as AnyRecord | null)?.revealAtChapter ?? REVEAL_ALWAYS) || REVEAL_ALWAYS
  if (!Number.isFinite(chapterNo) || chapterNo <= 0) return true
  return reveal <= chapterNo
}

/** 作者批注消毒：这些片段只该给作者看，不该进正文提示词 */
const AUTHOR_NOTE_PATTERNS: RegExp[] = [
  // 「（第六卷回收：他的死是引路）」/「(第3卷…)」——卷次批注
  /[（(][^（()）]*第[一二三四五六七八九十百千\d]+卷[^（()）]*[）)]/g,
  // 「（留第五卷）」「（留阶段2—3）」「（见第六卷）」——排期批注
  /[（(](留|见)[^（()）]{0,24}[）)]/g,
  // 「【写作纪律】：…」「【注】：…」——整段作者注记（剔到句号）
  /【[^】]{0,12}】[：:]?[^。\n]*。?/g,
  // 「真相：…」「真实动机——…」——一句话捅底的说明
  /(真相|真实动机)[：:—-]+[^。；\n]*。?/g,
  // 「实为守门人之一」——身份反转的直接写法
  /实为[^。；\n]*/g,
]

export const stripAuthorNotes = (value: unknown): string => {
  let text = asText(value)
  if (!text) return ''
  for (const pattern of AUTHOR_NOTE_PATTERNS) {
    text = text.replace(pattern, '')
  }
  return text
    // 剔掉被掏空后留下的落单标点
    .replace(/[；;、,，]\s*(?=[。\n]|$)/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export interface SettingBrief {
  /** 主要人物：`姓名（性别，身份）：简介`；写了 briefBackground 的名字只留 `姓名：简介` */
  characters: string
  /** 力量体系：`体系概述；境界：甲→乙→丙`（只列已解禁境界） */
  power: string
  /** 故事线：`标题：简介`（只列已解禁故事线） */
  storylines: string
}

const readArray = (value: unknown): AnyRecord[] => (Array.isArray(value) ? (value as AnyRecord[]) : [])

/**
 * 把一份设定（seed 的 `core` + `characters` + `storylines`）按当前章号过滤成可安全注入的素材。
 * 纯函数：不读存储、不碰 run，方便测试直接拿真实 seed 断言「第 5 章素材里没有泄底词」。
 */
export const buildRevealedSettingBrief = (setting: unknown, chapterNo: number): SettingBrief => {
  const source = (setting || {}) as AnyRecord
  const characters = readArray(source.characters)
  const storylines = readArray(source.storylines)
  const core = (source.core || {}) as AnyRecord

  const characterLines = characters
    .filter(item => isRevealedAt(item, chapterNo))
    .filter(item => asText(item?.name))
    .map(item => {
      const brief = asText(item?.briefBackground)
      // 写了安全简介就只喂这一句：性别/身份/动机都可能带着后卷秘密
      if (brief) return `${asText(item.name)}：${brief}`
      const head = [asText(item.gender), asText(item.identity)].filter(Boolean).join('，')
      const body = [stripAuthorNotes(item.background), stripAuthorNotes(item.motivation)].filter(Boolean).join('；')
      return `${asText(item.name)}${head ? `（${head}）` : ''}：${body}`
    })
    .filter(line => line.split('：').slice(1).join('：').trim())

  const cultivation = (core.cultivation || {}) as AnyRecord
  const realms = readArray(cultivation.realms).filter(realm => isRevealedAt(realm, chapterNo))
  const realmChain = realms.map(realm => asText(realm?.name)).filter(Boolean).join('→')
  const powerIntro = asText(cultivation.briefIntro) || stripAuthorNotes(cultivation.intro)
  const powerLine = [powerIntro, realmChain ? `境界：${realmChain}` : ''].filter(Boolean).join('；')

  const storylineLines = storylines
    .filter(line => isRevealedAt(line, chapterNo))
    .filter(line => asText(line?.title))
    .map(line => `${asText(line.title)}：${stripAuthorNotes(line.desc)}`)
    .filter(line => line.split('：').slice(1).join('：').trim())

  return {
    characters: characterLines.join('\n'),
    power: powerLine,
    storylines: storylineLines.join('\n'),
  }
}
