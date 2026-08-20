import { describe, it, expect } from 'vitest'
import { SerialQueue } from './queue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('SerialQueue', () => {
  it('runs jobs strictly one at a time, in order', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    const gate = deferred()
    q.push(async () => {
      order.push('a-start')
      await gate.promise
      order.push('a-end')
    })
    q.push(async () => {
      order.push('b')
    })
    await Promise.resolve()
    expect(order).toEqual(['a-start'])
    expect(q.busy).toBe(true)
    gate.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['a-start', 'a-end', 'b'])
    expect(q.busy).toBe(false)
  })

  it('a rejected job does not stall the pump', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    q.push(async () => {
      throw new Error('boom')
    })
    q.push(async () => {
      order.push('after')
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['after'])
  })

  it('skips jobs whose skip() reports true by start time', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    let cancelled = false
    const gate = deferred()
    q.push(async () => {
      await gate.promise
    })
    q.push(
      async () => {
        order.push('cancelled-job-ran')
      },
      () => cancelled
    )
    q.push(async () => {
      order.push('later')
    })
    cancelled = true
    gate.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['later'])
  })

  it('restarts the pump for jobs pushed after it drained', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    q.push(async () => {
      order.push('one')
    })
    await new Promise((r) => setTimeout(r, 0))
    q.push(async () => {
      order.push('two')
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['one', 'two'])
  })
})
