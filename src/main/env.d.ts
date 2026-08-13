/**
 * electron-vite's `?asset` suffix copies a file into the main bundle's output
 * directory and resolves the import to its absolute path at runtime.
 */
declare module '*?asset' {
  const path: string
  export default path
}
