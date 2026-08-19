import { useProjectStore } from '../stores/project'
import { useDraftStore } from '../stores/draft'

/**
 * Novel-level navigation shared by the menu and the sidebar. A running draft
 * belongs to THIS novel's chapter — stop it (partial prose is saved and
 * committed) before the novel goes away, then flush the editor buffer.
 */

async function stopDraftIfRunning(): Promise<void> {
  const draft = useDraftStore.getState()
  if (draft.drafting) await draft.stop()
}

export async function closeNovelSafely(): Promise<void> {
  await stopDraftIfRunning()
  await useProjectStore.getState().closeNovel()
}

/** Everything that must settle before another novel can be opened. */
export async function prepareToLeaveNovel(): Promise<void> {
  await stopDraftIfRunning()
  await useProjectStore.getState().snapshotActiveChapter()
}
