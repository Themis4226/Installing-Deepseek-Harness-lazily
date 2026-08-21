window.__ModuleLoader__.load({
  id: '@themis4226/dsh-launcher-update-ui',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const MESSAGE_HELLO = 'dsh-launcher:v1:hello'
    const MESSAGE_CHECK = 'dsh-launcher:v1:update.check'
    const STATE_TYPE = 'dsh-launcher.update-state'
    const PROTOCOL = 1
    const PHASES = new Set([
      'idle',
      'checking',
      'current',
      'available',
      'launcher-required',
      'downloading',
      'restarting',
      'unavailable',
      'error',
    ])

    const css = [
      '.dslu-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
      '.dslu-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
      '.dslu-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dslu-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
      '.dslu-button{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;justify-content:center;white-space:nowrap;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
      '.dslu-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dslu-button:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}',
    ].join('')
    const styleId = '@themis4226/dsh-launcher-update-ui/UpdateRow.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(styleId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@themis4226/dsh-launcher-update-ui'
      tag.dataset.pluginCss = styleId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    const zh = {
      title: '软件更新',
      description: '检查 DSH 运行时与桌面启动器的新版本',
      launcher: '启动器',
      check: '检查更新',
      'status.checking': '正在连接更新服务器…',
      'status.current': '当前已经是最新版本',
      'status.available': '发现运行时更新，请在确认窗口中继续',
      'status.launcher-required': '需要安装新版桌面启动器',
      'status.downloading': '正在下载并验证更新…',
      'status.restarting': '更新验证完成，DSH 即将重启…',
      'status.unavailable': '当前状态暂时无法检查更新',
      'status.error': '检查失败，请稍后重试',
    }
    const en = {
      title: 'Software update',
      description: 'Check for DSH runtime and desktop launcher updates',
      launcher: 'Launcher',
      check: 'Check for updates',
      'status.checking': 'Connecting to the update service…',
      'status.current': 'You are up to date',
      'status.available': 'A runtime update is available; continue in the confirmation dialog',
      'status.launcher-required': 'A newer desktop launcher is required',
      'status.downloading': 'Downloading and verifying the update…',
      'status.restarting': 'Update verified; DSH is restarting…',
      'status.unavailable': 'Updates cannot be checked in the current state',
      'status.error': 'Update check failed; try again later',
    }

    function webviewBridge() {
      const bridge = globalThis.chrome?.webview
      if (typeof bridge?.postMessage !== 'function' || typeof bridge?.addEventListener !== 'function') return undefined
      return bridge
    }

    function validVersion(value) {
      return typeof value === 'string' && value.length <= 64 && /^[0-9A-Za-z.+-]*$/.test(value)
    }

    function parseSnapshot(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      if (value.type !== STATE_TYPE || value.protocol !== PROTOCOL) return undefined
      if (!PHASES.has(value.phase) || typeof value.canCheck !== 'boolean') return undefined
      if (!validVersion(value.launcherVersion) || !validVersion(value.runtimeVersion)) return undefined
      return {
        connected: true,
        phase: value.phase,
        canCheck: value.canCheck,
        launcherVersion: value.launcherVersion,
        runtimeVersion: value.runtimeVersion,
      }
    }

    function UpdateRow({ t }) {
      const bridgeRef = React.useRef(undefined)
      const [snapshot, setSnapshot] = React.useState({
        connected: false,
        phase: 'idle',
        canCheck: false,
        launcherVersion: '',
        runtimeVersion: '',
      })

      React.useEffect(() => {
        const bridge = webviewBridge()
        if (bridge === undefined) return undefined
        bridgeRef.current = bridge
        const receive = (event) => {
          const next = parseSnapshot(event.data)
          if (next !== undefined) setSnapshot(next)
        }
        bridge.addEventListener('message', receive)
        try {
          bridge.postMessage(MESSAGE_HELLO)
        } catch {
          bridgeRef.current = undefined
        }
        return () => {
          bridgeRef.current = undefined
          bridge.removeEventListener?.('message', receive)
        }
      }, [])

      if (!snapshot.connected) return null
      const statusKey = snapshot.phase === 'idle' ? undefined : `status.${snapshot.phase}`
      const statusText = statusKey === undefined ? t('description') : t(statusKey)
      const versions = snapshot.launcherVersion === '' || snapshot.runtimeVersion === ''
        ? ''
        : `${t('launcher')} ${snapshot.launcherVersion} · DSH ${snapshot.runtimeVersion}`
      const description = versions === '' ? statusText : `${statusText} · ${versions}`

      const check = () => {
        const bridge = bridgeRef.current
        if (bridge === undefined || !snapshot.canCheck) return
        setSnapshot((current) => ({ ...current, phase: 'checking', canCheck: false }))
        try {
          bridge.postMessage(MESSAGE_CHECK)
        } catch {
          setSnapshot((current) => ({ ...current, phase: 'error', canCheck: true }))
        }
      }

      return React.createElement(
        'div',
        { className: 'dslu-row', 'data-dsh-launcher-update-row': '1' },
        React.createElement(
          'div',
          { className: 'dslu-rowText' },
          React.createElement('div', { className: 'dslu-title' }, t('title')),
          React.createElement(
            'div',
            { className: 'dslu-desc', role: 'status', 'aria-live': 'polite' },
            description,
          ),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dslu-button',
            disabled: !snapshot.canCheck,
            'aria-busy': snapshot.canCheck ? undefined : 'true',
            'data-dsh-launcher-update-check': '1',
            onClick: check,
          },
          t('check'),
        ),
      )
    }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register('settings.launcherUpdate', { zh, en }),
        'launcher-update-ui: dictionaries',
      )
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'launcher-update',
        order: 100,
        locale: 'settings.launcherUpdate',
      }, UpdateRow))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
