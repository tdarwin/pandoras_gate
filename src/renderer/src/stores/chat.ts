import { create } from 'zustand'
import type { ChatMessage, ModelInfo } from '@shared/llm/types'
import { onIpcEvent } from '../lib/events'
import { useProjectStore, onNovelChange } from './project'
import { usePrefsStore, type ModelRole } from './prefs'

export interface ContextReport {
  budgetTokens: number
  usedTokens: number
  windowTokens: number
  /** 'lean' = retrieval-first (codex fetched via tools); 'full' = upfront. */
  mode: 'lean' | 'full'
  sections: {
    id: string
    label: string
    status: 'included' | 'degraded' | 'dropped'
    tokens: number
  }[]
}

/** Transcript entry: real chat message, or a UI-only tool-activity chip. */
export type ChatEntry = ChatMessage & { uiKind?: 'tool' }

interface ChatStore {
  models: ModelInfo[]
  selectedModelId: string | null
  apiKeyConfigured: boolean
  /** Session id shared by all telemetry spans of this conversation. */
  conversationId: string
  messages: ChatEntry[]
  streaming: boolean
  requestId: string | null
  usage: { promptTokens: number; completionTokens: number } | null
  report: ContextReport | null
  /** "Updating the Codex…" while the agent runs a tool. */
  toolStatus: string | null
  error: string | null

  init: () => void
  loadModels: () => Promise<void>
  /** Restores the model last used with this novel and warms it up. */
  loadForNovel: (novelDir: string) => Promise<void>
  saveApiKey: (key: string) => Promise<boolean>
  selectModel: (id: string) => void
  /**
   * The model to use for an AI task role: the assigned model from
   * Preferences when it's installed/available, else the chat model.
   */
  modelForRole: (role: ModelRole) => ModelInfo | undefined
  importLocalModel: () => Promise<void>
  send: (text: string) => Promise<void>
  cancel: () => Promise<void>
  clear: () => void
}

/** Preload a local model into the inference worker so first chat is instant. */
function warmIfLocal(models: ModelInfo[], modelId: string | null): void {
  const model = models.find((m) => m.id === modelId)
  if (model?.provider === 'local') {
    void window.pandora.invoke('llm:warmLoad', { modelId: model.id })
  }
}

let initialized = false

