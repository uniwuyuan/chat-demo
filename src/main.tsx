import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { installLogCapture } from './services/debug/log.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
installLogCapture(
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? 'dev'
)

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
