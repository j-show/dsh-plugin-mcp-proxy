/** Linux liveness observations used only while draining an owned background process group. */
import { readdirSync, readFileSync } from 'node:fs'

/** @param group - Owned process-group id. @returns Whether a live member was found, or undefined if unavailable. */
export function linuxProcessGroupHasLiveMembers(group: number): boolean | undefined {
  let entries: string[]
  try { entries = readdirSync('/proc') } catch (_error) { return undefined }
  let matched = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let text: string
    try { text = readFileSync(`/proc/${entry}/stat`, 'utf8') } catch (_error) { continue }
    const end = text.lastIndexOf(')')
    if (end < 0) continue
    const fields = text.slice(end + 2).trim().split(/\s+/)
    if (Number(fields[2]) !== group) continue
    matched = true
    if (!/^[ZXx]$/.test(fields[0] ?? '')) return true
  }
  return matched ? false : undefined
}
