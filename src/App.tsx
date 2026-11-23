import { useState } from 'react';
import { AppShell, type NavSection } from './components/AppShell.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { AuthProvider, useAuth } from './contexts/AuthContext.tsx';
import { FirebaseProvider } from './contexts/FirebaseContext.tsx';
import { ThemeProvider } from './contexts/ThemeContext.tsx';
import { AdminView } from './features/admin/AdminView.tsx';
import { LoginView } from './features/auth/LoginView.tsx';
import { CategoriesView } from './features/categories/CategoriesView.tsx';
import { DuplicatesView } from './features/duplicates/DuplicatesView.tsx';
import { ExportsView } from './features/exports/ExportsView.tsx';
import { GeoCategorisationView } from './features/geo/GeoCategorisationView.tsx';
import { ReviewGrid } from './features/review/ReviewGrid.tsx';
import { UploadWorkspace } from './features/uploads/UploadWorkspace.tsx';
import { VercelTelemetry } from './components/VercelTelemetry.tsx';

function MarsforceContent() {
  const { user, loading } = useAuth();
  const [section, setSection] = useState<NavSection>('upload');
  const [activeUploadId, setActiveUploadId] = useState<string | undefined>(undefined);
  const [categoryFilter, setCategoryFilter] = useState<{ type?: string; value: string } | null>(null);
  const [geoFilter, setGeoFilter] = useState<{ area?: string; streetGroup?: string } | null>(null);
  const [globalSearch, setGlobalSearch] = useState('');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500">
        Initializing MARSFORCE workspace...
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LoginView />
        <VercelTelemetry route="/login" />
      </>
    );
  }

  return (
    <>
      <VercelTelemetry route={`/${section}`} />
      <AppShell
      activeSection={section}
      onNavigate={setSection}
      globalSearch={globalSearch}
      onGlobalSearchChange={setGlobalSearch}
      onGlobalSearchSubmit={() => setSection('review')}
    >
      {section === 'upload' && (
        <UploadWorkspace
          onOpenReviewForUpload={(id) => {
            setActiveUploadId(id);
            setCategoryFilter(null);
            setGeoFilter(null);
            setSection('review');
          }}
          onOpenGeoForUpload={(id) => {
            setActiveUploadId(id);
            setSection('geo');
          }}
          onGoToExports={(id) => {
            setActiveUploadId(id);
            setSection('exports');
          }}
        />
      )}
      {section === 'geo' && (
        <GeoCategorisationView
          initialUploadId={activeUploadId}
          onOpenReviewForGroup={(uploadId, areaKey, streetGroup) => {
            setActiveUploadId(uploadId);
            setCategoryFilter(null);
            setGeoFilter({ area: areaKey, streetGroup });
            setSection('review');
          }}
          onGoToExports={(id) => {
            setActiveUploadId(id);
            setSection('exports');
          }}
        />
      )}
      {section === 'review' && (
        <ReviewGrid
          initialUploadId={activeUploadId}
          initialCategoryFilter={categoryFilter}
          initialGeoFilter={geoFilter}
          globalSearch={globalSearch}
          onClearInitialFilters={() => {
            setActiveUploadId(undefined);
            setCategoryFilter(null);
            setGeoFilter(null);
          }}
        />
      )}
      {section === 'categories' && (
        <CategoriesView
          onFilterByCategory={(type, value) => {
            setCategoryFilter({ type, value });
            setGeoFilter(null);
            setSection('review');
          }}
        />
      )}
      {section === 'duplicates' && <DuplicatesView />}
      {section === 'exports' && <ExportsView initialUploadId={activeUploadId} />}
      {section === 'admin' && <AdminView />}
    </AppShell>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <FirebaseProvider>
          <AuthProvider>
            <MarsforceContent />
          </AuthProvider>
        </FirebaseProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
