/** jsdom lacks layout; ProseMirror probes these during selection updates. */
export function polyfillEditorDom(): void {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({})
  } as DOMRect
  Range.prototype.getBoundingClientRect = () => rect
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator]
    }) as unknown as DOMRectList
  if (!HTMLElement.prototype.getClientRects) {
    HTMLElement.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator]
      }) as unknown as DOMRectList
  }
}
