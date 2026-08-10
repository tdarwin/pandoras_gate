/** "The Iron Gate!" -> "the-iron-gate" */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    // strip combining diacritics left over from NFKD decomposition
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled'
}

/** Zero-padded chapter file prefix: 3 -> "003". */
export function chapterPrefix(n: number): string {
  return String(n).padStart(3, '0')
}
