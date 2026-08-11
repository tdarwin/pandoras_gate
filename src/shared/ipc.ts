import { z } from 'zod'
import { NovelStateSchema } from './schemas/project'

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
    .optional(),
  toolCallId: z.string().optional()
})

export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(['local', 'openrouter']),
  contextLength: z.number(),
  capabilities: z.object({ jsonSchema: z.boolean(), toolUse: z.boolean() }),
  pricing: z
    .object({ promptPerMTok: z.number(), completionPerMTok: z.number() })
    .optional()
})

export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('usage'),
    promptTokens: z.number(),
    completionTokens: z.number()
  }),
  z.object({
    type: z.literal('toolCall'),
    id: z.string(),
    name: z.string(),
    arguments: z.string()
  }),
  z.object({ type: z.literal('toolStatus'), text: z.string() }),
  z.object({ type: z.literal('done'), finishReason: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() })
])

/**
 * Typed IPC contract — the single source of truth for every main<->renderer channel.
 *
 * Request/response channels (renderer -> main, via ipcRenderer.invoke) live in
 * `ipcContract`. Fire-and-forget events (main -> renderer, via webContents.send)
 * live in `ipcEvents`. Both sides validate payloads against these schemas.
 */

export const ipcContract = {
  'app:getInfo': {
    request: z.undefined(),
    response: z.object({
      version: z.string(),
      electron: z.string(),
      platform: z.enum(['darwin', 'win32', 'linux'])
    })
  },
  'app:getRecentNovels': {
    request: z.undefined(),
    response: z.object({ dirs: z.array(z.string()) })
  },
  'dialog:chooseDirectory': {
    request: z.object({ title: z.string().optional() }),
    response: z.object({ dir: z.string().nullable() })
  },
  'project:createNovel': {
    request: z.object({
      parentDir: z.string(),
      title: z.string().min(1),
      author: z.string(),
      seriesTitle: z.string().optional()
    }),
    response: NovelStateSchema
  },
  'project:openNovel': {
    request: z.object({ dir: z.string() }),
    response: NovelStateSchema
  },
  'chapter:create': {
    request: z.object({ novelDir: z.string(), title: z.string().min(1) }),
    response: NovelStateSchema
  },
  'chapter:rename': {
    request: z.object({ novelDir: z.string(), file: z.string(), newTitle: z.string().min(1) }),
    response: NovelStateSchema
  },
  'chapter:reorder': {
    request: z.object({ novelDir: z.string(), orderedFiles: z.array(z.string()) }),
    response: NovelStateSchema
  },
  'chapter:read': {
    request: z.object({ novelDir: z.string(), file: z.string() }),
    response: z.object({ content: z.string() })
  },
  'chapter:write': {
    request: z.object({
      novelDir: z.string(),
      file: z.string(),
      content: z.string(),
      /**
       * When true, a history snapshot (git commit) is taken immediately.
       * Plain writes just persist to disk for crash safety — no history entry.
       */
      snapshot: z.boolean().optional()
    }),
    response: z.object({ saved: z.literal(true), snapshotted: z.boolean() })
  },
  'chapter:archive': {
    request: z.object({ novelDir: z.string(), file: z.string() }),
    response: NovelStateSchema
  },
  'chapter:delete': {
    request: z.object({ novelDir: z.string(), file: z.string() }),
    response: NovelStateSchema
  },
  'metadata:list': {
    request: z.object({ novelDir: z.string() }),
    response: z.object({
      characters: z.array(z.object({ file: z.string(), name: z.string() })),
      world: z.array(z.object({ file: z.string(), name: z.string() })),
      summaries: z.array(z.object({ file: z.string(), title: z.string() })),
      outlines: z.array(z.object({ file: z.string(), title: z.string() })),
      hasSynopsis: z.boolean(),
      hasGlossary: z.boolean(),
      hasTimeline: z.boolean()
    })
  },
  'metadata:create': {
    request: z.object({
      novelDir: z.string(),
      kind: z.enum(['character', 'world']),
      name: z.string().min(1)
    }),
    response: z.object({ file: z.string() })
  },
  'metadata:delete': {
    request: z.object({ novelDir: z.string(), file: z.string() }),
    response: z.object({ deleted: z.literal(true) })
  },
  'history:list': {
    request: z.object({ novelDir: z.string(), file: z.string().optional() }),
    response: z.object({
      commits: z.array(z.object({ oid: z.string(), message: z.string(), timestamp: z.number() }))
    })
  },
  'history:diff': {
    request: z.object({ novelDir: z.string(), oid: z.string(), file: z.string() }),
    response: z.object({
      hunks: z.array(
        z.object({
          oldStart: z.number(),
          oldLines: z.number(),
          newStart: z.number(),
          newLines: z.number(),
          lines: z.array(z.string())
        })
      ),
      additions: z.number(),
      deletions: z.number()
    })
  },
  'history:restore': {
    request: z.object({ novelDir: z.string(), oid: z.string(), file: z.string() }),
    response: z.object({ content: z.string() })
  },
  'llm:listModels': {
    request: z.undefined(),
    response: z.object({ models: z.array(ModelInfoSchema) })
  },
  'llm:importGguf': {
    request: z.undefined(),
    response: z.object({
      model: ModelInfoSchema.nullable()
    })
  },
  'llm:removeLocalModel': {
    request: z.object({ path: z.string() }),
    response: z.object({ removed: z.literal(true) })
  },
  'llm:setApiKey': {
    request: z.object({ provider: z.literal('openrouter'), key: z.string().min(1) }),
    response: z.object({ saved: z.literal(true) })
  },
  'llm:hasApiKey': {
    request: z.object({ provider: z.literal('openrouter') }),
    response: z.object({ configured: z.boolean() })
  },
  'llm:warmLoad': {
    request: z.object({ modelId: z.string() }),
    response: z.object({ warming: z.boolean() })
  },
  'llm:novelModel:get': {
    request: z.object({ novelDir: z.string() }),
    response: z.object({ modelId: z.string().nullable() })
  },
  'llm:novelModel:set': {
    request: z.object({ novelDir: z.string(), modelId: z.string() }),
    response: z.object({ saved: z.literal(true) })
  },
  'prefs:get': {
    request: z.undefined(),
    response: z.object({
      autoStoryBible: z.boolean(),
      snapshotOnBlur: z.boolean(),
      snapshotIntervalMinutes: z.number()
    })
  },
  'prefs:set': {
    request: z.object({
      autoStoryBible: z.boolean().optional(),
      snapshotOnBlur: z.boolean().optional(),
      snapshotIntervalMinutes: z
        .union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(20)])
        .optional()
    }),
    response: z.object({
      autoStoryBible: z.boolean(),
      snapshotOnBlur: z.boolean(),
      snapshotIntervalMinutes: z.number()
    })
  },
  'sync:getConfig': {
    request: z.object({ novelDir: z.string() }),
    response: z.object({
      remoteUrl: z.string().nullable(),
      tokenConfigured: z.boolean()
    })
  },
  'sync:setConfig': {
    request: z.object({
      novelDir: z.string(),
      remoteUrl: z.string(),
      token: z.string().optional()
    }),
    response: z.object({ saved: z.literal(true) })
  },
  'sync:push': {
    request: z.object({ novelDir: z.string() }),
    response: z.object({ pushed: z.literal(true), remoteUrl: z.string() })
  },
  'chat:start': {
    request: z.object({
      requestId: z.string(),
      provider: z.enum(['local', 'openrouter']),
      modelId: z.string(),
      messages: z.array(ChatMessageSchema),
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
      /** Novel context enabling agent tools (update_codex, generate_outline). */
      novelDir: z.string().optional(),
      activeFile: z.string().nullable().optional(),
      toolUse: z.boolean().optional(),
      /** Session id for gen_ai.conversation.id across all spans. */
      conversationId: z.string().optional()
    }),
    response: z.object({ started: z.literal(true) })
  },
  'app:openLogs': {
    request: z.undefined(),
    response: z.object({ opened: z.literal(true) })
  },
  'app:rendererError': {
    request: z.object({
      message: z.string(),
      stack: z.string().optional(),
      source: z.string().optional()
    }),
    response: z.object({ logged: z.literal(true) })
  },
  'telemetry:status': {
    request: z.undefined(),
    response: z.object({ enabled: z.boolean() })
  },
  'chat:cancel': {
    request: z.object({ requestId: z.string() }),
    response: z.object({ cancelled: z.boolean() })
  },
  'models:catalog': {
    request: z.undefined(),
    response: z.object({
      hardware: z.object({
        totalMemoryGB: z.number(),
        platform: z.enum(['darwin', 'win32', 'linux']),
        arch: z.string(),
        appleSilicon: z.boolean()
      }),
      entries: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          sizeBytes: z.number(),
          minMemoryGB: z.number(),
          recommendedMemoryGB: z.number(),
          contextLength: z.number(),
          license: z.string(),
          tier: z.enum(['light', 'mid', 'large']),
          tags: z.array(z.string()),
          fit: z.enum(['recommended', 'slow', 'too-large']),
          installedPath: z.string().nullable(),
          downloading: z.boolean(),
          downloadedBytes: z.number()
        })
      )
    })
  },
  'models:download': {
    request: z.object({ modelId: z.string() }),
    response: z.object({ started: z.literal(true) })
  },
  'models:searchHf': {
    request: z.object({ query: z.string().min(1) }),
    response: z.object({
      repos: z.array(
        z.object({
          id: z.string(),
          downloads: z.number(),
          likes: z.number(),
          gated: z.boolean()
        })
      )
    })
  },
  'models:listHfFiles': {
    request: z.object({ repoId: z.string() }),
    response: z.object({
      gated: z.boolean(),
      files: z.array(
        z.object({
          filename: z.string(),
          sizeBytes: z.number(),
          quant: z.string(),
          parts: z.number(),
          fit: z.enum(['recommended', 'slow', 'too-large'])
        })
      )
    })
  },
  'models:downloadHf': {
    request: z.object({
      repoId: z.string(),
      filename: z.string(),
      sizeBytes: z.number()
    }),
    response: z.object({ key: z.string() })
  },
  'models:cancelDownload': {
    request: z.object({ modelId: z.string() }),
    response: z.object({ cancelled: z.boolean() })
  },
  'models:delete': {
    request: z.object({ modelId: z.string() }),
    response: z.object({ deleted: z.literal(true) })
  },
  'chapter:setStatus': {
    request: z.object({
      novelDir: z.string(),
      file: z.string(),
      status: z.enum(['draft', 'ai-draft', 'revised', 'final'])
    }),
    response: NovelStateSchema
  },
  'outlines:generate': {
    request: z.object({
      novelDir: z.string(),
      scope: z.enum(['novel', 'chapter']),
      chapterFile: z.string().optional(),
      guidance: z.string().optional(),
      provider: z.enum(['local', 'openrouter']),
      modelId: z.string()
    }),
    response: z.object({
      status: z.enum(['ran', 'skipped-unchanged', 'no-changes']),
      proposalId: z.string().optional(),
      itemCount: z.number().optional()
    })
  },
  'draft:start': {
    request: z.object({
      requestId: z.string(),
      novelDir: z.string(),
      chapterFile: z.string(),
      provider: z.enum(['local', 'openrouter']),
      modelId: z.string(),
      contextTokens: z.number(),
      instructions: z.string().optional(),
      conversationId: z.string().optional()
    }),
    response: z.object({
      novel: NovelStateSchema,
      content: z.string()
    })
  },
  'draft:finish': {
    request: z.object({ novelDir: z.string(), chapterFile: z.string() }),
    response: z.object({ done: z.literal(true) })
  },
  'proposals:run': {
    request: z.object({
      novelDir: z.string(),
      chapterFile: z.string(),
      provider: z.enum(['local', 'openrouter']),
      modelId: z.string()
    }),
    response: z.object({
      status: z.enum(['ran', 'skipped-unchanged', 'no-changes']),
      proposalId: z.string().optional(),
      itemCount: z.number().optional()
    })
  },
  'proposals:review': {
    request: z.object({ novelDir: z.string() }),
    response: z.object({
      proposals: z.array(
        z.object({
          id: z.string(),
          chapterFile: z.string(),
          chapterTitle: z.string(),
          createdAt: z.number(),
          items: z.array(
            z.object({
              path: z.string(),
              action: z.enum(['create', 'update']),
              newContent: z.string(),
              rationale: z.string(),
              baseHash: z.string(),
              currentContent: z.string(),
              conflict: z.boolean()
            })
          )
        })
      )
    })
  },
  'proposals:resolve': {
    request: z.object({
      novelDir: z.string(),
      proposalId: z.string(),
      path: z.string(),
      resolution: z.enum(['accept', 'reject']),
      editedContent: z.string().optional()
    }),
    response: z.object({ remaining: z.number() })
  },
  'context:assemble': {
    request: z.object({
      novelDir: z.string(),
      activeFile: z.string().nullable(),
      chatHistory: z.array(ChatMessageSchema),
      userMessage: z.string(),
      contextTokens: z.number(),
      reservedOutput: z.number()
    }),
    response: z.object({
      messages: z.array(ChatMessageSchema),
      report: z.object({
        budgetTokens: z.number(),
        usedTokens: z.number(),
        sections: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            status: z.enum(['included', 'degraded', 'dropped']),
            tokens: z.number()
          })
        )
      })
    })
  }
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = z.infer<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.infer<IpcContract[C]['response']>

/** Main -> renderer event channels. */
export const ipcEvents = {
  'chat:event': z.object({
    requestId: z.string(),
    event: StreamEventSchema
  }),
  'model:downloadProgress': z.object({
    modelId: z.string(),
    label: z.string(),
    downloadedBytes: z.number(),
    totalBytes: z.number(),
    done: z.boolean(),
    error: z.string().optional()
  }),
  /** Fired when the agent (or a pipeline run) created new proposals. */
  'proposals:changed': z.object({}),
  /** Manifest changed outside the renderer (e.g. agent created a chapter). */
  'novel:updated': NovelStateSchema,
  /** The agent asked for an AI draft; renderer starts it when chat is idle. */
  'draft:requested': z.object({
    chapterFile: z.string(),
    instructions: z.string()
  })
} as const satisfies Record<string, z.ZodType>

export type IpcEventChannel = keyof typeof ipcEvents
export type IpcEventPayload<C extends IpcEventChannel> = z.infer<(typeof ipcEvents)[C]>

/**
 * Errors crossing the IPC boundary are serialized to this shape so the renderer
 * can render them without depending on Error internals surviving structured clone.
 */
export interface IpcError {
  code: string
  message: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }
