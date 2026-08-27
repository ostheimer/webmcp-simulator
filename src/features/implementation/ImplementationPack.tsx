import { useMemo, useState } from 'react'
import { heatFlowCapabilities, heatFlowAnalysis } from '../../demo/heatflow/data'
import {
  accessPathLabels,
  defaultImplementationCapabilityIds,
  generateImplementationPack,
  type AccessPath,
} from './generateImplementationPack'

const accessOptions: Array<{ id: AccessPath; icon: string; description: string }> = [
  { id: 'no-access', icon: '◎', description: 'Start by identifying platform, ownership, and authorized access.' },
  { id: 'cms', icon: '▦', description: 'Create a platform-aware plugin, module, or vendor handoff.' },
  { id: 'agency', icon: '↗', description: 'Prepare a precise brief for the team that maintains the site.' },
  { id: 'repository', icon: '⌘', description: 'Ask Codex to inspect and update the actual codebase.' },
]

export function ImplementationPack() {
  const [accessPath, setAccessPath] = useState<AccessPath>('no-access')
  const [platform, setPlatform] = useState('I do not know yet')
  const [selectedIds, setSelectedIds] = useState(() => defaultImplementationCapabilityIds(heatFlowCapabilities))
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const selectedCapabilities = useMemo(
    () => heatFlowCapabilities.filter((capability) => selectedIds.includes(capability.id)),
    [selectedIds],
  )
  const pack = useMemo(
    () => generateImplementationPack({
      websiteUrl: heatFlowAnalysis.url,
      accessPath,
      platform,
      capabilities: selectedCapabilities,
    }),
    [accessPath, platform, selectedCapabilities],
  )

  function toggleCapability(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
  }

  async function copyPack() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(pack)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 2200)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = pack
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      textarea.remove()
      setCopyState(copied ? 'copied' : 'failed')
      if (copied) window.setTimeout(() => setCopyState('idle'), 2200)
    }
  }

  function downloadPack() {
    const url = URL.createObjectURL(new Blob([pack], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'WEBMCP_IMPLEMENTATION.md'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="implementation-view">
      <div className="report-intro">
        <p className="workspace-kicker">FROM SIMULATION TO IMPLEMENTATION</p>
        <h2>Your WebMCP Implementation Pack.</h2>
        <p>Choose what you can access. The pack adapts its next steps without pretending Codex can modify a website it cannot reach.</p>
      </div>

      <div className="implementation-grid">
        <div className="implementation-config">
          <section className="config-section">
            <div className="config-heading"><span>1</span><div><h3>How is the website maintained?</h3><p>No repository is the default — and that is okay.</p></div></div>
            <div className="access-grid">
              {accessOptions.map((option) => (
                <button className={accessPath === option.id ? 'selected' : ''} type="button" key={option.id} aria-pressed={accessPath === option.id} onClick={() => setAccessPath(option.id)}>
                  <span className="access-icon" aria-hidden="true">{option.icon}</span>
                  <strong>{accessPathLabels[option.id]}</strong>
                  <small>{option.description}</small>
                  <i aria-hidden="true">{accessPath === option.id ? '✓' : ''}</i>
                </button>
              ))}
            </div>
            {accessPath === 'cms' && (
              <label className="platform-field">Platform or CMS
                <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
                  <option>I do not know yet</option><option>WordPress</option><option>Shopify</option><option>Webflow</option><option>Wix</option><option>Squarespace</option><option>Other</option>
                </select>
              </label>
            )}
          </section>

          <section className="config-section">
            <div className="config-heading"><span>2</span><div><h3>Select proposed capabilities</h3><p>Include only tools that match the intended user journey.</p></div></div>
            <div className="capability-checklist">
              {heatFlowCapabilities.map((capability) => (
                <label key={capability.id}>
                  <input type="checkbox" checked={selectedIds.includes(capability.id)} onChange={() => toggleCapability(capability.id)} />
                  <span className="custom-check" aria-hidden="true">✓</span>
                  <span><code>{capability.name}</code><small>{capability.description}{capability.name === 'reset_simulation' ? ' Test-only simulator control; excluded by default.' : ''}</small></span>
                  <em className={`impact-label impact-${capability.impact}`}>{capability.name === 'reset_simulation' ? 'test only' : capability.impact}</em>
                </label>
              ))}
            </div>
          </section>

          <div className="access-truth-note"><span>◎</span><p><strong>Access-aware by design</strong>The pack asks Codex to verify the real platform and authorization before changing anything.</p></div>
        </div>

        <aside className="pack-preview">
          <div className="pack-preview-header">
            <div><span className="document-icon" aria-hidden="true">≡</span><span><strong>WEBMCP_IMPLEMENTATION.md</strong><small>{selectedCapabilities.length} selected tools · {accessPathLabels[accessPath]}</small></span></div>
            <span className="ready-badge">READY</span>
          </div>
          <pre role="region" tabIndex={0} aria-label="Generated WebMCP implementation brief">{pack}</pre>
          <div className="pack-actions">
            <button className="primary-button" type="button" onClick={copyPack}>{copyState === 'copied' ? 'Copied for Codex ✓' : copyState === 'failed' ? 'Copy failed' : 'Copy for Codex'} <span>⌘</span></button>
            <button className="secondary-button" type="button" onClick={downloadPack}>Download Markdown <span>↓</span></button>
          </div>
          <p className="pack-disclaimer">Implementation brief only. The original website remains unchanged.</p>
        </aside>
      </div>
    </section>
  )
}
