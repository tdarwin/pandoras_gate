import { describe, it, expect } from 'vitest'
import { runDeferredJobs, type DeferredRun } from './chat'

describe('runDeferredJobs', () => {
  it('runs jobs in order, reports statuses, and finishes with combined results', async () => {
    const events: [string, unknown][] = []
    const jobs: DeferredRun[] = [
      {
        label: 'Updating the Codex…',
        run: async (onStatus) => {
          onStatus('Asking the model…')
          return '3 suggestions'
        }
      },
      { label: 'Generating an outline…', run: async () => 'Outline ready for review' }
    ]
    await runDeferredJobs(jobs, (channel, payload) => events.push([channel, payload]))

    expect(events.map(([c]) => c)).toEqual([
      'pipeline:status',
      'pipeline:status',
      'pipeline:status',
      'pipeline:run',
      'proposals:changed'
    ])
    expect(events.at(-2)![1]).toEqual({
      phase: 'finished',
      label: 'Updating the Codex…',
      result: '3 suggestions; Outline ready for review'
    })
  })

  it('a failing job reports its error and does not stop later jobs', async () => {
    const events: [string, unknown][] = []
    const jobs: DeferredRun[] = [
      {
        label: 'Revising the chapter…',
        run: async () => {
          throw new Error('model returned an empty revision')
        }
      },
      { label: 'Updating the Codex…', run: async () => '1 suggestion' }
    ]
    await runDeferredJobs(jobs, (channel, payload) => events.push([channel, payload]))
    const finished = events.find(([c, p]) => c === 'pipeline:run' && (p as { phase: string }).phase === 'finished')!
    expect(finished[1]).toMatchObject({
      error: 'model returned an empty revision',
      result: '1 suggestion'
    })
  })
})
