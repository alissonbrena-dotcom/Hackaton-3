import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { RedirectIfAuthenticated, RequireAuth, RequirePermission } from './auth/guards'
import { HealthGate } from './components/HealthGate'
import { Layout } from './components/Layout'
import LoginPage from './pages/LoginPage'
import NotFoundPage from './pages/NotFoundPage'
import RouteError from './pages/RouteError'

// Las páginas privadas se cargan con import() → code splitting (el bundle de /login queda chico).
const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    children: [
      {
        element: <RedirectIfAuthenticated />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/register', lazy: async () => ({ Component: (await import('./pages/RegisterPage')).default }) },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <Layout />,
            errorElement: <RouteError />,
            children: [
              { path: '/', element: <Navigate to="/files" replace /> },
              {
                path: '/files',
                lazy: async () => {
                  const { default: FilesPage } = await import('./pages/FilesPage')
                  return {
                    Component: () => (
                      <RequirePermission permission="files:read">
                        <FilesPage />
                      </RequirePermission>
                    ),
                  }
                },
              },
              {
                path: '/files/:id/refine',
                lazy: async () => {
                  const { default: RefinePage } = await import('./pages/RefinePage')
                  return {
                    Component: () => (
                      <RequirePermission permission="files:read">
                        <RefinePage />
                      </RequirePermission>
                    ),
                  }
                },
              },
              {
                path: '/refiners',
                lazy: async () => {
                  const { default: RefinersPage } = await import('./pages/RefinersPage')
                  return {
                    Component: () => (
                      <RequirePermission permission="refiners:read">
                        <RefinersPage />
                      </RequirePermission>
                    ),
                  }
                },
              },
              {
                path: '/refiners/:id/edit',
                lazy: async () => {
                  const { default: RefinerEditPage } = await import('./features/milchick/RefinerEditPage')
                  return {
                    Component: () => (
                      <RequirePermission permission="refiners:write">
                        <RefinerEditPage />
                      </RequirePermission>
                    ),
                  }
                },
              },
              {
                path: '/refiners/:id/badge',
                lazy: async () => {
                  const { default: BadgeEditorPage } = await import('./pages/BadgeEditorPage')
                  return {
                    Component: () => (
                      <RequirePermission permission="refiners:write">
                        <BadgeEditorPage />
                      </RequirePermission>
                    ),
                  }
                },
              },
              {
                path: '/incidents',
                lazy: async () => {
                  const { default: IncidentsPage } = await import('./pages/IncidentsPage')
                  return {
                    Component: () => (
                      <RequirePermission permission="incidents:read">
                        <IncidentsPage />
                      </RequirePermission>
                    ),
                  }
                },
              },
              {
                path: '/incidents/new',
                lazy: async () => {
                  const { default: IncidentNewPage } = await import('./pages/IncidentNewPage')
                  return {
                    Component: () => (
                      <RequirePermission permission="incidents:create">
                        <IncidentNewPage />
                      </RequirePermission>
                    ),
                  }
                },
              },
              { path: '/estado', lazy: async () => ({ Component: (await import('./pages/EstadoPage')).default }) },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

export default function App() {
  return (
    <HealthGate>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </HealthGate>
  )
}
