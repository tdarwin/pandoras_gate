// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { baseExtensions } from './extensions'
import { markdownToDoc } from './markdown'
import { sameBlockShape, splitChainAtStructural } from './blockShape'

const schema = getSchema(baseExtensions())
const shape = (a: string, b: string): boolean =>
  sameBlockShape(markdownToDoc(schema, a), markdownToDoc(schema, b))

describe('sameBlockShape', () => {
  it('ignores the words and the marks inside a block', () => {
    expect(shape('A quiet night.\n', 'A loud night.\n')).toBe(true)
    expect(shape('Plain.\n', '**Bold** and *italic*.\n')).toBe(true)
    expect(shape('One.\n\nTwo.\n', 'One edited.\n\nTwo edited.\n')).toBe(true)
    expect(shape('> Quoted.\n', '> Quoted differently.\n')).toBe(true)
    expect(shape('- A\n- B\n', '- A edited\n- B edited\n')).toBe(true)
  })

  it('catches every way a proposal can change the shape', () => {
    // Wraps and unwraps: N blocks become one, or one becomes N.
    expect(shape('Hello.\n', '> Hello.\n')).toBe(false)
    expect(shape('One.\n\nTwo.\n', '- One.\n- Two.\n')).toBe(false)
    expect(shape('> Quoted.\n', 'Quoted.\n')).toBe(false)
    // A block added or removed shifts everything after it.
    expect(shape('First.\n\nThird.\n', 'First.\n\nSecond.\n\nThird.\n')).toBe(false)
    expect(shape('First.\n\nSecond.\n\nThird.\n', 'First.\n\nThird.\n')).toBe(false)
    // Different kind of block, same words.
    expect(shape('A heading.\n', '# A heading.\n')).toBe(false)
    expect(shape('- A\n- B\n', '1. A\n2. B\n')).toBe(false)
    // Attributes are part of the shape: a styled block's tint or alignment.
    expect(shape('::: {align=center}\nLine.\n:::\n', '::: {align=left}\nLine.\n:::\n')).toBe(false)
    // And so is the shape INSIDE a container.
    expect(shape('> One.\n>\n> Two.\n', '> One.\n')).toBe(false)
  })
})

describe('splitChainAtStructural', () => {
  const link = (id: string, content: string): { proposalId: string; content: string } => ({
    proposalId: id,
    content
  })

  it('keeps a chain that only rewords', () => {
    const chain = [link('p1', 'A one.\n\nB.\n'), link('p2', 'A one.\n\nB two.\n')]
    const split = splitChainAtStructural(schema, 'A.\n\nB.\n', chain)
    expect(split.inline).toHaveLength(2)
    expect(split.structural).toHaveLength(0)
  })

  it('stops at the first structural link and takes the rest with it', () => {
    // Later links were folded on top of it, so their content assumes it.
    const chain = [
      link('p1', 'A one.\n\nB.\n'),
      link('p2', 'A one.\n\n> B.\n'),
      link('p3', 'A one.\n\n> B two.\n')
    ]
    const split = splitChainAtStructural(schema, 'A.\n\nB.\n', chain)
    expect(split.inline.map((l) => l.proposalId)).toEqual(['p1'])
    expect(split.structural.map((l) => l.proposalId)).toEqual(['p2', 'p3'])
  })

  it('sets the whole chain aside when the first link restructures', () => {
    const split = splitChainAtStructural(schema, 'A.\n', [link('p1', '> A.\n')])
    expect(split.inline).toHaveLength(0)
    expect(split.structural).toHaveLength(1)
  })
})
