import { useEffect, useState } from "react";
import type { FormEvent } from "react";

const API = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const STATUSES = ["Saved", "Applied", "Interviewing", "Rejected", "Offered", "Withdrawn"];
type Job = { id: string | number; title?: string; company?: string; location?: string; apply_url?: string };
type Account = { id: string; name: string; email: string; created_at?: string; preferred_titles: string[]; preferred_locations: string[]; remote_preference: string; employment_types: string[]; interests: string[] };
type Application = { status: string; notes?: string; created_at?: string; updated_at?: string; job: Job };
type Visit = { id: string; visited_at: string; job: Job };

function getToken() { try { return localStorage.getItem("jobsync-token") || ""; } catch { return ""; } }
async function responseError(response: Response) { try { const data = await response.json(); return data.detail || "Request failed."; } catch { return "Request failed. Check the backend connection."; } }
const inputClass = "mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export default function PortalPage() {
  const path = window.location.pathname;
  const [token, setToken] = useState(getToken);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [originalAccount, setOriginalAccount] = useState<Account | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [filter, setFilter] = useState("All");
  const [sortNewest, setSortNewest] = useState(true);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (["/profile", "/applications", "/activity", "/saved-jobs"].includes(path) && !token) {
      window.location.replace(`/login?next=${encodeURIComponent(path)}`);
      return;
    }
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    const load = async () => {
      try {
        const calls = await Promise.all([
          fetch(API + "/users/me", { headers }), fetch(API + "/applications", { headers }),
          fetch(API + "/saved-jobs", { headers }), fetch(API + "/users/me/job-visits", { headers }),
        ]);
        if (calls.some((response) => response.status === 401)) throw new Error("Your session expired. Please sign in again.");
        if (calls[0].ok) { const loadedAccount = await calls[0].json() as Account; setAccount(loadedAccount); setOriginalAccount(loadedAccount); }
        if (calls[1].ok) setApplications(await calls[1].json());
        if (calls[2].ok) setSavedCount((await calls[2].json()).length);
        if (calls[3].ok) setVisits(await calls[3].json());
        const failed = calls.find((response) => !response.ok);
        if (failed) throw new Error(await responseError(failed));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load account data.");
        if (err instanceof Error && err.message.includes("expired")) {
          try { localStorage.removeItem("jobsync-token"); } catch { /* Storage may be unavailable. */ }
          setToken("");
          window.location.replace(`/login?next=${encodeURIComponent(path)}`);
        }
      }
    };
    void load();
  }, [path, token]);

  async function authSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const registering = path === "/register";
    if (registering && password !== confirm) { setError("Passwords do not match."); return; }
    if (password.length < 10) { setError("Use at least 10 characters for your password."); return; }
    setBusy(true);
    try {
      const response = await fetch(API + (registering ? "/auth/register" : "/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password }) });
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json();
      try { localStorage.setItem("jobsync-token", data.access_token); } catch { throw new Error("Browser storage is unavailable; sign-in cannot persist."); }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next?.startsWith("/") ? next : "/profile");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not sign in."); }
    finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!account) return; setBusy(true); setError("");
    try {
      const response = await fetch(API + "/users/me", { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: account.name, preferred_titles: account.preferred_titles, preferred_locations: account.preferred_locations, remote_preference: account.remote_preference, employment_types: account.employment_types, interests: account.interests }) });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = await response.json() as Account; setAccount(updated); setOriginalAccount(updated); setEditing(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save profile."); }
    finally { setBusy(false); }
  }

  async function updateApplication(row: Application, changes: { status?: string; notes?: string }) {
    const response = await fetch(API + `/applications/${encodeURIComponent(String(row.job.id))}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: changes.status ?? row.status, ...(changes.notes === undefined ? {} : { notes: changes.notes }) }) });
    if (!response.ok) { setError(await responseError(response)); return; }
    setApplications((rows) => rows.map((item) => item === row ? { ...item, ...changes } : item));
  }

  async function removeApplication(row: Application) {
    if (!window.confirm(`Remove tracking for ${row.job.title || "this job"}?`)) return;
    const response = await fetch(API + `/applications/${encodeURIComponent(String(row.job.id))}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) setApplications((rows) => rows.filter((item) => item !== row)); else setError(await responseError(response));
  }

  async function clearVisits(id?: string) {
    if (!window.confirm(id ? "Remove this visit from your activity?" : "Clear all of your visit history?")) return;
    const response = await fetch(API + (id ? `/users/me/job-visits/${encodeURIComponent(id)}` : "/users/me/job-visits"), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { setError(await responseError(response)); return; }
    setVisits((rows) => id ? rows.filter((row) => row.id !== id) : []);
  }

  function signOut() { void fetch(API + "/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }); try { localStorage.removeItem("jobsync-token"); } catch { /* Clear session in this tab regardless. */ } setToken(""); window.location.assign("/"); }

  const protectedPath = ["/profile", "/applications", "/activity", "/saved-jobs"].includes(path);
  const isAuth = path === "/login" || path === "/register";
  const visibleApplications = applications.filter((row) => filter === "All" || row.status === filter).sort((a, b) => (new Date(a.updated_at || 0).getTime() - new Date(b.updated_at || 0).getTime()) * (sortNewest ? -1 : 1));
  if (isAuth) return <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12"><section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9"><a href="/" className="text-sm font-semibold text-indigo-700">← JobSync AI</a><p className="mt-8 text-xs font-bold uppercase tracking-widest text-indigo-600">Your career workspace</p><h1 className="mt-2 text-3xl font-bold text-slate-900">{path === "/register" ? "Create your account" : "Welcome back"}</h1><p className="mt-2 text-sm text-slate-500">{path === "/register" ? "Save jobs, track applications, and keep your preferences." : "Sign in to continue to your JobSync workspace."}</p>
    <form onSubmit={authSubmit} className="mt-7 space-y-4">{path === "/register" && <label className="block text-sm font-medium text-slate-700">Full name<input required maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></label>}<label className="block text-sm font-medium text-slate-700">Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} /></label><label className="block text-sm font-medium text-slate-700">Password<input required minLength={10} type={showPassword ? "text" : "password"} autoComplete={path === "/register" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} /><button type="button" onClick={() => setShowPassword((show) => !show)} className="mt-2 text-xs font-semibold text-indigo-700">{showPassword ? "Hide password" : "Show password"}</button></label>{path === "/register" && <label className="block text-sm font-medium text-slate-700">Confirm password<input required minLength={10} type={showPassword ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} /></label>}{error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}<button disabled={busy} className="flex h-11 w-full items-center justify-center rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? "Please wait…" : path === "/register" ? "Create account" : "Sign in"}</button></form><p className="mt-6 text-center text-sm text-slate-600">{path === "/register" ? "Already have an account? " : "New to JobSync? "}<a className="font-semibold text-indigo-700 hover:underline" href={path === "/register" ? "/login" : "/register"}>{path === "/register" ? "Sign in" : "Create an account"}</a></p></section></main>;
  if (!protectedPath) return <main className="p-10 text-center"><a href="/">Return to JobSync AI</a></main>;
  if (!token) return <main className="p-10 text-center">Redirecting to sign in…</main>;
  const title = path === "/profile" ? "Profile" : path === "/applications" ? "Applications" : path === "/activity" ? "Recent activity" : "Saved jobs";
  return <div className="min-h-screen bg-slate-50 text-slate-900"><header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4"><a href="/" className="text-lg font-bold">JobSync <span className="text-indigo-600">AI</span></a><nav className="flex flex-wrap items-center gap-4 text-sm"><a href="/profile">Profile</a><a href="/applications">Applications</a><a href="/activity">Activity</a><a href="/saved-jobs">Saved jobs</a><button onClick={signOut} className="font-semibold text-indigo-700">Log out</button></nav></div></header><main className="mx-auto max-w-6xl px-5 py-10"><p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Your workspace</p><h1 className="mt-2 text-3xl font-bold">{title}</h1>{error && <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
  {path === "/profile" && account && <><div className="mt-7 grid gap-4 sm:grid-cols-3"><Metric label="Applications tracked" value={applications.length} /><Metric label="Saved jobs" value={savedCount} /><Metric label="Recently visited" value={visits.length} /></div><form onSubmit={saveProfile} className="mt-7 rounded-2xl border border-slate-200 bg-white p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Personal information & preferences</h2><button type="button" onClick={() => { if (editing && originalAccount) setAccount(originalAccount); setEditing((value) => !value); }} className="text-sm font-semibold text-indigo-700">{editing ? "Cancel edit" : "Edit profile"}</button></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Full name" value={account.name} disabled={!editing} onChange={(v) => setAccount({ ...account, name: v })} /><Field label="Email" value={account.email} disabled /><Field label="Preferred job titles (comma separated)" value={account.preferred_titles.join(", ")} disabled={!editing} onChange={(v) => setAccount({ ...account, preferred_titles: v.split(",").map((x) => x.trim()).filter(Boolean) })} /><Field label="Preferred locations (comma separated)" value={account.preferred_locations.join(", ")} disabled={!editing} onChange={(v) => setAccount({ ...account, preferred_locations: v.split(",").map((x) => x.trim()).filter(Boolean) })} /><Field label="Skills / areas of interest (comma separated)" value={account.interests.join(", ")} disabled={!editing} onChange={(v) => setAccount({ ...account, interests: v.split(",").map((x) => x.trim()).filter(Boolean) })} /><label className="text-sm font-medium">Remote work preference<select disabled={!editing} value={account.remote_preference} onChange={(e) => setAccount({ ...account, remote_preference: e.target.value })} className={inputClass}>{["any", "remote", "hybrid", "onsite"].map((x) => <option key={x} value={x}>{x}</option>)}</select></label><Field label="Employment types (comma separated)" value={account.employment_types.join(", ")} disabled={!editing} onChange={(v) => setAccount({ ...account, employment_types: v.split(",").map((x) => x.trim()).filter(Boolean) })} /></div><p className="mt-4 text-xs text-slate-500">Account created {account.created_at ? new Date(account.created_at).toLocaleDateString() : "date unavailable"}</p>{editing && <button disabled={busy} className="mt-5 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white">{busy ? "Saving…" : "Save changes"}</button>}</form></>}
  {path === "/applications" && <><div className="mt-6 flex flex-wrap items-center gap-3"><label className="text-sm">Status <select value={filter} onChange={(e) => setFilter(e.target.value)} className="ml-2 rounded-lg border border-slate-200 bg-white p-2">{["All", ...STATUSES].map((s) => <option key={s}>{s}</option>)}</select></label><button onClick={() => setSortNewest((v) => !v)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">Date: {sortNewest ? "newest first" : "oldest first"}</button></div><div className="mt-5 space-y-3">{visibleApplications.length ? visibleApplications.map((row) => <article key={String(row.job.id)} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-semibold">{row.job.title || "Job listing"}</h2><p className="mt-1 text-sm text-slate-500">{row.job.company}{row.job.location ? ` · ${row.job.location}` : ""}</p><p className="mt-2 text-xs text-slate-400">Tracked {row.created_at ? new Date(row.created_at).toLocaleDateString() : "date unavailable"} · Updated {row.updated_at ? new Date(row.updated_at).toLocaleString() : "date unavailable"}</p></div><select aria-label="Application status" value={row.status} onChange={(e) => void updateApplication(row, { status: e.target.value })} className="rounded-lg border border-slate-200 bg-white p-2 text-sm">{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></div><textarea aria-label="Application notes" defaultValue={row.notes || ""} onBlur={(e) => { if (e.target.value !== (row.notes || "")) void updateApplication(row, { notes: e.target.value }); }} placeholder="Add notes…" className="mt-4 min-h-20 w-full rounded-xl border border-slate-200 p-3 text-sm" /> <div className="mt-3 flex gap-4">{row.job.apply_url && <a target="_blank" rel="noreferrer" href={row.job.apply_url} className="text-sm font-semibold text-indigo-700">Open job listing</a>}<button onClick={() => void removeApplication(row)} className="text-sm font-semibold text-rose-700">Remove record</button></div></article>) : <Empty text="Tracked job records will appear here. Update a job's tracking status from your matches to add one." />}</div><p className="mt-5 text-xs text-slate-500">A Saved status records a shortlist item. Change it to Applied only after you submit an application.</p></>}
  {path === "/activity" && <><div className="mt-6 flex justify-end"><button disabled={!visits.length} onClick={() => void clearVisits()} className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50">Clear history</button></div><div className="mt-4 space-y-3">{visits.length ? visits.map((visit) => <article key={visit.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5"><div><h2 className="font-semibold">{visit.job.title || "Job listing"}</h2><p className="mt-1 text-sm text-slate-500">{visit.job.company}{visit.job.location ? ` · ${visit.job.location}` : ""}</p><p className="mt-2 text-xs text-slate-400">Visited {new Date(visit.visited_at).toLocaleString()}</p></div><div className="flex gap-4">{visit.job.apply_url && <a href={visit.job.apply_url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-indigo-700">Revisit</a>}<button onClick={() => void clearVisits(visit.id)} className="text-sm text-rose-700">Remove</button></div></article>) : <Empty text="Job detail views you open while signed in will appear here." />}</div></>}
  {path === "/saved-jobs" && <SavedJobs token={token} />}
  <a href="/" className="mt-8 inline-block text-sm font-semibold text-indigo-700">← Return to job search</a></main></div>;
}

function Field({ label, value, onChange, disabled = false }: { label: string; value: string; onChange?: (value: string) => void; disabled?: boolean }) { return <label className="text-sm font-medium">{label}<input value={value} disabled={disabled} onChange={(e) => onChange?.(e.target.value)} className={inputClass + " disabled:bg-slate-50 disabled:text-slate-500"} /></label>; }
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold">{value}</p></div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">{text}</p>; }
function SavedJobs({ token }: { token: string }) { const [rows, setRows] = useState<Array<{ job: Job }>>([]); const [error, setError] = useState(""); useEffect(() => { void fetch(API + "/saved-jobs", { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => { if (!r.ok) throw new Error(await responseError(r)); setRows(await r.json()); }).catch((e) => setError(e.message)); }, [token]); return <div className="mt-6 space-y-3">{error && <p role="alert">{error}</p>}{rows.length ? rows.map(({ job }) => <article key={String(job.id)} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">{job.title}</h2><p className="text-sm text-slate-500">{job.company} · {job.location}</p>{job.apply_url && <a href={job.apply_url} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-semibold text-indigo-700">Open listing</a>}</article>) : !error && <Empty text="Saved job postings will appear here." />}</div>; }
