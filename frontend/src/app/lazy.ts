// The app shell and Today load on demand (see routes.tsx). Sign in starts them early.
export const loadShell = () => import('@/components/AppShell')
export const loadToday = () => import('@/screens/Today')
