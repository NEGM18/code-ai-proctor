// =============================================================================
// StudentDashboard — /student/dashboard
//
// Left sidebar app layout with 4 tabs:
// 1. Reputation & Analysis (ProcScorePanel)
// 2. Profile & Settings (Full name editing + save toast)
// 3. My Classes (ClassroomHub + join class)
// 4. Evidence & Logs (EvidenceGallery)
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '../../lib/auth/useAuth.js';
import { uploadProfilePicture, removeProfilePicture } from '../../lib/auth/authService.js';
import { computeProcScore } from '../../lib/dashboard/procScore.js';
import {
  DATA_REASON,
  fetchClassrooms,
  fetchEvidence,
  fetchStudentRecord,
  proctoredHours,
} from '../../lib/dashboard/studentData.js';
import { displayNameFrom, initialsFrom } from '../../lib/profileIdentity.js';
import { navigate } from '../../lib/route.js';
import ClassroomHub from './ClassroomHub.jsx';
import EvidenceGallery from './EvidenceGallery.jsx';
import FlagReview from './FlagReview.jsx';
import ProcScorePanel from './ProcScorePanel.jsx';
import TrustedDevices from './TrustedDevices.jsx';

const EMPTY_RECORD = { ok: true, reason: null, sessions: [], violations: [] };
const EMPTY_EVIDENCE = { ok: true, reason: null, cards: [] };
const EMPTY_CLASSROOMS = { ok: true, reason: null, classrooms: [] };

/**
 * Kept in step with AVATAR_MIME_EXT in authService.js and with the bucket's own
 * `allowed_mime_types`. Three checks look redundant and are not: the bucket is
 * the actual enforcement, the service closes the set of storage paths, and this
 * one is the only check that runs before megabytes go over the wire.
 */
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Reason code -> something a student can act on. The old code surfaced the raw
 * reason, so an RLS rejection reached the user as "SUPABASE_ERROR" — which is
 * why a missing storage bucket was reported as a failure to reach the server.
 */
const UPLOAD_ERROR = {
  UNSUPPORTED_TYPE: 'That file type is not supported. Use a PNG, JPEG, WebP or GIF.',
  TOO_LARGE: 'That image is too large. Please choose one under 5 MB.',
  UPLOAD_FAILED: 'The image could not be uploaded. Please try again.',
  MISSING_INPUT: 'No image was selected.',
  SUPABASE_UNCONFIGURED: 'Accounts are not connected in this deployment, so the photo cannot be saved.',
  SUPABASE_ERROR: 'The server rejected the change. Please try again.',
  NO_USER: 'Your session has expired. Please sign in again.',
};

