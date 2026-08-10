import fs from 'node:fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { getSecret } from '../secrets'
import { flushAutocommit, commitAll } from './service'

/**
 * Optional remote sync. isomorphic-git speaks HTTPS (not SSH), so remotes are
 * https URLs with an access token (e.g. a GitHub fine-grained PAT) stored via
 * safeStorage. SSH-style URLs users paste are normalized to HTTPS.
 */

/** "git@github.com:user/repo.git" -> "https://github.com/user/repo.git" */
export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim()
  const sshMatch = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(trimmed)
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}.git`
  if (/^https?:\/\//.test(trimmed)) return trimmed
  throw new Error('Remote must be an https:// URL (or a git@host:repo form, which we convert)')
}

export async function getRemoteUrl(dir: string): Promise<string | null> {
  try {
    const remotes = await git.listRemotes({ fs, dir })
    return remotes.find((r) => r.remote === 'origin')?.url ?? null
  } catch {
    return null
  }
}

export async function setRemoteUrl(dir: string, url: string): Promise<string> {
  const normalized = normalizeRemoteUrl(url)
  try {
    await git.deleteRemote({ fs, dir, remote: 'origin' })
  } catch {
    // No existing remote — fine.
  }
  await git.addRemote({ fs, dir, remote: 'origin', url: normalized })
  return normalized
}

export async function pushToRemote(dir: string): Promise<string> {
  const url = await getRemoteUrl(dir)
  if (!url) throw new Error('No remote configured for this novel yet')
  const token = await getSecret('git-sync-token')
  if (!token) throw new Error('No access token configured — add one in Preferences → Sync')

  // Snapshot anything pending so the push carries the latest work.
  await flushAutocommit(dir)
  await commitAll(dir, 'sync: snapshot before push')

  try {
    const result = await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: 'main',
      onAuth: () => ({ username: 'x-access-token', password: token })
    })
    if (result.ok !== true) throw new Error('Push was rejected by the remote')
    return url
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/401|403|auth/i.test(message)) {
      throw new Error(
        'The remote rejected the access token. Check that it has write access to this repository.'
      )
    }
    if (/not a simple fast-forward|fetch first|rejected/i.test(message)) {
      throw new Error(
        'The remote has commits this machine does not. Pulling remote changes is not supported yet — push from one machine, or reconcile manually.'
      )
    }
    throw new Error(`Push failed: ${message}`)
  }
}
