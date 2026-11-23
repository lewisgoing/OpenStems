import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import TrayApp from './tray/TrayApp'

// The quick-drop window by the tray loads the same page with `?window=tray`.
const tray = new URLSearchParams(window.location.search).get('window') === 'tray'

createRoot(document.getElementById('root')!).render(<StrictMode>{tray ? <TrayApp /> : <App />}</StrictMode>)
