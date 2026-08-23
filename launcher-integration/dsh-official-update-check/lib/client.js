window.__ModuleLoader__.load({
  id: '@themis4226/dsh-official-update-check',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const PACKAGE_NAME = '@deepseek-ai/dsh'
    const OFFICIAL_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest'
    const MESSAGE_HELLO = 'dsh-launcher:v1:hello'
    const STATE_TYPE = 'dsh-launcher.update-state'
    const PROTOCOL = 1
    const REQUEST_TIMEOUT_MS = 15_000
    const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

    const css = [
      '.dsmou-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
      '.dsmou-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
      '.dsmou-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dsmou-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
      '.dsmou-button{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;justify-content:center;white-space:nowrap;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
      '.dsmou-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsmou-button:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}',
    ].join('')
    const styleId = '@themis4226/dsh-official-update-check/OfficialUpdateRow.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(styleId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@themis4226/dsh-official-update-check'
      tag.dataset.pluginCss = styleId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    const zh = {
      title: '官方更新检查',
      description: '查询 DeepSeek 官方 npm 版本；不会安装或发布更新',
      check: '检查官方更新',
      'status.checking': '正在连接 DeepSeek 官方 npm…',
      'status.current': '本机版本与官方最新版本一致',
      'status.available': '发现官方新版，请先隔离验证兼容性',
      'status.ahead': '本机版本高于官方 latest 标签版本',
      'status.error': '官方版本检查失败，请稍后重试',
      local: '本机',
      official: '官方',
    }
    const en = {
      title: 'Official update check',
      description: 'Check the official DeepSeek npm version; no update is installed or published',
      check: 'Check official update',
      'status.checking': 'Connecting to the official DeepSeek npm registry…',
      'status.current': 'The local version matches the official latest version',
      'status.available': 'An official update is available; validate compatibility in isolation first',
      'status.ahead': 'The local version is newer than the official latest tag',
      'status.error': 'Could not check the official version; try again later',
      local: 'Local',
      official: 'Official',
    }

    function webviewBridge() {
      const bridge = globalThis.chrome?.webview
      if (typeof bridge?.postMessage !== 'function' || typeof bridge?.addEventListener !== 'function') return undefined
      return bridge
    }

    function parseSemver(value) {
      if (typeof value !== 'string' || value.length > 64) return undefined
      const match = SEMVER.exec(value)
      if (match === null) return undefined
      return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: match[4] === undefined ? [] : match[4].split('.'),
      }
    }

    function compareSemver(left, right) {
      const a = parseSemver(left)
      const b = parseSemver(right)
      if (a === undefined || b === undefined) return undefined
      for (let index = 0; index < a.core.length; index += 1) {
        if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
      }
      if (a.prerelease.length === 0 || b.prerelease.length === 0) {
        if (a.prerelease.length === b.prerelease.length) return 0
        return a.prerelease.length === 0 ? 1 : -1
      }
      const length = Math.max(a.prerelease.length, b.prerelease.length)
      for (let index = 0; index < length; index += 1) {
        const ai = a.prerelease[index]
        const bi = b.prerelease[index]
        if (ai === undefined) return -1
        if (bi === undefined) return 1
        if (ai === bi) continue
        const aNumeric = /^\d+$/.test(ai)
        const bNumeric = /^\d+$/.test(bi)
        if (aNumeric && bNumeric) return Number(ai) > Number(bi) ? 1 : -1
        if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
        return ai > bi ? 1 : -1
      }
      return 0
    }

    function parseLauncherSnapshot(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      if (value.type !== STATE_TYPE || value.protocol !== PROTOCOL) return undefined
      if (typeof value.runtimeVersion !== 'string' || parseSemver(value.runtimeVersion) === undefined) return undefined
      return { connected: true, runtimeVersion: value.runtimeVersion }
    }

    async function readOfficialVersion(fetchImpl, signal) {
      if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
      const response = await fetchImpl(OFFICIAL_LATEST_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response?.ok) throw new Error(`npm registry returned ${String(response?.status)}`)
      const value = await response.json()
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid npm response')
      if (value.name !== PACKAGE_NAME || parseSemver(value.version) === undefined) throw new Error('unexpected npm package metadata')
      return value.version
    }

    function OfficialUpdateRow({ t }) {
      const bridgeRef = React.useRef(undefined)
      const requestRef = React.useRef(undefined)
      const [launcher, setLauncher] = React.useState({ connected: false, runtimeVersion: '' })
      const [check, setCheck] = React.useState({ phase: 'idle', officialVersion: '' })

      React.useEffect(() => {
        const bridge = webviewBridge()
        if (bridge === undefined) return undefined
        bridgeRef.current = bridge
        const receive = (event) => {
          const next = parseLauncherSnapshot(event.data)
          if (next !== undefined) setLauncher(next)
        }
        bridge.addEventListener('message', receive)
        try {
          bridge.postMessage(MESSAGE_HELLO)
        } catch {
          bridgeRef.current = undefined
        }
        return () => {
          bridgeRef.current = undefined
          requestRef.current?.abort()
          requestRef.current = undefined
          bridge.removeEventListener?.('message', receive)
        }
      }, [])

      if (!launcher.connected) return null

      const runCheck = async () => {
        if (check.phase === 'checking') return
        const controller = new AbortController()
        let timedOut = false
        const timeout = globalThis.setTimeout(() => {
          timedOut = true
          controller.abort()
        }, REQUEST_TIMEOUT_MS)
        requestRef.current?.abort()
        requestRef.current = controller
        setCheck({ phase: 'checking', officialVersion: '' })
        try {
          const officialVersion = await readOfficialVersion(globalThis.fetch?.bind(globalThis), controller.signal)
          if (requestRef.current !== controller) return
          const comparison = compareSemver(officialVersion, launcher.runtimeVersion)
          if (comparison === undefined) throw new Error('version comparison failed')
          setCheck({
            phase: comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current',
            officialVersion,
          })
        } catch (error) {
          if (requestRef.current !== controller || (controller.signal.aborted && !timedOut)) return
          setCheck({ phase: 'error', officialVersion: '' })
        } finally {
          globalThis.clearTimeout(timeout)
          if (requestRef.current === controller) requestRef.current = undefined
        }
      }

      const statusText = check.phase === 'idle' ? t('description') : t(`status.${check.phase}`)
      const versions = check.officialVersion === ''
        ? `${t('local')} DSH ${launcher.runtimeVersion}`
        : `${t('local')} DSH ${launcher.runtimeVersion} · ${t('official')} DSH ${check.officialVersion}`

      return React.createElement(
        'div',
        { className: 'dsmou-row', 'data-dsh-official-update-check-row': '1' },
        React.createElement(
          'div',
          { className: 'dsmou-rowText' },
          React.createElement('div', { className: 'dsmou-title' }, t('title')),
          React.createElement(
            'div',
            { className: 'dsmou-desc', role: 'status', 'aria-live': 'polite' },
            `${statusText} · ${versions}`,
          ),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsmou-button',
            disabled: check.phase === 'checking',
            'aria-busy': check.phase === 'checking' ? 'true' : undefined,
            'data-dsh-official-update-check': '1',
            onClick: runCheck,
          },
          t('check'),
        ),
      )
    }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register('settings.maintainerOfficialUpdate', { zh, en }),
        'official-update-check: dictionaries',
      )
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'official-update-check',
        order: 110,
        locale: 'settings.maintainerOfficialUpdate',
      }, OfficialUpdateRow))
    }

    exports.OFFICIAL_LATEST_URL = OFFICIAL_LATEST_URL
    exports.compareSemver = compareSemver
    exports.parseLauncherSnapshot = parseLauncherSnapshot
    exports.readOfficialVersion = readOfficialVersion
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
