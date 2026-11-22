import { Clock3 } from 'lucide-react'
import { Empty } from './base'

export function App() {
  return <main className="welcome"><div className="brand"><span><Clock3 /></span>Horas</div><Empty title="Tu registro de jornadas"><p>Organizá tus horas y cierres de período.</p></Empty></main>
}
