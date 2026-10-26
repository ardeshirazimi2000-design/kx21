import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/shell';
import { Loading } from './components/ui';
import { useAuth } from './lib/auth';
import { ArchivePage } from './pages/Archive';
import { AuditPage } from './pages/Audit';
import { CartablePage } from './pages/Cartable';
import { DashboardPage } from './pages/Dashboard';
import { IntegrationsPage } from './pages/Integrations';
import { LetterDetailPage } from './pages/LetterDetail';
import { LetterFormPage } from './pages/LetterForm';
import { LetterPrintPage } from './pages/LetterPrint';
import { LetterTemplatesPage } from './pages/LetterTemplates';
import { LettersPage } from './pages/Letters';
import { LoginPage } from './pages/Login';
import { MeetingDetailPage, MeetingsPage } from './pages/Meetings';
import { NotificationsPage, TemplatesPage } from './pages/Notifications';
import { OrgPage } from './pages/Org';
import { ProfilePage } from './pages/Profile';
import { ReportsPage } from './pages/Reports';
import { ResolutionDetailPage, ResolutionsPage } from './pages/Resolutions';
import { RolesPage } from './pages/Roles';
import { SignaturesPage } from './pages/Signatures';
import { SmartSearchPage } from './pages/SmartSearch';
import { UsersPage } from './pages/Users';
import { VerifyPage } from './pages/Verify';
import { WorkflowsPage } from './pages/Workflows';

export function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  // Public verification of a printed letter (QR code).
  if (loc.pathname.startsWith('/verify/')) {
    return (
      <Routes>
        <Route path="/verify/:code" element={<VerifyPage />} />
      </Routes>
    );
  }
  if (loading) return <Loading />;
  if (!me) return <LoginPage />;
  if (me.mfaRequired && !me.mfa_enabled) {
    return (
      <Shell>
        <ProfilePage forceMfa />
      </Shell>
    );
  }
  // The printable letter stands alone, without the app shell.
  if (/^\/letters\/[^/]+\/print$/.test(loc.pathname)) {
    return (
      <Routes>
        <Route path="/letters/:id/print" element={<LetterPrintPage />} />
      </Routes>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/cartable" element={<CartablePage />} />
        <Route path="/letters" element={<LettersPage />} />
        <Route path="/smart-search" element={<SmartSearchPage />} />
        <Route path="/letters/new" element={<LetterFormPage />} />
        <Route path="/letters/:id" element={<LetterDetailPage />} />
        <Route path="/letters/:id/edit" element={<LetterFormPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/signatures" element={<SignaturesPage />} />
        <Route path="/letter-templates" element={<LetterTemplatesPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:id" element={<MeetingDetailPage />} />
        <Route path="/resolutions" element={<ResolutionsPage />} />
        <Route path="/resolutions/:id" element={<ResolutionDetailPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/notification-templates" element={<TemplatesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/org" element={<OrgPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
