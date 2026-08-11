import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import ErrorBoundary, { installGlobalErrorReporting } from './components/ErrorBoundary'
import './styles/main.css'

installGlobalErrorReporting()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
