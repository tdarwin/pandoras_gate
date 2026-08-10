import type { PandoraApi } from './index'

declare global {
  interface Window {
    pandora: PandoraApi
  }
}

export {}