export default function StudentDashboard() {
  const { user, profile, verified, loading, configured, updateProfile, signOut, avatarUrl } = useAuth();

  // ⚠ 'flags' IS THE DEFAULT TAB, AND THAT IS DELIBERATE.
  //
  // The post-submit "See if you were flagged" button on the demo lands here, and
  // a student arriving from it should not have to hunt through a sidebar for the
  // one answer they came for. Nothing else on this dashboard is time-sensitive
  // in the same way; the reputation score is still one click away.
  const [activeTab, setActiveTab] = useState('flags'); // 'flags' | 'reputation' | 'profile' | 'classes' | 'evidence'
  const [evidenceFilter, setEvidenceFilter] = useState('ALL');
  const [highlightViolationId, setHighlightViolationId] = useState(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [record, setRecord] = useState(EMPTY_RECORD);
  const [evidence, setEvidence] = useState(EMPTY_EVIDENCE);
  const [classrooms, setClassrooms] = useState(EMPTY_CLASSROOMS);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleViewEvidence = (violationId, source) => {
    setEvidenceFilter(source === 'EXAM' ? 'EXAM' : 'DEMO');
    setHighlightViolationId(violationId);
    setActiveTab('evidence');
  };


  // Profile Form State
  const [fullName, setFullName] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  // Object URL for the not-yet-uploaded pick. NOT a base64 data: URL — the
  // previous version read the file with FileReader and, on upload failure, sent
  // that multi-megabyte string to be stored in the JWT's user_metadata.
  const [previewUrl, setPreviewUrl] = useState(null);
  const [photoCleared, setPhotoCleared] = useState(false);
  const [updatingProfile, setUpdatingProfile] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const initializedFormRef = useRef(false);

  // What the circle shows: an unsaved pick wins, then "cleared" (so Remove is
  // visible immediately rather than after the save), then the saved picture.
  const shownAvatar = previewUrl ?? (photoCleared ? null : avatarUrl);

  // Object URLs hold the file in memory until revoked. Tied to previewUrl's
  // lifetime rather than the component's, so repeated picks do not accumulate.
  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const userId = user?.id ?? null;

  // Synchronize profile name & picture into state once when user loads
  useEffect(() => {
    if ((user || profile) && !initializedFormRef.current) {
      initializedFormRef.current = true;
      setFullName(profile?.full_name ?? user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? '');
    }
  }, [profile, user]);

  useEffect(() => {
    if (!verified || !userId) return undefined;

    let cancelled = false;

    (async () => {
      const nextRecord = await fetchStudentRecord(userId);
      if (cancelled) return;
      setRecord(nextRecord);

      const [nextEvidence, nextClassrooms] = await Promise.all([
        fetchEvidence(userId, nextRecord),
        fetchClassrooms(userId, nextRecord),
      ]);
      if (cancelled) return;

      setEvidence(nextEvidence);
      setClassrooms(nextClassrooms);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, verified, refreshKey]);

  const onJoined = useCallback(() => setRefreshKey((key) => key + 1), []);

  const handleAvatarFile = (e) => {
    const file = e.target.files?.[0];
    // Reset immediately: without this, picking the same file twice in a row
    // fires no change event and the second attempt appears to do nothing.
    e.target.value = '';
    if (!file) return;

    // Checked here as well as in the service and on the bucket, because this is
    // the only one of the three that can fail before the bytes are uploaded.
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setToastMessage({ type: 'error', text: UPLOAD_ERROR.UNSUPPORTED_TYPE });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setToastMessage({ type: 'error', text: UPLOAD_ERROR.TOO_LARGE });
      return;
    }

    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setPhotoCleared(false);
    setToastMessage({ type: 'success', text: 'Photo selected — click "Save Profile Changes" to upload it.' });
  };

  const handleRemovePhoto = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    setPhotoCleared(true);
    setToastMessage({ type: 'success', text: 'Photo cleared — click "Save Profile Changes" to confirm.' });
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    if (!updateProfile || updatingProfile) return;
    setUpdatingProfile(true);
    setToastMessage(null);

    // `undefined` means "leave the picture alone" — distinct from `null`, which
    // means "clear it". Sending the wrong one wipes a photo on a name-only save.
    let avatarPath;

    if (selectedFile && userId) {
      const uploadRes = await uploadProfilePicture(userId, selectedFile);

      // ⚠ A FAILED UPLOAD ABORTS THE SAVE. The previous version fell through and
      // stored the base64 preview instead, so the picture appeared to work until
      // the oversized JWT broke the session. Reporting the real reason is the
      // only honest outcome: nothing was stored, and the user needs to know.
      if (!uploadRes.ok) {
        setUpdatingProfile(false);
        setToastMessage({
          type: 'error',
          text: UPLOAD_ERROR[uploadRes.reason] ?? UPLOAD_ERROR.UPLOAD_FAILED,
        });
        return;
      }

      avatarPath = uploadRes.path;
    } else if (photoCleared && userId) {
      await removeProfilePicture(userId);
      avatarPath = null;
    }

    const res = await updateProfile({ fullName, avatarPath });
    setUpdatingProfile(false);

    if (res.ok) {
      // Cleared only now that the saved value is what the context serves, so the
      // circle transitions straight from preview to stored picture.
      setSelectedFile(null);
      setPreviewUrl(null);
      setPhotoCleared(false);
      setToastMessage({ type: 'success', text: 'Profile updated.' });
      setTimeout(() => setToastMessage(null), 4000);
    } else {
      setToastMessage({ type: 'error', text: UPLOAD_ERROR[res.reason] ?? 'Could not save your profile. Please try again.' });
    }
  };

  if (loading) return <Centered>Checking your session…</Centered>;

  if (!configured) {
    return (
      <Centered>
        Accounts are not connected in this deployment — the Supabase key is still a placeholder.
      </Centered>
    );
  }

  if (!verified) {
    return (
      <Centered>
        <span className="block text-lg font-semibold text-slate-200">Sign in required</span>
        <span className="mt-1 block text-sm text-slate-400">Please sign in to view your integrity record and student dashboard.</span>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-6 rounded-lg bg-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
        >
          Back to the site
        </button>
      </Centered>
    );
  }

  const score = computeProcScore(record);
  const hours = proctoredHours(record.sessions);

  // ⚠ ONLY ROWS A MODEL ACTUALLY LOOKED AT. `ai_verdict === null` means "never
  // reviewed", which is not a verdict and must not be presented beside real
  // ones — an unreviewed row rendered as "Recorded" in the same list would read
  // as a finding the reviewer never made. Older sittings, and every violation
  // written before this feature existed, land in that bucket.
  const reviews = record.violations.filter((row) => row.ai_verdict);
  const flaggedCount = reviews.filter((row) => row.ai_verdict === 'CHEATING').length;
  const recordLoadFailed = record.reason === DATA_REASON.QUERY_FAILED;
  const name = displayNameFrom(profile, user);
  const initials = initialsFrom(profile?.full_name ?? name, user?.email);

  return (
    <div className="flex min-h-screen bg-base text-slate-100">
      {/* Background Orbs */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="cyber-grid absolute inset-0 opacity-40" />
        <div className="orb animate-pulse-slow top-[-6rem] left-[-8rem] h-96 w-96 bg-brand-blue opacity-30" />
      </div>

      {/* Mobile Top Navbar */}
      <div className="fixed top-0 left-0 right-0 z-30 flex items-center justify-between border-b border-slate-800 bg-surface/90 px-4 py-3 backdrop-blur-md lg:hidden">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileNavOpen((v) => !v)}
            className="rounded-md border border-slate-700 p-2 text-slate-300 hover:text-slate-100"
            aria-label="Toggle navigation menu"
          >
            <MenuIcon />
          </button>
          <span className="font-heading text-sm font-bold text-cyan-400">Procminds</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300 font-medium">{name}</span>
        </div>
      </div>

      {/* Left Sidebar Overlay for Mobile */}
      {mobileNavOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}

      {/* Left Sidebar Navigation */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 flex w-72 flex-col border-r border-slate-800/80 bg-surface/95 p-6 backdrop-blur-xl transition-transform duration-300 lg:static lg:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand Header */}
        <div className="flex items-center gap-3 pb-6 border-b border-slate-800/80">
          <img src="/brand/logo-transparent.png" alt="Procminds" className="h-8 w-auto drop-shadow-[0_0_10px_rgba(0,210,255,0.4)]" />
          <div>
            <h1 className="font-heading text-base font-bold tracking-wide text-slate-50">Procminds</h1>
            <p className="text-[11px] text-cyan-400">Student Workspace</p>
          </div>
        </div>

        {/* User Card Profile Summary */}
        <div className="mt-6 flex items-center gap-3.5 rounded-xl border border-slate-800 bg-surface-raised/50 p-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full border border-cyan-400/40 bg-surface-raised font-heading text-xs font-bold text-cyan-300">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
            ) : (
              <span>{initials}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-xs font-semibold text-slate-100">{name}</p>
            <p className="truncate text-[11px] text-slate-400">{user?.email}</p>
          </div>
        </div>

        {/* Sidebar Nav Links */}
        <nav className="mt-8 flex-1 space-y-2">
          <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Navigation</p>
          
          <NavItem
            active={activeTab === 'flags'}
            onClick={() => { setActiveTab('flags'); setMobileNavOpen(false); }}
            icon={<FlagIcon />}
            label="Flag Review"
            badge={flaggedCount}
          />

          <NavItem
            active={activeTab === 'reputation'}
            onClick={() => { setActiveTab('reputation'); setMobileNavOpen(false); }}
            icon={<ChartIcon />}
            label="Reputation & Analysis"
          />

          <NavItem
            active={activeTab === 'profile'}
            onClick={() => { setActiveTab('profile'); setMobileNavOpen(false); }}
            icon={<UserIcon />}
            label="Profile & Settings"
          />

          <NavItem
            active={activeTab === 'classes'}
            onClick={() => { setActiveTab('classes'); setMobileNavOpen(false); }}
            icon={<BookIcon />}
            label="My Classes"
            badge={classrooms.classrooms.length}
          />

          <NavItem
            active={activeTab === 'evidence'}
            onClick={() => { setActiveTab('evidence'); setMobileNavOpen(false); }}
            icon={<ShieldIcon />}
            label="Evidence & Logs"
            badge={evidence.cards.length}
          />
        </nav>

        {/* Footer Actions */}
        <div className="pt-6 border-t border-slate-800/80 space-y-2">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-200"
          >
            <HomeIcon />
            Back to Site
          </button>
          <button
            type="button"
            onClick={async () => { await signOut(); navigate('/'); }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-rose-400 transition hover:bg-rose-500/10 hover:text-rose-300"
          >
            <ExitIcon />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Workspace Area */}
      <main className="relative flex-1 p-6 sm:p-10 pt-20 lg:pt-10 max-w-6xl mx-auto overflow-y-auto">
        {/* Feedback Toast Banner */}
        {toastMessage ? (
          <div
            className={`fixed top-4 right-4 z-50 flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-semibold shadow-xl transition-all ${
              toastMessage.type === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
            }`}
          >
            <span>{toastMessage.type === 'success' ? '✓' : '⚠️'}</span>
            <span>{toastMessage.text}</span>
          </div>
        ) : null}

        {/* Workspace Tab Header */}
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div>
            <h2 className="font-heading text-2xl font-bold tracking-tight text-slate-50">
              {activeTab === 'flags' && 'Flag Review'}
              {activeTab === 'reputation' && 'Reputation & Integrity Analysis'}
              {activeTab === 'profile' && 'Student Profile & Settings'}
              {activeTab === 'classes' && 'Enrolled Classrooms'}
              {activeTab === 'evidence' && 'Proctoring Evidence & Sitting History'}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {activeTab === 'flags' && 'What the proctor concluded about your sittings, and why.'}
              {activeTab === 'reputation' && 'Your verified academic integrity record and score analysis.'}
              {activeTab === 'profile' && 'Manage your personal account details and profile preferences.'}
              {activeTab === 'classes' && 'Classes you have joined and active proctored exam sessions.'}
              {activeTab === 'evidence' && 'Log of proctored exam sittings and captured evidence.'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              className="rounded-lg border border-slate-800 bg-surface/70 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-700 hover:text-slate-100"
            >
              🔄 Refresh Data
            </button>
          </div>
        </header>

        {/* Tab 0: Flag Review — the landing tab, and where the demo's
            "See if you were flagged" button arrives. */}
        {activeTab === 'flags' ? (
          <FlagReview
            reviews={reviews}
            loadFailed={recordLoadFailed}
            onViewEvidence={handleViewEvidence}
          />
        ) : null}

        {/* Tab 1: Reputation & Analysis */}
        {activeTab === 'reputation' ? (
          <div className="space-y-8">
            {record.reason === DATA_REASON.QUERY_FAILED ? (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
                Your integrity record could not be loaded completely. Click Refresh Data to try again.
              </p>
            ) : null}
            <ProcScorePanel score={score} hours={hours} />
          </div>
        ) : null}

        {/* Tab 2: Profile & Settings */}
        {activeTab === 'profile' ? (
          <section className="glass max-w-2xl rounded-2xl border border-slate-800 bg-surface/80 p-6 sm:p-8 backdrop-blur-xl">
            <h3 className="font-heading text-lg font-semibold text-slate-100">Account Details & Profile Picture</h3>
            <p className="mt-1 text-xs text-slate-400">Update your profile photo, student name, and account preferences.</p>

            <form onSubmit={handleSaveProfile} className="mt-6 space-y-6">
              {/* Profile Photo Uploader */}
              <div className="rounded-xl border border-slate-800 bg-surface-raised/40 p-4">
                <label className="block text-xs font-medium text-slate-300">Profile Picture</label>
                <div className="mt-3 flex flex-wrap items-center gap-5">
                  {/* Photo Preview Circle */}
                  <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-cyan-500/40 bg-surface-raised font-heading text-lg font-bold text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
                    {shownAvatar ? (
                      <img src={shownAvatar} alt="Profile" className="h-full w-full object-cover" />
                    ) : (
                      <span>{initials}</span>
                    )}
                  </div>

                  {/* Upload Controls */}
                  <div className="flex-1 space-y-2 min-w-[200px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="cursor-pointer rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3.5 py-1.5 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20">
                        Upload Image File
                        <input
                          type="file"
                          accept={ACCEPTED_IMAGE_TYPES.join(',')}
                          onChange={handleAvatarFile}
                          className="hidden"
                        />
                      </label>
                      {shownAvatar ? (
                        <button
                          type="button"
                          onClick={handleRemovePhoto}
                          className="rounded-lg border border-slate-700 bg-surface/80 px-3 py-1.5 text-xs text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300"
                        >
                          Remove Photo
                        </button>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-slate-500">PNG, JPEG, WebP or GIF, up to 5 MB</p>
                  </div>
                </div>

                {/* ⚠ THE "or specify an Image URL" FIELD WAS REMOVED HERE, on
                    purpose, and should not be reinstated without a deliberate
                    decision. It let a student point their avatar at any remote
                    URL, which the app then rendered in the nav for anyone
                    viewing the account — an off-site request on every page load,
                    i.e. a tracking pixel and an IP disclosure served under our
                    own UI, and a way to host arbitrary imagery inside the
                    product. It also cannot round-trip through `avatar_path`,
                    which stores an object path in our bucket rather than a URL.
                    Uploading a file covers the actual requirement. */}
              </div>

              {/* Inside the <form> for layout, but it owns its own actions:
                  revoking a device takes effect immediately and must not wait
                  for — or be undone by — "Save Profile Changes". */}
              <TrustedDevices userId={userId} />

              <div>
                <label htmlFor="student-fullname" className="block text-xs font-medium text-slate-300">
                  Full Name
                </label>
                <input
                  id="student-fullname"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-surface/80 px-3.5 py-2.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
                  placeholder="Enter your full name"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300">Email Address</label>
                <input
                  type="email"
                  value={user?.email ?? ''}
                  disabled
                  className="mt-1.5 w-full cursor-not-allowed rounded-lg border border-slate-800 bg-slate-900/60 px-3.5 py-2.5 text-sm text-slate-400"
                />
                <p className="mt-1 text-[11px] text-slate-500">Email address is associated with your login provider.</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300">Role</label>
                <input
                  type="text"
                  value={profile?.role ? profile.role.toUpperCase() : 'STUDENT'}
                  disabled
                  className="mt-1.5 w-full cursor-not-allowed rounded-lg border border-slate-800 bg-slate-900/60 px-3.5 py-2.5 text-sm text-cyan-400 font-mono"
                />
              </div>

              <div className="pt-4">
                <button
                  type="submit"
                  disabled={updatingProfile}
                  className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2.5 text-xs font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-50"
                >
                  {updatingProfile ? 'Saving Changes…' : 'Save Profile Changes'}
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {/* Tab 3: My Classes */}
        {activeTab === 'classes' ? (
          <ClassroomHub result={classrooms} onJoined={onJoined} />
        ) : null}

        {/* Tab 4: Evidence & Logs */}
        {activeTab === 'evidence' ? (
          <EvidenceGallery
            result={evidence}
            selectedTab={evidenceFilter}
            highlightId={highlightViolationId}
          />
        ) : null}

      </main>
    </div>
  );
}

function NavItem({ active, onClick, icon, label, badge }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-xs font-medium transition-all ${
        active
          ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-[0_0_15px_rgba(6,182,212,0.15)]'
          : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className={active ? 'text-cyan-300' : 'text-slate-400'}>{icon}</span>
        <span>{label}</span>
      </div>
      {typeof badge === 'number' && badge > 0 ? (
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-300">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function Centered({ children }) {
  return (
    <div className="grid min-h-screen place-items-center bg-base p-6 text-center">
      <div className="max-w-md">{children}</div>
    </div>
  );
}

/* Icon Helpers */
function FlagIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 21V4m0 0h11l-1.5 4L15 12H4" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" d="M4 20V10m6 10V4m6 16v-7" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
