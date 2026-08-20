import fs from 'node:fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { getSecret, setSecret } from '../secrets'
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
  // https only, never http: the access token travels as HTTP Basic auth, so a
  // plain-http remote would send the PAT in cleartext.
  if (/^https:\/\//.test(trimmed)) return trimmed
  throw new Error('Remote must be an https:// URL (or a git@host:repo form, which we convert)')
}

/** Host of an https URL, or null if it isn't parseable as one. */
function remoteHost(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
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
  // Configuring a remote through the UI is the user explicitly authorizing this
  // host to receive the sync token. Bind it so a foreign .git/config (from a
  // novel folder that arrived with its own origin) cannot redirect the PAT
  // elsewhere at push time. Best-effort: without a keychain the token can't be
  // stored either, so there's nothing to protect.
  const host = remoteHost(normalized)
  if (host) {
    try {
      await setSecret('git-sync-host', host)
    } catch {
      // No keychain — token storage will fail the same way; nothing to leak.
    }
  }
  return normalized
}

export async function pushToRemote(dir: string): Promise<string> {
  const url = await getRemoteUrl(dir)
  if (!url) throw new Error('No remote configured for this novel yet')
  const token = await getSecret('git-sync-token')
  if (!token) throw new Error('No access token configured — add one in Preferences → Sync')

  // The token is a single global secret; only send it to the host the user
  // authorized in Preferences → Sync, never to whatever origin this novel's
  // .git/config happens to name.
  const originHost = remoteHost(url)
  if (!originHost) {
    throw new Error(`This novel's remote (${url}) is not a valid https URL; refusing to push.`)
  }
  const authorizedHost = await getSecret('git-sync-host')
  if (authorizedHost && authorizedHost !== originHost) {
    throw new Error(
      `This novel's remote points at ${originHost}, not the host you configured for ` +
        `sync (${authorizedHost}). Re-enter the remote in Preferences → Sync to authorize ` +
        `it before pushing.`
    )
  }
  if (!authorizedHost) {
    // Legacy token stored before host-binding existed: trust the current origin
    // on first push and remember it, so later foreign redirects are refused.
    try {
      await setSecret('git-sync-host', originHost)
    } catch {
      // No keychain — but a token was decrypted above, so this shouldn't happen.
    }
  }

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
