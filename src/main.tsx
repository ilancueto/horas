import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/big-shoulders-display/wght'
import '@fontsource-variable/instrument-sans/wght'
import './styles.css'
import { App } from './ui/App'

history.scrollRestoration = 'manual'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
