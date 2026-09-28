import type { WorkflowResources } from '@/types/workflow'

/**
 * 工作流建书的本地资源（原 /writing/workflow/resources 服务端下发）。
 * 全是界面选项数据：平台清单、题材、标签、下拉字段与创建默认值。
 */
export const LOCAL_WORKFLOW_RESOURCES: WorkflowResources = {
  inspirationDirections: [
    '重生逆袭', '系统流', '无敌流', '苟道求生', '克苏鲁诡秘', '朝堂权谋',
    '谍战风云', '赛博都市', '规则怪谈', '女频甜宠', '大女主成长', '穿书自救',
  ],
  inspirationAssistActions: [
    { code: 'expand', title: '扩展成灵感', desc: '把一句想法扩成完整的故事灵感', icon: 'fa-solid fa-wand-magic-sparkles' },
    { code: 'random', title: '随机来一个', desc: '不知道写什么，让 AI 先抛一个', icon: 'fa-solid fa-dice' },
  ],
  platforms: [
    { code: 'qidian', name: '起点中文网', desc: '男频付费大站，长线养成', icon: 'fa-solid fa-book' },
    { code: 'fanqie', name: '番茄小说', desc: '免费阅读，节奏快爽点密', icon: 'fa-solid fa-bolt' },
    { code: 'qimao', name: '七猫免费', desc: '免费阅读，题材下沉', icon: 'fa-solid fa-cat' },
    { code: 'jinjiang', name: '晋江文学城', desc: '女频为主，情感细腻', icon: 'fa-solid fa-heart' },
    { code: 'zongheng', name: '纵横中文网', desc: '男频老牌站点', icon: 'fa-solid fa-mountain' },
    { code: 'feilu', name: '飞卢小说', desc: '脑洞快节奏短平快', icon: 'fa-solid fa-rocket' },
  ],
  // 平台分类榜单是服务端爬取的真实榜单数据，开源版无数据源；分类走自定义输入
  platformCategories: {},
  genres: [
    '玄幻', '仙侠', '都市', '历史', '科幻', '悬疑', '游戏', '体育',
    '军事', '奇幻', '武侠', '现实', '古言', '现言', '幻言', '衍生同人',
  ],
  tags: [
    '升级流', '无敌流', '系统', '重生', '穿越', '苟系', '争霸', '种田',
    '克系', '规则怪谈', '无限流', '悬疑破案', '甜宠', '虐恋', '宫斗', '群像',
  ],
  selectFields: [
    { key: 'targetWords', label: '目标字数', options: ['30万字', '50万字', '100万字', '150万字', '200万字以上'] },
    { key: 'chapterTargetWords', label: '单章字数（可填区间，如 1800–4200字）', options: ['1800–4200字', '2200–3800字', '2000字', '3000字', '4000字', '6000字'] },
    { key: 'protagonist', label: '主角性别', options: ['男主', '女主', '双主角'] },
    { key: 'storyPerspective', label: '叙事人称', options: ['第三人称', '第一人称'] },
    { key: 'audience', label: '目标读者', options: ['男频读者', '女频读者', '全频读者'] },
    { key: 'volumeRelay', label: '写完整卷之后', options: ['停下等我点继续', '自动接着写下一卷'] },
  ],
  creationDefaults: {
    targetWords: '100万字',
    chapterTargetWords: '3000字',
    platform: '番茄小说',
    genre: '玄幻',
    protagonist: '男主',
    storyPerspective: '第三人称',
    audience: '男频读者',
    volumeRelay: '停下等我点继续',
  },
}
