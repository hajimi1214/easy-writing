import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { ElLoading } from 'element-plus'
// 组件与样式由 unplugin 按需注入；这三类是脚本里程序化调用的，样式手动带上
import 'element-plus/es/components/message/style/index'
import 'element-plus/es/components/message-box/style/index'
import 'element-plus/es/components/loading/style/index'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '@/styles/common.scss'
import '@/styles/ink.scss'
import InkLoading from '@/directives/inkLoading'



import App from './App.vue'
import router from './router'
import { useThemeStore } from '@/stores/theme'
import { initLocalPrompts } from '@/storage/local-prompts'
import { startLocalWorkflowAutoResumeSupervisor } from '@/utils/local-workflow-auto-resume'

// 当前《墨痕长生》的一次性重置与重生成：按作者确认，永久删除旧正文和正文历史，
// 保留书籍设定、分卷、章纲与细纲；随后从第 1 章按新的硬质检规则自动生成。
void (async () => {
  if (!import.meta.env.DEV) return
  // 只允许本次显式打开的启动窗口执行；普通旧页签收到 HMR 时不得抢任务。
  if (new URLSearchParams(window.location.search).get('autostart') !== 'mohen-v15') return
  const migrationKey = 'ew-mohen-regenerate-v15'
  const statusKey = 'ew-mohen-regenerate-v15-status'
  const executeMigration = async () => {
  if (localStorage.getItem(migrationKey) === 'done') return
  localStorage.setItem(statusKey, 'booting')
  await new Promise(resolve => setTimeout(resolve, 1500))
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ew-local-workflow', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const values = await new Promise<unknown[]>((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly')
    const request = tx.objectStore('kv').getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
  db.close()
  const records = values.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  const runRecord = records
    .filter(item => item.currentStep && item.title === '墨痕长生')
    .sort((a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || '')))[0]
  if (!runRecord) {
    localStorage.setItem(statusKey, 'failed-run-not-found')
    return
  }

  const {
    readLocalWorkflowRun,
    writeLocalWorkflowRun,
  } = await import('@/storage/local-workflow')
  let run = await readLocalWorkflowRun(Number(runRecord.id || 0))
  if (!run?.bookId) {
    localStorage.setItem(statusKey, 'failed-book-not-found')
    return
  }

  if (localStorage.getItem(migrationKey) !== 'reset') {
    const taskId = Number(run.activeTaskId || run.latestBookTaskId || 0)
    if (taskId) {
      const { cancelLocalWorkflowTask } = await import('@/utils/local-workflow-control')
      await cancelLocalWorkflowTask({ taskId }).catch(() => undefined)
    }

    const [{ getWritingStorage }, { getLocalLibraryStorage }] = await Promise.all([
      import('@/storage'),
      import('@/storage/local-library'),
    ])
    const library = getLocalLibraryStorage()
    const bookId = String(run.bookId)
    const tree = await library.getLocalBookTree(bookId)
    await getWritingStorage().purgeBookDrafts(bookId)
    for (const chapter of tree.flatMap(volume => volume.children)) {
      const planMeta = { ...(chapter.planMeta || {}) }
      delete planMeta.workflowLedger
      delete planMeta.qualityFix
      await library.updateLocalChapter({
        id: chapter.id,
        wordCount: 0,
        workflowStatus: 'incomplete',
        planMeta,
      })
      await library.updateLocalChapterContentMeta({
        bookId,
        chapterId: chapter.id,
        title: chapter.title,
        wordCount: 0,
      })
    }
    localStorage.setItem(migrationKey, 'reset')
  }

  // 旧页签可能还卡在一次长模型调用里。先等它看到 cancel 并释放书级锁，
  // 否则新任务会因 ifAvailable 拿不到锁而被当成重复任务取消。
  if (navigator.locks) {
    const writerLock = `easy-writing:book-writer:book:${String(run.bookId)}`
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const snapshot = await navigator.locks.query()
      const occupied = (snapshot.held || []).some(lock => lock.name === writerLock)
      if (!occupied) break
      localStorage.setItem(statusKey, `waiting-old-writer-${attempt + 1}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  run = await readLocalWorkflowRun(Number(runRecord.id || 0))
  if (!run) return
  run.activeTaskId = null
  run.config = {
    ...(run.config || {}),
    chapterTargetWords: 3000,
    selfCheckMode: 'fix',
    autoFix: true,
  }
  await writeLocalWorkflowRun(run)

  const { generateLocalWorkflowBook } = await import('@/utils/local-workflow-control')
  const result = await generateLocalWorkflowBook({ runId: Number(run.id) })
  localStorage.setItem(migrationKey, 'done')
  const task = 'conflict' in result.data ? result.data.activeTask : result.data
  localStorage.setItem(statusKey, `task-${task.id}-${task.status}-${task.finishedChapters ?? 0}-${task.totalChapters ?? 0}`)
  document.title = `墨痕长生重生成|task:${task.status}|done:${task.finishedChapters ?? 0}/${task.totalChapters ?? '-'}|id:${task.id}`

  }

  if (navigator.locks) {
    await navigator.locks.request('easy-writing:mohen-regenerate-v15', { ifAvailable: true }, async lock => {
      if (lock) await executeMigration()
    })
  } else {
    await executeMigration()
  }
})().catch(error => {
  localStorage.setItem('ew-mohen-regenerate-v15-status', `failed-${String(error).slice(0, 120)}`)
  document.title = `墨痕长生重生成失败|${String(error).slice(0, 100)}`
})

// 清掉旧 SaaS 版本残留的账号持久化，防止陈旧登录态误触云端分支
localStorage.removeItem('ew-user')

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
app.use(router)

app.use(InkLoading)
// element-plus 组件由 unplugin 按需注入（vite.config 的 Components/AutoImport），
// 全量注册已拆除；v-loading 指令按需登记，中文语言包在 App.vue 的 el-config-provider
app.use(ElLoading)

// 初始化主题系统
const themeStore = useThemeStore()
themeStore.initTheme()

// 提示词库先于挂载装载：AI 组装器同步读取，必须在任何界面可交互前就绪
void initLocalPrompts().finally(() => {
  app.mount('#app')
  // 写书引擎运行在页面中。关页或刷新后，重新打开平台会从已保存断点自动接回，
  // 无需作者再次点“继续生成”；书级 Web Lock 会阻止多页签重复启动。
  startLocalWorkflowAutoResumeSupervisor()
})
