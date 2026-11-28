import { createElement as h, useEffect, useMemo, useState } from 'react'
import { useTurnFacts } from './btw.js'
import { FolderMenu, folderName } from './folder-menu.js'
import { t } from './i18n.js'

export function recentComputerFiles(turns, limit = 20) {
  if (limit <= 0) return []
  const seen = new Set()
  const recent = []
  for (const turn of [...(turns?.values() ?? [])].reverse()) {
    const data = turn.data.get('deliverables')
    for (const entry of [...(data?.produced ?? []), ...(data?.presented ?? [])].sort((a, b) => b.seq - a.seq)) {
      const { path } = entry
      if (typeof path !== 'string' || path === '' || seen.has(path)) continue
      seen.add(path)
      recent.push(path)
      if (recent.length >= limit) return recent
    }
  }
  return recent
}

export function computerFileAddress(sessionId, path) {
  const encode = segment => encodeURIComponent(segment).replace(/%3A/gu, ':')
  const name = path.replace(/\\/gu, '/').replace(/^(\.\/)+/u, '').split('/').map(encode).join('/')
  return `dsh-resource://file/session/${encode(sessionId)}/${name}`
}

export async function checkComputerFiles(paths, stat, signal) {
  return Promise.all(paths.map(async path => {
    try {
      await stat(path, signal)
      return { path, available: true }
    } catch (error) {
      return error.code === 'workspace-file/not-found' ? null : { path, available: false }
    }
  }))
}

export function ComputerFiles({ sessionId, workDir, group, actions, run, onPickFolder }) {
  const { turns } = useTurnFacts(sessionId, actions)
  const paths = useMemo(() => recentComputerFiles(turns), [turns])
  const [checked, setChecked] = useState(null)
  const canOpen = actions.canOpenComputerFile?.()
  useEffect(() => {
    if (!canOpen || !sessionId || !paths.length) return undefined
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
    void checkComputerFiles(paths, (path, request) => actions.statComputerFile(sessionId, path, request), signal)
      .then(files => { if (!controller.signal.aborted) setChecked({ paths, files: files.filter(Boolean) }) })
    return () => controller.abort()
  }, [actions, canOpen, paths, sessionId])
  const files = canOpen && checked?.paths === paths ? checked.files : paths.map(path => ({ path }))
  return h('div', { className: 'bt-computer' },
    h('section', { className: 'bt-computer-location' },
      h('div', { className: 'bt-section-title' }, t('Working folder')),
      h(FolderMenu, { value: workDir, group, actions, run, wide: true, onPick: onPickFolder }),
      actions.canOpenFiles?.() ? h('div', { className: 'bt-computer-actions' },
        h('button', { type: 'button', className: 'bt-browser-retry', onClick: actions.openFiles }, t('Open workspace files'))) : null),
    h('section', { className: 'bt-computer-location' },
      h('div', { className: 'bt-section-title' }, t('Recent files')),
      files.length ? h('ul', { className: 'bt-computer-files' }, files.map(({ path, available }) => {
        const name = folderName(path)
        return h('li', { key: path, title: path }, available
          ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => actions.openComputerFile(sessionId, path) }, name)
          : h('span', null, name), h('span', { className: 'bt-muted' }, path))
      }))
        : h('p', { className: 'bt-muted' }, t('No recent files.'))))
}
