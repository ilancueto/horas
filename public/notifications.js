self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL('/?hoy=1', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(async (clients) => {
      const existing = clients.find((client) => client.url.startsWith(self.location.origin + '/'))
      if (!existing) return self.clients.openWindow(url)
      const navigated = await existing.navigate(url)
      return navigated?.focus()
    }),
  )
})