export const useChatStore = create<ChatStore>((set, get) => ({
  models: [],
  selectedModelId: null,
  apiKeyConfigured: false,
  conversationId: crypto.randomUUID(),
  messages: [],
  streaming: false,
  requestId: null,
  usage: null,
  report: null,
  toolStatus: null,
  error: null,

  init: () => {
    if (initialized) return
    initialized = true
    // A conversation belongs to the novel it was about. Workspace stays
    // mounted across File → Open Recent, so without this, novel A's transcript
    // gets sent as chat history for novel B.
    onNovelChange(() => useChatStore.getState().clear())

    // Story context is budgeted from this cached model list, so the window has
    // to be corrected here as soon as the worker sizes it — otherwise the first
    // session with a model plans against the import-time estimate, which on a
    // tight machine means targeting more tokens than were actually allocated.
    onIpcEvent('model:contextResolved', ({ modelId, contextLength }) => {
      set((s) => ({
        models: s.models.map((m) => (m.id === modelId ? { ...m, contextLength } : m))
      }))
    })

    onIpcEvent('chat:event', ({ requestId, event }) => {
      if (requestId !== get().requestId) return
      switch (event.type) {
        case 'delta': {
          set((s) => {
            const messages = [...s.messages]
            const last = messages[messages.length - 1]
            if (last?.role === 'assistant') {
              messages[messages.length - 1] = {
                role: 'assistant',
                content: last.content + event.text
              }
            }
            // Clear the live indicator only when one is showing.
            return s.toolStatus !== null ? { messages, toolStatus: null } : { messages }
          })
          break
        }
        case 'toolStatus':
          // Live indicator now + a permanent chip in the transcript, placed
          // before the assistant bubble currently being streamed.
          set((s) => {
            const messages = [...s.messages]
            const last = messages[messages.length - 1]
            const chip: ChatEntry = { role: 'assistant', content: event.text, uiKind: 'tool' }
            if (last?.role === 'assistant' && !last.uiKind) {
              messages.splice(messages.length - 1, 0, chip)
            } else {
              messages.push(chip)
            }
            return { messages, toolStatus: event.text }
          })
          break
        case 'status':
          // Transient progress (e.g. queued behind another generation) —
          // live indicator only, no transcript chip.
          set({ toolStatus: event.text })
          break
        case 'usage':
          set({ usage: { promptTokens: event.promptTokens, completionTokens: event.completionTokens } })
          break
        case 'done':
          set({ streaming: false, requestId: null, toolStatus: null })
          break
        case 'error':
          set((s) => {
            // Drop an empty assistant bubble on failure.
            const messages = [...s.messages]
            if (messages[messages.length - 1]?.role === 'assistant' && !messages[messages.length - 1]!.content) {
              messages.pop()
            }
            return {
              messages,
              streaming: false,
              requestId: null,
              toolStatus: null,
              error: event.message
            }
          })
          break
      }
    })
    void window.pandora
      .invoke('llm:hasApiKey', { provider: 'openrouter' })
      .then((r) => {
        if (r.ok) set({ apiKeyConfigured: r.data.configured })
        void get().loadModels()
      })
  },

  loadModels: async () => {
    const result = await window.pandora.invoke('llm:listModels', undefined)
    if (result.ok) {
      set({ models: result.data.models })
      const { selectedModelId } = get()
      if (!selectedModelId) {
        // Sensible defaults: a local model first, then a strong remote one.
        const preferred =
          result.data.models.find((m) => m.provider === 'local') ??
          result.data.models.find((m) => m.id === 'anthropic/claude-sonnet-4.5') ??
          result.data.models.find((m) => m.id.startsWith('anthropic/')) ??
          result.data.models[0]
        if (preferred) set({ selectedModelId: preferred.id })
      }
    }
  },

  loadForNovel: async (novelDir: string) => {
    get().init()
    await get().loadModels()
    const persisted = await window.pandora.invoke('llm:novelModel:get', { novelDir })
    if (persisted.ok && persisted.data.modelId) {
      const { models } = get()
      if (models.some((m) => m.id === persisted.data.modelId)) {
        set({ selectedModelId: persisted.data.modelId })
      }
    }
    warmIfLocal(get().models, get().selectedModelId)
  },

  saveApiKey: async (key: string) => {
    const result = await window.pandora.invoke('llm:setApiKey', { provider: 'openrouter', key })
    if (result.ok) {
      set({ apiKeyConfigured: true, error: null })
      await get().loadModels()
      return true
    }
    set({ error: result.error.message })
    return false
  },

  selectModel: (id) => {
    set({ selectedModelId: id })
    const novel = useProjectStore.getState().novel
    if (novel) {
      void window.pandora.invoke('llm:novelModel:set', { novelDir: novel.dir, modelId: id })
    }
    warmIfLocal(get().models, id)
  },

  modelForRole: (role) => {
    const { models, selectedModelId } = get()
    const assigned = usePrefsStore.getState().modelRoles[role]
    return (
      (assigned ? models.find((m) => m.id === assigned) : undefined) ??
      models.find((m) => m.id === selectedModelId)
    )
  },

  importLocalModel: async () => {
    const result = await window.pandora.invoke('llm:importGguf', undefined)
    if (result.ok && result.data.model) {
      await get().loadModels()
      set({ selectedModelId: result.data.model.id })
    } else if (!result.ok) {
      set({ error: result.error.message })
    }
  },

  send: async (text: string) => {
    const { selectedModelId, streaming, messages, models } = get()
    if (streaming || !selectedModelId || !text.trim()) return

    const project = useProjectStore.getState()
    const novel = project.novel
    if (!novel) return

    // Make sure the chapter on disk matches the editor before assembly.
    await project.saveActiveChapter()

    const model = models.find((m) => m.id === selectedModelId)
    const contextTokens = model?.contextLength ?? 8192
    const toolUse = model?.capabilities.toolUse ?? false
    // Reply room scales with the window (a quarter, capped at 4k) and is
    // passed to the provider as a real output cap, not just a reservation.
    const reservedOutput = Math.min(4096, Math.max(1024, Math.floor(contextTokens / 4)))
    const userMessage = text.trim()

    const assembled = await window.pandora.invoke('context:assemble', {
      novelDir: novel.dir,
      activeFile: project.activeFile,
      // Tool-activity chips are UI-only — never part of the model's history.
      chatHistory: messages.filter((m) => !m.uiKind).map(({ uiKind: _uiKind, ...m }) => m),
      userMessage,
      contextTokens,
      reservedOutput,
      toolUse
    })
    if (!assembled.ok) {
      set({ error: assembled.error.message })
      return
    }

    const requestId = crypto.randomUUID()
    set({
      messages: [...messages, { role: 'user', content: userMessage }, { role: 'assistant', content: '' }],
      streaming: true,
      requestId,
      usage: null,
      report: assembled.data.report,
      error: null
    })

    const result = await window.pandora.invoke('chat:start', {
      requestId,
      provider: model?.provider ?? 'openrouter',
      modelId: selectedModelId,
      messages: assembled.data.messages,
      maxTokens: reservedOutput,
      cachePrefixChars: assembled.data.cachePrefixChars,
      // Enables agent tools (update_codex, generate_outline) in main.
      novelDir: novel.dir,
      activeFile: project.activeFile,
      toolUse,
      conversationId: get().conversationId
    })
    if (!result.ok) {
      set((s) => {
        const msgs = [...s.messages]
        if (msgs[msgs.length - 1]?.role === 'assistant' && !msgs[msgs.length - 1]!.content) msgs.pop()
        return { messages: msgs, streaming: false, requestId: null, error: result.error.message }
      })
    }
  },

  cancel: async () => {
    const { requestId } = get()
    if (!requestId) return
    await window.pandora.invoke('chat:cancel', { requestId })
    set({ streaming: false, requestId: null })
  },

  // Clearing the thread starts a new conversation (and a new telemetry session).
  clear: () =>
    set({
      messages: [],
      usage: null,
      report: null,
      error: null,
      conversationId: crypto.randomUUID()
    })
}))
