import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router'
import Home from './pages/Home'

// Building è una sezione a sé, caricata solo quando serve
const Building = lazy(() => import('./pages/Building'))

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route
        path="/building"
        element={
          <Suspense fallback={<div className="p-6 font-mono text-sm text-[#525252]">Carico Building…</div>}>
            <Building />
          </Suspense>
        }
      />
    </Routes>
  )
}
