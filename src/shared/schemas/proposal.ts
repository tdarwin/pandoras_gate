import { z } from 'zod'

/**
 * What the model must return from a metadata run: complete new file contents
 * (full-document rewrite — reliable across small local models, and the app
 * computes diffs itself). No deletes: removing docs is a human-only action.
 */
export const ModelProposalOutput = z.object({
  proposals: z.array(
    z.object({
      path: z.string(),
      action: z.enum(['create', 'update']),
      newContent: z.string(),
      rationale: z.string()
    })
  )
})
export type ModelProposalOutput = z.infer<typeof ModelProposalOutput>

/** JSON schema handed to providers for constrained generation. */
export const PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          action: { type: 'string', enum: ['create', 'update'] },
          newContent: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['path', 'action', 'newContent', 'rationale'],
        additionalProperties: false
      }
    }
  },
  required: ['proposals'],
  additionalProperties: false
}

/** A proposal item as stored in .pandora/proposals/ awaiting review. */
export const PendingProposalItem = z.object({
  path: z.string(),
  action: z.enum(['create', 'update']),
  newContent: z.string(),
  rationale: z.string(),
  /** sha256 of the doc content the proposal was generated against ('' for create). */
  baseHash: z.string()
})
export type PendingProposalItem = z.infer<typeof PendingProposalItem>

export const PendingProposal = z.object({
  id: z.string(),
  chapterFile: z.string(),
  chapterTitle: z.string(),
  createdAt: z.number(),
  items: z.array(PendingProposalItem)
})
export type PendingProposal = z.infer<typeof PendingProposal>
