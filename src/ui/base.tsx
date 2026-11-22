import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => { dialog.close() }
  }, [])
  return <dialog ref={ref} className="dialog" onCancel={event => { event.preventDefault(); close() }} aria-label={title}>
    <header className="dialog-head"><h2>{title}</h2><button className="icon" aria-label="Cerrar" onClick={close}><X size={20}/></button></header>
    {children}
  </dialog>
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-mark" aria-hidden="true">✳</span><h2>{title}</h2>{children}</div>
}
