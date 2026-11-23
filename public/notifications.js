self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // El scope del service worker es la base de la app (`/` o `/horas/`).
  const scope = self.registration.scope
  const url = new URL('./?hoy=1', scope).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(async (clients) => {
      const existing = clients.find((client) => client.url.startsWith(scope))
      if (!existing) return self.clients.openWindow(url)
      const navigated = await existing.navigate(url)
      return navigated?.focus()
    }),
  )
})
