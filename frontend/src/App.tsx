import * as Tooltip from '@radix-ui/react-tooltip'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { MotionConfig } from 'motion/react'
import { RouterProvider } from 'react-router'
import { router } from '@/app/routes'
import { persistable, queryClient } from '@/api/queries'
import { useRestoreSession } from '@/lib/session'
import { useDocumentSettings } from '@/lib/theme'

// The query cache survives a reload, so a loaded plan keeps working with no signal.
const persister = createSyncStoragePersister({ storage: window.localStorage, key: 'reroute:cache', throttleTime: 1000 })

export default function App() {
  useDocumentSettings()
  useRestoreSession()
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 3600_000,
        buster: 'v2',
        dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status === 'success' && persistable(q.queryKey) },
      }}
    >
      <MotionConfig reducedMotion="user">
        <Tooltip.Provider delayDuration={400}>
          <RouterProvider router={router} />
        </Tooltip.Provider>
      </MotionConfig>
    </PersistQueryClientProvider>
  )
}
