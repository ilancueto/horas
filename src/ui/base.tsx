import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clock3, HardDrive, X } from 'lucide-react'
import { today } from '../domain/dates'
import { notify } from '../data/db'
import { backup } from '../data/transfer'

export function Dialog({
  title,
  close,
  children,
  busy = false,
  fitKeyboard = false,
}: {
  title: string
  close: () => void
  children: ReactNode
  /** Mientras está ocupado, no se puede cerrar (ni con Escape). */
  busy?: boolean
  fitKeyboard?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    const viewport = fitKeyboard ? window.visualViewport : null
    let frame = 0
    function updateViewport() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!viewport) return
        const covered = window.innerHeight - viewport.height
        if (viewport.scale > 1.01 || covered < 100) {
          dialog.style.removeProperty('--keyboard-bottom')
          dialog.style.removeProperty('--keyboard-height')
          dialog.style.removeProperty('--keyboard-top')
          return
        }
        dialog.style.setProperty(
          '--keyboard-bottom',
          `${Math.max(0, covered - viewport.offsetTop)}px`,
        )
        dialog.style.setProperty('--keyboard-height', `${viewport.height}px`)
        dialog.style.setProperty('--keyboard-top', `${viewport.offsetTop}px`)

        const field = document.activeElement
        if (!field?.matches('input, textarea, select') || !dialog.contains(field)) return
        const label = (field.closest('label') ?? field).getBoundingClientRect()
        const top = (dialog.firstElementChild?.getBoundingClientRect().bottom ?? 0) + 8
        const bottom = dialog.getBoundingClientRect().bottom - 8
        if (label.top < top) dialog.scrollTop += label.top - top
        else if (label.bottom > bottom) dialog.scrollTop += label.bottom - bottom
      })
    }
    if (viewport) {
      viewport.addEventListener('resize', updateViewport)
      viewport.addEventListener('scroll', updateViewport)
      dialog.addEventListener('focusin', updateViewport)
      updateViewport()
    }
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      dialog.removeEventListener('focusin', updateViewport)
      dialog.style.removeProperty('--keyboard-bottom')
      dialog.style.removeProperty('--keyboard-height')
      dialog.style.removeProperty('--keyboard-top')
      dialog.close()
    }
  }, [fitKeyboard])
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
      aria-label={title}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <button className="icon" aria-label="Cerrar" disabled={busy} onClick={close}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  )
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-mark" aria-hidden="true">
        <Clock3 size={24} />
      </span>
      <h2>{title}</h2>
      {children}
    </div>
  )
}

export function DeleteActions({
  remove,
  cancel,
}: {
  remove: () => Promise<void>
  cancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  async function run(withBackup: boolean) {
    setBusy(true)
    try {
      if (withBackup) await backup(today())
      await remove()
    } catch {
      notify('No se pudo completar el borrado. Volvé a intentar.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="stack delete-box">
      <p>¿Querés guardar un respaldo antes de borrar?</p>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void run(true)}>
          <HardDrive size={16} /> Backup y borrar
        </button>
        <button type="button" disabled={busy} onClick={() => void run(false)}>
          Borrar
        </button>
        <button type="button" disabled={busy} onClick={cancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
