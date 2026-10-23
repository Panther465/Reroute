import { createBrowserRouter } from 'react-router'
import NotFound from '@/screens/NotFound'
import SignIn from '@/screens/SignIn'
import { loadShell, loadToday } from './lazy'
import { RouteError } from './RouteError'

// Sign in loads with the app; the shell and every screen load when first opened, so the sign-in page
// stays small. On a signed-in load the shell and Today load side by side.
const screen = (load: () => Promise<{ default: React.ComponentType }>) => () => load().then((m) => ({ Component: m.default }))

export const router = createBrowserRouter([
  {
    // Anything that crashes outside a screen (or the shell itself) shows the page-level message.
    errorElement: <RouteError full />,
    hydrateFallbackElement: <div className="min-h-dvh bg-ground" />,
    children: [
      { path: '/signin', Component: SignIn },
      { path: '/shared/:token', lazy: screen(() => import('@/screens/FamilyView')) },
      // A new account meets Roo full screen, outside the tabs.
      { path: '/welcome', lazy: screen(() => import('@/screens/Welcome')) },
      {
        path: '/',
        lazy: screen(loadShell),
        children: [
          {
            // A screen that crashes shows the message inside the shell, so the tabs still work.
            errorElement: <RouteError />,
            children: [
              { index: true, lazy: screen(loadToday) },
              { path: 'plan', lazy: screen(() => import('@/screens/PlanDay')) },
              { path: 'raasta', lazy: screen(() => import('@/screens/Raasta')) },
              { path: 'raasta/add', lazy: screen(() => import('@/screens/AddRoute')), handle: { pushed: true } },
              { path: 'raasta/route/:routeId', lazy: () => import('@/screens/Raasta').then((m) => ({ Component: m.RaastaRoute })), handle: { pushed: true } },
              { path: 'leg/:seq', lazy: screen(() => import('@/screens/LegDetail')), handle: { pushed: true } },
              { path: 'leg/:seq/navigate', lazy: screen(() => import('@/screens/Navigate')), handle: { pushed: true } },
              { path: 'summary', lazy: screen(() => import('@/screens/Summary')), handle: { pushed: true } },
              { path: 'why', lazy: screen(() => import('@/screens/WhyPlan')), handle: { pushed: true } },
              { path: 'moderator', lazy: screen(() => import('@/screens/Moderator')), handle: { pushed: true } },
              { path: 'me', lazy: screen(() => import('@/screens/Me')) },
              { path: '*', Component: NotFound },
            ],
          },
        ],
      },
    ],
  },
])
