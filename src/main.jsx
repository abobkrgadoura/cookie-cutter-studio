import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { ModelProvider } from './context/ModelContext.jsx'
import { SettingsProvider } from './context/SettingsContext.jsx'
import { VectorEditorProvider } from './context/VectorEditorContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <SettingsProvider>
          <VectorEditorProvider>
            <ModelProvider>
              <App />
            </ModelProvider>
          </VectorEditorProvider>
        </SettingsProvider>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)
