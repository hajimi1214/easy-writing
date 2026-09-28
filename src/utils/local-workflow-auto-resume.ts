import type { WorkflowTask } from '@/types/workflow'
import { listLocalWorkflowRuns, readRepairedLocalTask, writeLocalWorkflowTask } from '@/storage/local-workflow'
import { resumeLocalWorkflowTask } from '@/utils/local-workflow-control'

const RECOVERABLE_FAILURE =
  /自检尚未通过|同一组问题连续|请求失败（HTTP (?:400|402|408|425|429|5\d\d)）|账户余额不足|额度不足|余额不足|body is not valid json|响应超时|网络请求失败|network|load failed|ECONNRESET|ETIMEDOUT|ERR_NETWORK|上游返回空内容|生成结果为空|自检结果为空|模型思考耗尽输出上限|模型只返回了思考过程|模型思考超出正文预算/i
const DUPLICATE_TAB_FALSE_CANCEL = /同一本书已有生成器在其他页签运行，本页签重复任务已停止/

/**
 * 用户主动暂停、取消和待确认绝不重启；排队交接、关页中断及可判定为瞬时/可修复的失败自动接回。
 * 这样守护器不会把“暂停”当故障覆盖掉，也不会因一次网关抖动或自检未收敛永久停书。
 */
export const shouldAutoResumeBookTask = (task: WorkflowTask | null | undefined) =>
  Boolean(
    task
      && task.bizType === 'book_generate'
      && (
        // 章节交接时任务会短暂落成 queued。若恰逢刷新、热更新或换模型，原调用栈已经消失，
        // 但任务既不是失败也不是中断；守护器必须把它重新接回，否则会永远停在“下一章排队中”。
        task.status === 'queued'
        || (task.status === 'interrupted' && task.interruptedReason === 'app_closed')
        || (task.status === 'failed' && RECOVERABLE_FAILURE.test(String(task.errorMessage || '')))
        || (task.status === 'canceled' && DUPLICATE_TAB_FALSE_CANCEL.test(String(task.errorMessage || '')))
      ),
  )

/**
 * 页面里的写书循环随页面生命周期运行。平台重新打开后扫描每个工作流的当前写书任务，
 * 先通过书级 Web Lock 排除其他仍在工作的页签，再接回确实因关页中断的任务。
 */
export const autoResumeInterruptedBookWriters = async () => {
  // 同一本书可能残留旧工作流。只允许最近更新的工作流取得自动恢复资格，
  // 否则旧任务和新任务会分别从不同章节继续写，重复计费并相互覆盖。
  const runs = (await listLocalWorkflowRuns())
    .sort((left, right) => String(right.updateTime || '').localeCompare(String(left.updateTime || '')))
  const claimedBooks = new Set<string>()
  for (const run of runs) {
    const bookKey = String(run.bookId || '').trim()
    if (bookKey && claimedBooks.has(bookKey)) continue
    if (bookKey) claimedBooks.add(bookKey)
    const taskId = Number(run.activeTaskId || run.latestBookTaskId || 0)
    if (!taskId) continue
    let task = await readRepairedLocalTask(taskId)
    if (!shouldAutoResumeBookTask(task)) continue
    try {
      // 兼容旧版本多页签竞态留下的“误取消”：只有这条精确的内部错误允许翻回可恢复态，
      // 作者主动点取消的普通 canceled 永远不会被守护器覆盖。
      if (task?.status === 'canceled' && DUPLICATE_TAB_FALSE_CANCEL.test(String(task.errorMessage || ''))) {
        task = {
          ...task,
          status: 'interrupted',
          interruptedReason: 'app_closed',
          requestedAction: null,
          canPause: false,
          canResume: true,
          canCancel: false,
        }
        await writeLocalWorkflowTask(task)
      }
      await resumeLocalWorkflowTask({ taskId })
    } catch (error) {
      // 某个任务恢复失败不能阻止平台启动；状态仍留在 interrupted，界面可继续恢复。
      console.error(`自动恢复写书任务 ${taskId} 失败:`, error)
    }
  }
}

let supervisorStarted = false
let scanInFlight = false

const refreshWriterWindowTitle = async () => {
  if (typeof document === 'undefined') return
  const runs = await listLocalWorkflowRuns()
  for (const run of runs.sort((left, right) => String(right.updateTime || '').localeCompare(String(left.updateTime || '')))) {
    const taskId = Number(run.activeTaskId || run.latestBookTaskId || 0)
    if (!taskId) continue
    const task = await readRepairedLocalTask(taskId)
    if (!task || task.bizType !== 'book_generate') continue
    const chapter = Number(task.chapterNo || 0)
    const words = Number(task.generatedWords || 0)
    const progress = Number(task.progress || 0)
    document.title = `${run.title || '写作任务'}｜${chapter ? `第${chapter}章` : '准备中'}｜${task.status}｜${words}字｜${progress}% - 易创`
    return
  }
}

const runSupervisorScan = async () => {
  if (scanInFlight) return
  scanInFlight = true
  try {
    await autoResumeInterruptedBookWriters()
    await refreshWriterWindowTitle()
  } finally {
    scanInFlight = false
  }
}

/**
 * 页面存活期间持续守护写书任务；启动、恢复联网、重新回到页面以及定时心跳都会扫描。
 * 真正的单实例仍由写书器的书级 Web Lock 保证，多页签不会重复写同一章。
 */
export const startLocalWorkflowAutoResumeSupervisor = () => {
  if (supervisorStarted || typeof window === 'undefined') return
  supervisorStarted = true
  void runSupervisorScan()
  window.setInterval(() => void runSupervisorScan(), 15_000)
  window.addEventListener('online', () => void runSupervisorScan())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void runSupervisorScan()
  })
}
