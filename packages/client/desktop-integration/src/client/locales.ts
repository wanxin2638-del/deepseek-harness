/** `desktop-integration` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'desktop-integration'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'completed.title': '任务完成',
  'completed.body': '会话「{title}」已完成',
  'failure.title': '任务失败',
  'failure.body': '会话「{title}」失败：{message}',
  'job.completed.title': '后台任务完成',
  'job.completed.body': '「{label}」（会话「{title}」）已完成',
  'job.failed.title': '后台任务失败',
  'job.failed.body': '「{label}」（会话「{title}」）已失败',
  'job.killed.title': '后台任务已取消',
  'job.killed.body': '「{label}」（会话「{title}」）已取消',
} as const

/** Key domain of the `desktop-integration` namespace (zh is the source of truth). */
export type DesktopIntegrationKey = keyof typeof zh

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<DesktopIntegrationKey, string> = {
  'completed.title': 'Task completed',
  'completed.body': 'Session "{title}" completed',
  'failure.title': 'Task failed',
  'failure.body': 'Session "{title}" failed: {message}',
  'job.completed.title': 'Background job completed',
  'job.completed.body': '"{label}" (in "{title}") completed',
  'job.failed.title': 'Background job failed',
  'job.failed.body': '"{label}" (in "{title}") failed',
  'job.killed.title': 'Background job cancelled',
  'job.killed.body': '"{label}" (in "{title}") was cancelled',
}
