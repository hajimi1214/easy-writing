/**
 * 旧版（2026-08 批Z 简版）默认提示词的文本指纹。
 *
 * 2026-08-30 老服务端提示词全量回迁后，默认值整体换代。用户目录里可能躺着
 * 按旧默认值生成、但从未被用户修改过的 md 段落——装载时命中这些指纹的段落
 * 视为"未修改"，自动升级为新默认值；用户真正改过的文本不受影响。
 * 指纹由旧 defaults 文件的每个 defaultText.trim() 经 djb2 哈希生成。
 */
export const LEGACY_PROMPT_TEXT_HASHES = new Set<string>([
  'lxx9v6', '9vqtvy', '1x78phq', '1s3c6eh', 'dkkcfu', 'rj7t7', '1lauauv', 'qra2qa',
  '18cdp5s', '7wmynw', 'zsid5', '2f132j', '18susr5', '1ep29yo', '521rsf', '1eurlzn',
  '3qhfsc', 'wz7ctp', 'jg35hw', 'c37lg9', 'mgen6v', 'omhj1m', 'a02ncy', 'bzzbtg',
  'oq8myh', '1sqwojt', '1v3zaq7', '1vv7umc', 'ts9cyw', 'woul96', '1apm9wm', '1yg3783',
  '1ahyabd', '1qdd2a2', 'qs2r0d', '1ff19sr', 'vaqgle', 'q8j0cp', '14a0oet', '8ubr7',
  'xl0olv', '1ypt3j9', '1n50br2', '1ayp3is', 'ak4nom', '1v41rp6', 'tltx6x', 'q8eoyh',
  '1r65x1m', 'gshmal', 'nr3rrn', 'suozbs', '1kvwkm8', 'ay7gqz', '1srhwf5', '1k0xfvp',
  'gkh7sk', '1qt8vhm', 'imkojo', 'x6cmu', 'l3xzwn', 'la8mm8', '89yr15', 'smei4p',
  '1fhl6ke', 'shvxnw', 'ro0ib2',
  // 2026-09-29：正文与审查默认提示词加入跨章结构/人物段首去重。
  // 只迁移完全等于上一版默认值的槽位，用户自己改过的提示词继续保留。
  '1g0smdn', 'b9ghkz',
])

/** djb2 字符串哈希（与指纹生成脚本一致） */
export const hashPromptText = (text: string): string => {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
