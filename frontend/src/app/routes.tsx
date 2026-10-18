import { createBrowserRouter } from 'react-router'
import AppShell from '@/components/AppShell'
import NotFound from '@/screens/NotFound'
import SignIn from '@/screens/SignIn'
import Today from '@/screens/Today'

// Today and Sign in load with the shell; every other screen loads when first opened.
const screen = (load: () => Promise<{ default: React.ComponentType }>) => () => load().then((m) => ({ Component: m.default }))

export const router = createBrowserRouter([
  { path: '/signin', Component: SignIn },
  { path: '/shared/:token', lazy: screen(() => import('@/screens/FamilyView')) },
  {
    path: '/',
    Component: AppShell,
    children: [
      { index: true, Component: Today },
      { path: 'plan', lazy: screen(() => import('@/screens/PlanDay')) },
      { path: 'raasta', lazy: screen(() => import('@/screens/Raasta')) },
      { path: 'raasta/add', lazy: screen(() => import('@/screens/AddRoute')), handle: { pushed: true } },
      { path: 'raasta/route/:routeId', lazy: () => import('@/screens/Raasta').then((m) => ({ Component: m.RaastaRoute })), handle: { pushed: true } },
      { path: 'leg/:seq', lazy: screen(() => import('@/screens/LegDetail')), handle: { pushed: true } },
      { path: 'summary', lazy: screen(() => import('@/screens/Summary')), handle: { pushed: true } },
      { path: 'moderator', lazy: screen(() => import('@/screens/Moderator')), handle: { pushed: true } },
      { path: 'me', lazy: screen(() => import('@/screens/Me')) },
      { path: '*', Component: NotFound },
    ],
  },
])
