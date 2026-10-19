import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './shell/Layout';
import { Providers } from './shell/Providers';
import { pageRoutes } from './pages/routes';

/** The whole app below the router (BrowserRouter in main.tsx, MemoryRouter in tests). */
export default function App() {
  return (
    <Providers>
      <Routes>
        <Route element={<Layout />}>
          {pageRoutes.map(({ path, Component }) => (
            <Route key={path} path={path} element={<Component />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Providers>
  );
}
