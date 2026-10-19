import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertCircle,
  ArrowRight,
  Award,
  BookOpen,
  BrainCircuit,
  BriefcaseBusiness,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Filter,
  Lightbulb,
  Lock,
  Mail,
  MapPin,
  Moon,
  Plus,
  RotateCcw,
  Sparkles,
  Sun,
  Target,
  Trash2,
  TrendingUp,
  User,
  X,
  Zap,
} from "lucide-react";
import InterviewCoachSection from "./InterviewCoachSection";

const API = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const STATUSES = ["Saved", "Applied", "Interviewing", "Rejected", "Offered", "Withdrawn"];

type Job = {
  id: string | number;
  title?: string;
  company?: string;
  location?: string;
  apply_url?: string;
};

type Account = {
  id: string;
  name: string;
  email: string;
  created_at?: string;
  preferred_titles: string[];
  preferred_locations: string[];
  remote_preference: string;
  employment_types: string[];
  interests: string[];
};

type Application = {
  status: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
  job: Job;
};

type Visit = {
  id: string;
  visited_at: string;
  job: Job;
};

export type GrowthItem = {
  id: string;
  title: string;
  category: string;
  reflection: string;
  action_plan: string;
  status: "Identified" | "Practicing" | "Mastered";
  source: string;
  created_at?: string;
  updated_at?: string;
};

type Theme = "light" | "dark";

const GROWTH_CATEGORIES = [
  "Technical Skills",
  "System Design",
  "Behavioral & Soft Skills",
  "Resume & Portfolio",
  "Interview Mindset",
] as const;

const COMMON_BLINDSPOTS = [
  {
    title: "System Design: Microservices & Cache Invalidation",
    category: "System Design",
    reflection: "Struggled to explain Redis cache eviction policies and eventual consistency under heavy traffic.",
    action_plan: "Study Alex Xu Vol 1 System Design chapters 4 & 6. Implement a local caching demo with Redis.",
  },
  {
    title: "Behavioral: Explaining Conflict & Tough Feedback (STAR)",
    category: "Behavioral & Soft Skills",
    reflection: "Sounded defensive when asked about a project failure. Need structured STAR stories focused on resolution.",
    action_plan: "Draft 5 concrete STAR stories highlighting ownership, resolution, and what I changed afterwards.",
  },
  {
    title: "Live Coding: Dynamic Programming & Complexity Analysis",
    category: "Technical Skills",
    reflection: "Froze on bottom-up tabular DP and miscalculated space complexity with memoization.",
    action_plan: "Solve 10 classic 1D/2D DP problems on NeetCode and practice verbalizing thoughts before typing code.",
  },
  {
    title: "Resume: Quantifying Concrete Business Impact",
    category: "Resume & Portfolio",
    reflection: "Bullets were too task-oriented ('Wrote APIs in Python') rather than result-oriented ('Cut latency by 35%').",
    action_plan: "Rewrite all resume bullet points to follow: 'Accomplished [X] measured by [Y] by doing [Z]'.",
  },
  {
    title: "Interview Mindset: Pacing & Managing Anxiety Under Pressure",
    category: "Interview Mindset",
    reflection: "Rushed into coding without asking clarifying questions or validating edge cases first.",
    action_plan: "Set a strict 5-minute rule: Ask 3 clarifying questions, define inputs/outputs, and write test cases first.",
  },
];

const SUGGESTED_JOB_TITLES = [
  "Software Developer",
  "Software Engineer",
  "Frontend Developer",
  "Backend Developer",
  "Full Stack Developer",
  "Python Developer",
  "React Developer",
  "Node.js Developer",
  "Data Scientist",
  "Machine Learning Engineer",
  "AI Engineer",
  "DevOps Engineer",
  "Cloud Engineer",
  "Mobile App Developer",
  "Product Manager",
  "Data Analyst",
  "QA Automation Engineer",
  "System Architect",
  "Site Reliability Engineer (SRE)",
  "Cybersecurity Analyst",
];

const SUGGESTED_LOCATIONS = [
  "Delhi / NCR",
  "Bengaluru",
  "Hyderabad",
  "Pune",
  "Mumbai",
  "Noida",
  "Gurugram",
  "Chennai",
  "Kolkata",
  "Ahmedabad",
  "Remote (India)",
  "Remote (Global)",
  "San Francisco, CA",
  "New York, NY",
  "London, UK",
  "Singapore",
];

const SUGGESTED_SKILLS = [
  "Python",
  "JavaScript",
  "TypeScript",
  "React",
  "Node.js",
  "FastAPI",
  "Next.js",
  "SQL",
  "PostgreSQL",
  "MongoDB",
  "Docker",
  "Kubernetes",
  "AWS",
  "Git",
  "REST APIs",
  "Machine Learning",
  "Deep Learning",
  "NLP",
  "PyTorch",
  "TensorFlow",
  "Pandas",
  "Scikit-Learn",
  "Tailwind CSS",
  "HTML / CSS",
  "Java",
  "C++",
  "Go",
];

const COMMON_EMPLOYMENT_TYPES = [
  "Full-time",
  "Part-time",
  "Contract",
  "Internship",
  "Freelance",
];

const REMOTE_OPTIONS = [
  { value: "any", label: "Any (Remote, Hybrid, Onsite)" },
  { value: "remote", label: "Remote only" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On-site" },
];

function getToken() {
  try {
    return localStorage.getItem("jobsync-token") || "";
  } catch {
    return "";
  }
}

async function responseError(response: Response) {
  try {
    const data = await response.json();
    return data.detail || "Request failed.";
  } catch {
    return "Request failed. Check the backend connection.";
  }
}

const inputClass =
  "h-11 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 text-sm text-slate-900 dark:text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem("jobsync-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* Ignore */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function PortalPage() {
  const path = window.location.pathname;
  const isGrowthRoute = path === "/growth" || path === "/learnings" || path === "/weaknesses";
  const isCoachRoute = path === "/coach" || path === "/interview-coach" || path === "/debrief";

  const [token, setToken] = useState(getToken);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [originalAccount, setOriginalAccount] = useState<Account | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [growthItems, setGrowthItems] = useState<GrowthItem[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [filter, setFilter] = useState("All");
  const [sortNewest, setSortNewest] = useState(true);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("jobsync-theme", theme);
    } catch {
      /* Ignore */
    }
  }, [theme]);

  function toggleTheme() {
    setTheme((curr) => (curr === "dark" ? "light" : "dark"));
  }

  useEffect(() => {
    const protectedPaths = ["/profile", "/applications", "/activity", "/saved-jobs", "/growth", "/learnings", "/weaknesses", "/coach", "/interview-coach", "/debrief"];
    if (protectedPaths.includes(path) && !token) {
      window.location.replace(`/login?next=${encodeURIComponent(path)}`);
      return;
    }
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    const load = async () => {
      try {
        const calls = await Promise.all([
          fetch(API + "/users/me", { headers }),
          fetch(API + "/applications", { headers }),
          fetch(API + "/saved-jobs", { headers }),
          fetch(API + "/users/me/job-visits", { headers }),
          fetch(API + "/growth", { headers }).catch(() => null),
        ]);
        if (calls.some((response) => response && response.status === 401)) {
          throw new Error("Your session expired. Please sign in again.");
        }
        if (calls[0] && calls[0].ok) {
          const loadedAccount = (await calls[0].json()) as Account;
          setAccount(loadedAccount);
          setOriginalAccount(loadedAccount);
        }
        if (calls[1] && calls[1].ok) setApplications(await calls[1].json());
        if (calls[2] && calls[2].ok) setSavedCount((await calls[2].json()).length);
        if (calls[3] && calls[3].ok) setVisits(await calls[3].json());
        if (calls[4] && calls[4].ok) {
          const items = (await calls[4].json()) as GrowthItem[];
          setGrowthItems(items);
        }
        const failed = calls.find((response) => response && !response.ok && response !== calls[4]);
        if (failed) throw new Error(await responseError(failed));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load account data.");
        if (err instanceof Error && err.message.includes("expired")) {
          try {
            localStorage.removeItem("jobsync-token");
          } catch {
            /* Storage may be unavailable. */
          }
          setToken("");
          window.location.replace(`/login?next=${encodeURIComponent(path)}`);
        }
      }
    };
    void load();
  }, [path, token]);

  async function authSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const registering = path === "/register";
    if (registering && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 10) {
      setError("Use at least 10 characters for your password.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(API + (registering ? "/auth/register" : "/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json();
      try {
        localStorage.setItem("jobsync-token", data.access_token);
      } catch {
        throw new Error("Browser storage is unavailable; sign-in cannot persist.");
      }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next?.startsWith("/") ? next : "/profile");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    setBusy(true);
    setError("");
    setSaveSuccess(false);
    try {
      const response = await fetch(API + "/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: account.name.trim(),
          preferred_titles: account.preferred_titles,
          preferred_locations: account.preferred_locations,
          remote_preference: account.remote_preference,
          employment_types: account.employment_types,
          interests: account.interests,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = (await response.json()) as Account;
      setAccount(updated);
      setOriginalAccount(updated);
      setEditing(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile.");
    } finally {
      setBusy(false);
    }
  }

  async function updateApplication(row: Application, changes: { status?: string; notes?: string }) {
    const response = await fetch(API + `/applications/${encodeURIComponent(String(row.job.id))}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        status: changes.status ?? row.status,
        ...(changes.notes === undefined ? {} : { notes: changes.notes }),
      }),
    });
    if (!response.ok) {
      setError(await responseError(response));
      return;
    }
    setApplications((rows) => rows.map((item) => (item === row ? { ...item, ...changes } : item)));
  }

  async function removeApplication(row: Application) {
    if (!window.confirm(`Remove tracking for ${row.job.title || "this job"}?`)) return;
    const response = await fetch(API + `/applications/${encodeURIComponent(String(row.job.id))}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      setApplications((rows) => rows.filter((item) => item !== row));
    } else {
      setError(await responseError(response));
    }
  }

  async function clearVisits(id?: string) {
    if (!window.confirm(id ? "Remove this visit from your activity?" : "Clear all of your visit history?")) return;
    const response = await fetch(
      API + (id ? `/users/me/job-visits/${encodeURIComponent(id)}` : "/users/me/job-visits"),
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      setError(await responseError(response));
      return;
    }
    setVisits((rows) => (id ? rows.filter((row) => row.id !== id) : []));
  }

  // Growth / Weaknesses CRUD
  async function addGrowthItem(item: Omit<GrowthItem, "id" | "created_at" | "updated_at">) {
    try {
      const response = await fetch(API + "/growth", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(item),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const created = (await response.json()) as GrowthItem;
      setGrowthItems((prev) => [created, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create growth item.");
    }
  }

  async function updateGrowthItem(id: string, updates: Partial<GrowthItem>) {
    try {
      const response = await fetch(API + `/growth/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(updates),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = (await response.json()) as GrowthItem;
      setGrowthItems((prev) => prev.map((item) => (item.id === id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update growth item.");
    }
  }

  async function deleteGrowthItem(id: string) {
    try {
      const response = await fetch(API + `/growth/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(await responseError(response));
      setGrowthItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete growth item.");
    }
  }

  function signOut() {
    void fetch(API + "/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    try {
      localStorage.removeItem("jobsync-token");
    } catch {
      /* Clear session in this tab regardless. */
    }
    setToken("");
    window.location.assign("/");
  }

  const protectedPath = [
    "/profile",
    "/applications",
    "/activity",
    "/saved-jobs",
    "/growth",
    "/learnings",
    "/weaknesses",
    "/coach",
    "/interview-coach",
    "/debrief",
  ].includes(path);
  const isAuth = path === "/login" || path === "/register";
  const visibleApplications = applications
    .filter((row) => filter === "All" || row.status === filter)
    .sort(
      (a, b) =>
        (new Date(a.updated_at || 0).getTime() - new Date(b.updated_at || 0).getTime()) *
        (sortNewest ? -1 : 1)
    );

  if (isAuth) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950 px-4 py-12">
        <section className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-7 shadow-sm sm:p-9">
          <div className="flex items-center justify-between">
            <a href="/" className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
              ← JobSync AI
            </a>
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              title="Toggle theme"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
          <p className="mt-8 text-xs font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
            Your career workspace
          </p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900 dark:text-white">
            {path === "/register" ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {path === "/register"
              ? "Save jobs, track applications, and turn rejections into career growth."
              : "Sign in to continue to your JobSync workspace."}
          </p>
          <form onSubmit={authSubmit} className="mt-7 space-y-4">
            {path === "/register" && (
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                Full name
                <input
                  required
                  maxLength={100}
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                />
              </label>
            )}
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              Email
              <input
                required
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              Password
              <input
                required
                minLength={10}
                type={showPassword ? "text" : "password"}
                autoComplete={path === "/register" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => setShowPassword((show) => !show)}
                className="mt-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400"
              >
                {showPassword ? "Hide password" : "Show password"}
              </button>
            </label>
            {path === "/register" && (
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                Confirm password
                <input
                  required
                  minLength={10}
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={inputClass}
                />
              </label>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-xl bg-rose-50 dark:bg-rose-950/50 p-3 text-sm text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-900/50"
              >
                {error}
              </p>
            )}
            <button
              disabled={busy}
              className="flex h-11 w-full items-center justify-center rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 transition"
            >
              {busy ? "Please wait…" : path === "/register" ? "Create account" : "Sign in"}
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
            {path === "/register" ? "Already have an account? " : "New to JobSync? "}
            <a
              className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
              href={path === "/register" ? "/login" : "/register"}
            >
              {path === "/register" ? "Sign in" : "Create an account"}
            </a>
          </p>
        </section>
      </main>
    );
  }

  if (!protectedPath) return <main className="p-10 text-center"><a href="/">Return to JobSync AI</a></main>;
  if (!token) return <main className="p-10 text-center">Redirecting to sign in…</main>;

  const title =
    path === "/profile"
      ? "Profile"
      : path === "/applications"
      ? "Applications"
      : isGrowthRoute
      ? "Weaknesses & Learning Journey"
      : isCoachRoute
      ? "AI Interview Coach & Debrief Room"
      : path === "/activity"
      ? "Recent activity"
      : "Saved jobs";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <a href="/" className="text-lg font-bold">
            JobSync <span className="text-indigo-600 dark:text-indigo-400">AI</span>
          </a>
          <nav className="flex flex-wrap items-center gap-5 text-sm font-medium">
            <a
              href="/profile"
              className={
                path === "/profile"
                  ? "text-indigo-600 dark:text-indigo-400 font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }
            >
              Profile
            </a>
            <a
              href="/applications"
              className={
                path === "/applications"
                  ? "text-indigo-600 dark:text-indigo-400 font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }
            >
              Applications
            </a>
            <a
              href="/growth"
              className={`inline-flex items-center gap-1.5 ${
                isGrowthRoute
                  ? "text-indigo-600 dark:text-indigo-400 font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              <BrainCircuit className="w-4 h-4 text-indigo-500" />
              <span>Weaknesses & Growth</span>
              {growthItems.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">
                  {growthItems.length}
                </span>
              )}
            </a>
            <a
              href="/coach"
              className={`inline-flex items-center gap-1.5 ${
                isCoachRoute
                  ? "text-indigo-600 dark:text-indigo-400 font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              <Sparkles className="w-4 h-4 text-purple-500" />
              <span>Interview Coach</span>
            </a>
            <a
              href="/activity"
              className={
                path === "/activity"
                  ? "text-indigo-600 dark:text-indigo-400 font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }
            >
              Activity
            </a>
            <a
              href="/saved-jobs"
              className={
                path === "/saved-jobs"
                  ? "text-indigo-600 dark:text-indigo-400 font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }
            >
              Saved jobs
            </a>
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              title="Toggle theme"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button onClick={signOut} className="font-semibold text-rose-600 hover:text-rose-700 dark:text-rose-400">
              Log out
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-10">
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
          Your workspace
        </p>
        <h1 className="mt-2 text-3xl font-bold">{title}</h1>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-xl bg-rose-50 dark:bg-rose-950/50 p-3 text-sm text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-900/50"
          >
            {error}
          </p>
        )}

        {saveSuccess && (
          <div className="mt-5 flex items-center gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 p-3.5 text-sm text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>Profile and preferences updated successfully!</span>
          </div>
        )}

        {/* Profile Tab */}
        {path === "/profile" && account && (
          <>
            <div className="mt-7 grid gap-4 sm:grid-cols-4">
              <a href="/applications" className="block text-inherit no-underline transition hover:-translate-y-0.5">
                <Metric label="Applications tracked" value={applications.length} />
              </a>
              <a href="/growth" className="block text-inherit no-underline transition hover:-translate-y-0.5">
                <Metric label="Weaknesses & Learnings" value={growthItems.length} />
              </a>
              <a href="/saved-jobs" className="block text-inherit no-underline transition hover:-translate-y-0.5">
                <Metric label="Saved jobs" value={savedCount} />
              </a>
              <a href="/activity" className="block text-inherit no-underline transition hover:-translate-y-0.5">
                <Metric label="Recently visited" value={visits.length} />
              </a>
            </div>

            {/* Weakness & Growth Snapshot on Profile Tab */}
            <div className="mt-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-7 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400">
                    <BrainCircuit className="w-5 h-5" />
                  </span>
                  <div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Weaknesses & Growth Tracker</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Capture interview blindspots, log rejection lessons, and track skill mastery
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href="/growth"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition"
                  >
                    <span>Open Full Tracker</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              {growthItems.length > 0 ? (
                <div className="mt-5 space-y-4">
                  <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3.5 text-center">
                      <p className="text-xs text-slate-500 dark:text-slate-400">Total Logged</p>
                      <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{growthItems.length}</p>
                    </div>
                    <div className="rounded-xl bg-amber-50/80 dark:bg-amber-950/30 p-3.5 text-center border border-amber-100 dark:border-amber-900/40">
                      <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">Identified</p>
                      <p className="mt-1 text-2xl font-bold text-amber-800 dark:text-amber-300">
                        {growthItems.filter((i) => i.status === "Identified").length}
                      </p>
                    </div>
                    <div className="rounded-xl bg-indigo-50/80 dark:bg-indigo-950/30 p-3.5 text-center border border-indigo-100 dark:border-indigo-900/40">
                      <p className="text-xs text-indigo-700 dark:text-indigo-400 font-medium">Practicing</p>
                      <p className="mt-1 text-2xl font-bold text-indigo-800 dark:text-indigo-300">
                        {growthItems.filter((i) => i.status === "Practicing").length}
                      </p>
                    </div>
                    <div className="rounded-xl bg-emerald-50/80 dark:bg-emerald-950/30 p-3.5 text-center border border-emerald-100 dark:border-emerald-900/40">
                      <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">Mastered</p>
                      <p className="mt-1 text-2xl font-bold text-emerald-800 dark:text-emerald-300">
                        {growthItems.filter((i) => i.status === "Mastered").length}
                      </p>
                    </div>
                  </div>

                  <div className="pt-2">
                    <div className="flex items-center justify-between mb-2.5">
                      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                        Recent Focus Areas
                      </p>
                      <a href="/growth" className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                        View all records →
                      </a>
                    </div>
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {growthItems.slice(0, 4).map((item) => (
                        <a
                          key={item.id}
                          href="/growth"
                          className="flex items-center justify-between p-3.5 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 hover:border-indigo-200 dark:hover:border-indigo-700 transition text-inherit no-underline"
                        >
                          <div className="min-w-0 pr-3">
                            <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{item.title}</p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{item.category}</p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                              item.status === "Mastered"
                                ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                                : item.status === "Practicing"
                                ? "bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
                                : "bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300"
                            }`}
                          >
                            {item.status}
                          </span>
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-6 text-center">
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">No weaknesses or learnings recorded yet</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
                    Track questions you missed, skills you need to brush up on, or feedback from recent interviews to turn them into strengths.
                  </p>
                  <a
                    href="/growth"
                    className="mt-3.5 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 text-xs font-semibold hover:bg-indigo-100 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Log First Learning or Blindspot</span>
                  </a>
                </div>
              )}
            </div>

            <form
              onSubmit={saveProfile}
              className="mt-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 pb-5 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                    Personal information & preferences
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Configure your target roles, locations, skills, and work preferences
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (editing && originalAccount) setAccount(originalAccount);
                    setEditing((value) => !value);
                  }}
                  className={`px-4 py-2 text-sm font-semibold rounded-xl border transition ${
                    editing
                      ? "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                      : "border-indigo-200 dark:border-indigo-800/80 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60"
                  }`}
                >
                  {editing ? "Cancel edit" : "Edit profile"}
                </button>
              </div>

              <div className="mt-6 space-y-6">
                {/* Full name & Email */}
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                    <span className="flex items-center gap-1.5 mb-1.5">
                      <User className="w-4 h-4 text-slate-400" />
                      Full name
                    </span>
                    <input
                      required
                      value={account.name}
                      disabled={!editing}
                      onChange={(e) => setAccount({ ...account, name: e.target.value })}
                      placeholder="Your full name"
                      className={`${inputClass} disabled:bg-slate-50 dark:disabled:bg-slate-800/50 disabled:text-slate-500 dark:disabled:text-slate-400 disabled:cursor-not-allowed`}
                    />
                  </label>

                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                    <span className="flex items-center gap-1.5 mb-1.5">
                      <Mail className="w-4 h-4 text-slate-400" />
                      Email address
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-400 font-normal">
                        <Lock className="w-3 h-3" /> Read-only
                      </span>
                    </span>
                    <input
                      value={account.email}
                      disabled
                      className={`${inputClass} bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 cursor-not-allowed`}
                    />
                  </label>
                </div>

                {/* Preferred job titles */}
                <TagInput
                  label="Preferred job titles"
                  helperText="Enter target job titles or choose from recommended suggestions"
                  icon={<BriefcaseBusiness className="w-4 h-4 text-slate-400" />}
                  placeholder="Type a title (e.g. Software Developer) and press Enter…"
                  tags={account.preferred_titles}
                  disabled={!editing}
                  suggestions={SUGGESTED_JOB_TITLES}
                  onChange={(titles) => setAccount({ ...account, preferred_titles: titles })}
                />

                {/* Preferred locations */}
                <TagInput
                  label="Preferred locations"
                  helperText="Cities or regions you want to see job opportunities for"
                  icon={<MapPin className="w-4 h-4 text-slate-400" />}
                  placeholder="Type a city or region (e.g. Delhi, Bengaluru, Remote)…"
                  tags={account.preferred_locations}
                  disabled={!editing}
                  suggestions={SUGGESTED_LOCATIONS}
                  onChange={(locations) => setAccount({ ...account, preferred_locations: locations })}
                />

                {/* Skills & areas of interest */}
                <TagInput
                  label="Skills / areas of interest"
                  helperText="Used to match job descriptions against your expertise"
                  icon={<Sparkles className="w-4 h-4 text-slate-400" />}
                  placeholder="Type a skill (e.g. Python, React, Docker) and press Enter…"
                  tags={account.interests}
                  disabled={!editing}
                  suggestions={SUGGESTED_SKILLS}
                  onChange={(interests) => setAccount({ ...account, interests })}
                />

                {/* Remote Preference & Employment Types */}
                <div className="grid gap-6 sm:grid-cols-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                      Remote work preference
                    </label>
                    {editing ? (
                      <div className="grid grid-cols-2 gap-2">
                        {REMOTE_OPTIONS.map((opt) => {
                          const isSelected = account.remote_preference === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => setAccount({ ...account, remote_preference: opt.value })}
                              className={`flex items-center justify-between p-2.5 rounded-xl border text-xs font-medium text-left transition ${
                                isSelected
                                  ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 ring-2 ring-indigo-500/20"
                                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800"
                              }`}
                            >
                              <span>{opt.label}</span>
                              {isSelected && (
                                <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0 ml-1" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mt-1">
                        <span className="inline-flex items-center px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/60">
                          {REMOTE_OPTIONS.find((o) => o.value === account.remote_preference)?.label ||
                            account.remote_preference}
                        </span>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                      Employment types
                    </label>
                    <EmploymentTypesSelector
                      selected={account.employment_types}
                      disabled={!editing}
                      onChange={(types) => setAccount({ ...account, employment_types: types })}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-8 pt-5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                <p className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Calendar className="w-3.5 h-3.5" />
                  Account created{" "}
                  {account.created_at ? new Date(account.created_at).toLocaleDateString() : "date unavailable"}
                </p>

                {editing && (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (originalAccount) setAccount(originalAccount);
                        setEditing(false);
                      }}
                      className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 shadow-sm disabled:opacity-60 transition"
                    >
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                  </div>
                )}
              </div>
            </form>
          </>
        )}

        {/* Weaknesses & Growth Tab */}
        {isGrowthRoute && (
          <WeaknessGrowthSection
            items={growthItems}
            applications={applications}
            onAdd={addGrowthItem}
            onUpdate={updateGrowthItem}
            onDelete={deleteGrowthItem}
          />
        )}

        {/* AI Interview Coach & Debrief Room */}
        {isCoachRoute && (
          <InterviewCoachSection
            token={token}
            onGrowthSaved={(newItem) => setGrowthItems((prev) => [newItem, ...prev])}
            initialCompany={new URLSearchParams(window.location.search).get("company") || ""}
            initialRole={new URLSearchParams(window.location.search).get("role") || ""}
          />
        )}

        {/* Applications Tab */}
        {path === "/applications" && (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <label className="text-sm">
                Status{" "}
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="ml-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 text-sm"
                >
                  {["All", ...STATUSES].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => setSortNewest((v) => !v)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
              >
                Date: {sortNewest ? "newest first" : "oldest first"}
              </button>
            </div>
            <div className="mt-5 space-y-3">
              {visibleApplications.length ? (
                visibleApplications.map((row) => (
                  <article
                    key={String(row.job.id)}
                    className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold text-slate-900 dark:text-white">
                            {row.job.title || "Job listing"}
                          </h2>
                          {row.status === "Rejected" && (
                            <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900">
                              Opportunity to Learn
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                          {row.job.company}
                          {row.job.location ? ` · ${row.job.location}` : ""}
                        </p>
                        <p className="mt-2 text-xs text-slate-400">
                          Tracked{" "}
                          {row.created_at ? new Date(row.created_at).toLocaleDateString() : "date unavailable"} ·
                          Updated{" "}
                          {row.updated_at ? new Date(row.updated_at).toLocaleString() : "date unavailable"}
                        </p>
                      </div>
                      <select
                        aria-label="Application status"
                        value={row.status}
                        onChange={(e) => void updateApplication(row, { status: e.target.value })}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 text-sm"
                      >
                        {STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      aria-label="Application notes"
                      defaultValue={row.notes || ""}
                      onBlur={(e) => {
                        if (e.target.value !== (row.notes || "")) {
                          void updateApplication(row, { notes: e.target.value });
                        }
                      }}
                      placeholder="Add notes, interview feedback, questions asked…"
                      className="mt-4 min-h-20 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 p-3 text-sm outline-none focus:border-indigo-500"
                    />
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 pt-2">
                      <div className="flex gap-4">
                        {row.job.apply_url && (
                          <a
                            target="_blank"
                            rel="noreferrer"
                            href={row.job.apply_url}
                            className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                          >
                            Open job listing
                          </a>
                        )}
                        <button
                          onClick={() => void removeApplication(row)}
                          className="text-sm font-semibold text-rose-600 hover:text-rose-700 dark:text-rose-400"
                        >
                          Remove record
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <a
                          href={`/coach?company=${encodeURIComponent(row.job.company || "")}&role=${encodeURIComponent(row.job.title || "")}`}
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-purple-600 dark:text-purple-400 hover:underline"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          Debrief with AI Coach →
                        </a>
                        <a
                          href={`/growth?source=${encodeURIComponent(`${row.job.company || "Company"} - ${row.job.title || "Job"}`)}`}
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          <BrainCircuit className="w-3.5 h-3.5" />
                          Log learning →
                        </a>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <Empty text="Tracked job records will appear here. Update a job's tracking status from your matches to add one." />
              )}
            </div>
            <p className="mt-5 text-xs text-slate-500">
              A Saved status records a shortlist item. Change it to Applied only after you submit an application.
            </p>
          </>
        )}

        {/* Activity Tab */}
        {path === "/activity" && (
          <>
            <div className="mt-6 flex justify-end">
              <button
                disabled={!visits.length}
                onClick={() => void clearVisits()}
                className="rounded-lg border border-rose-200 dark:border-rose-900/60 px-3 py-2 text-sm font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
              >
                Clear history
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {visits.length ? (
                visits.map((visit) => (
                  <article
                    key={visit.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
                  >
                    <div>
                      <h2 className="font-semibold text-slate-900 dark:text-white">
                        {visit.job.title || "Job listing"}
                      </h2>
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        {visit.job.company}
                        {visit.job.location ? ` · ${visit.job.location}` : ""}
                      </p>
                      <p className="mt-2 text-xs text-slate-400">
                        Visited {new Date(visit.visited_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex gap-4">
                      {visit.job.apply_url && (
                        <a
                          href={visit.job.apply_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          Revisit
                        </a>
                      )}
                      <button
                        onClick={() => void clearVisits(visit.id)}
                        className="text-sm text-rose-600 hover:text-rose-700 dark:text-rose-400"
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <Empty text="Job detail views you open while signed in will appear here." />
              )}
            </div>
          </>
        )}

        {/* Saved Jobs Tab */}
        {path === "/saved-jobs" && <SavedJobs token={token} />}

        <a
          href="/"
          className="mt-8 inline-block text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          ← Return to job search
        </a>
      </main>

      {/* Floating Action Button for Interview Coach (if not already on /coach) */}
      {!isCoachRoute && (
        <a
          href="/coach"
          className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-3 text-xs font-bold text-white shadow-xl shadow-indigo-600/30 hover:scale-105 transition-all border border-white/20 backdrop-blur-sm"
          title="Talk to AI Interview Coach"
        >
          <Sparkles className="w-4 h-4 text-amber-300 animate-pulse" />
          <span>AI Interview Coach</span>
        </a>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Weakness & Growth Section Component
// -----------------------------------------------------------------------------

function WeaknessGrowthSection({
  items,
  applications,
  onAdd,
  onUpdate,
  onDelete,
}: {
  items: GrowthItem[];
  applications: Application[];
  onAdd: (item: Omit<GrowthItem, "id">) => Promise<void>;
  onUpdate: (id: string, updates: Partial<GrowthItem>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [showAddForm, setShowAddForm] = useState(() => {
    if (typeof window !== "undefined") {
      return Boolean(new URLSearchParams(window.location.search).get("source"));
    }
    return false;
  });
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  // Form inputs state
  const [formTitle, setFormTitle] = useState("");
  const [formCategory, setFormCategory] = useState<string>("Technical Skills");
  const [formSource, setFormSource] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("source") || "";
    }
    return "";
  });
  const [formReflection, setFormReflection] = useState("");
  const [formActionPlan, setFormActionPlan] = useState("");
  const [formStatus, setFormStatus] = useState<GrowthItem["status"]>("Identified");
  const [submitting, setSubmitting] = useState(false);

  // Growth metrics calculations
  const stats = useMemo(() => {
    const total = items.length;
    const identified = items.filter((i) => i.status === "Identified").length;
    const practicing = items.filter((i) => i.status === "Practicing").length;
    const mastered = items.filter((i) => i.status === "Mastered").length;
    const masteryRate = total > 0 ? Math.round((mastered / total) * 100) : 0;
    return { total, identified, practicing, mastered, masteryRate };
  }, [items]);

  // Rejected / Interviewing applications that can inspire reflections
  const actionableApplications = useMemo(() => {
    return applications.filter(
      (a) => a.status === "Rejected" || a.status === "Interviewing"
    );
  }, [applications]);

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchCat = filterCategory === "All" || item.category === filterCategory;
      const matchStat = filterStatus === "All" || item.status === filterStatus;
      return matchCat && matchStat;
    });
  }, [items, filterCategory, filterStatus]);

  function handleQuickBlindspot(spot: (typeof COMMON_BLINDSPOTS)[number]) {
    setFormTitle(spot.title);
    setFormCategory(spot.category);
    setFormReflection(spot.reflection);
    setFormActionPlan(spot.action_plan);
    setFormSource("Self Assessment & Blindspot Review");
    setFormStatus("Practicing");
    setShowAddForm(true);
  }

  function handlePrefillFromApp(app: Application) {
    const company = app.job.company || "Company";
    const role = app.job.title || "Role";
    setFormSource(`${company} (${role})`);
    setFormTitle(`Interview Learning: ${company}`);
    setFormReflection(app.notes ? `Feedback notes from interview: ${app.notes}` : "");
    setFormCategory("Technical Skills");
    setFormStatus("Identified");
    setShowAddForm(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!formTitle.trim()) return;
    setSubmitting(true);
    try {
      if (editingItemId) {
        await onUpdate(editingItemId, {
          title: formTitle.trim(),
          category: formCategory,
          source: formSource.trim(),
          reflection: formReflection.trim(),
          action_plan: formActionPlan.trim(),
          status: formStatus,
        });
        setEditingItemId(null);
      } else {
        await onAdd({
          title: formTitle.trim(),
          category: formCategory,
          source: formSource.trim(),
          reflection: formReflection.trim(),
          action_plan: formActionPlan.trim(),
          status: formStatus,
        });
      }
      // Reset form
      setFormTitle("");
      setFormCategory("Technical Skills");
      setFormSource("");
      setFormReflection("");
      setFormActionPlan("");
      setFormStatus("Identified");
      setShowAddForm(false);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(item: GrowthItem) {
    setEditingItemId(item.id);
    setFormTitle(item.title);
    setFormCategory(item.category);
    setFormSource(item.source);
    setFormReflection(item.reflection);
    setFormActionPlan(item.action_plan);
    setFormStatus(item.status);
    setShowAddForm(true);
  }

  function cycleStatus(item: GrowthItem) {
    const nextStatus: GrowthItem["status"] =
      item.status === "Identified"
        ? "Practicing"
        : item.status === "Practicing"
        ? "Mastered"
        : "Identified";
    void onUpdate(item.id, { status: nextStatus });
  }

  return (
    <div className="space-y-8 mt-7">
      {/* Inspirational Hero Card */}
      <section className="relative overflow-hidden rounded-3xl border border-indigo-100 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/80 via-white to-violet-50/50 dark:from-indigo-950/40 dark:via-slate-900 dark:to-slate-900 p-6 sm:p-8 shadow-xs">
        <div className="relative z-10 max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-indigo-100/80 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 mb-3">
            <Zap className="w-3.5 h-3.5" />
            The Growth Mindset Engine
          </div>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            Turn Every Rejection into an Unfair Advantage
          </h2>
          <p className="mt-2.5 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
            The strongest candidates fail dozens of interviews before getting hired. What sets them apart is
            what they do with what went wrong. Document what tripped you up, build a clear action plan, and
            track your weaknesses until they become your greatest strengths.
          </p>

          <blockquote className="mt-4 pl-3.5 border-l-2 border-indigo-500 text-xs text-slate-500 dark:text-slate-400 italic">
            &ldquo;I have not failed 1,000 times. I have successfully discovered 1,000 ways that didn&apos;t work.&rdquo;
            <span className="block font-medium not-italic text-slate-700 dark:text-slate-300 mt-0.5">
              — Thomas Edison
            </span>
          </blockquote>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <a
              href="/coach"
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:from-violet-700 hover:to-indigo-700 transition"
            >
              <Sparkles className="w-4 h-4 text-amber-300" />
              <span>Just had an interview? Debrief with AI Coach →</span>
            </a>
          </div>
        </div>
      </section>

      {/* Metrics Grid */}
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Total Logged
            </span>
            <BookOpen className="w-4 h-4 text-indigo-500" />
          </div>
          <p className="mt-2 text-3xl font-bold text-slate-900 dark:text-white">{stats.total}</p>
          <p className="text-xs text-slate-400 mt-1">Gaps identified & logged</p>
        </div>

        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900/40 bg-white dark:bg-slate-900 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
              In Training
            </span>
            <RotateCcw className="w-4 h-4 text-amber-500 animate-spin-slow" />
          </div>
          <p className="mt-2 text-3xl font-bold text-amber-600 dark:text-amber-400">{stats.practicing}</p>
          <p className="text-xs text-slate-400 mt-1">Actively practicing now</p>
        </div>

        <div className="rounded-2xl border border-emerald-200/70 dark:border-emerald-900/40 bg-white dark:bg-slate-900 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Mastered
            </span>
            <Award className="w-4 h-4 text-emerald-500" />
          </div>
          <p className="mt-2 text-3xl font-bold text-emerald-600 dark:text-emerald-400">{stats.mastered}</p>
          <p className="text-xs text-slate-400 mt-1">Turned into strengths</p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Mastery Rate
            </span>
            <TrendingUp className="w-4 h-4 text-indigo-500" />
          </div>
          <p className="mt-2 text-3xl font-bold text-indigo-600 dark:text-indigo-400">{stats.masteryRate}%</p>
          <p className="text-xs text-slate-400 mt-1">Weaknesses resolved</p>
        </div>
      </div>

      {/* Rejection / Interview Reflection Prompts */}
      {actionableApplications.length > 0 && (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Log Learnings from Your Tracked Applications
            </h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
            Did an interview challenge you or result in a rejection? Click a company below to quickly document
            what you learned:
          </p>
          <div className="flex flex-wrap gap-2">
            {actionableApplications.slice(0, 4).map((app) => (
              <button
                key={String(app.job.id)}
                type="button"
                onClick={() => handlePrefillFromApp(app)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition"
              >
                <Plus className="w-3 h-3 text-indigo-500" />
                {app.job.company || "Company"} ({app.status})
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Common Blindspots Quick-Add Chips */}
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-indigo-500" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Common Interview Blindspots to Self-Audit
            </h3>
          </div>
          <span className="text-xs text-slate-400">Click to import template</span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Candidates frequently report stumbling on these topics. Click any prompt to adapt it to your own
          plan:
        </p>
        <div className="flex flex-wrap gap-2">
          {COMMON_BLINDSPOTS.map((spot) => (
            <button
              key={spot.title}
              type="button"
              onClick={() => handleQuickBlindspot(spot)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/80 dark:bg-slate-800/60 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-indigo-300 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 transition text-left"
            >
              <Plus className="w-3 h-3 text-indigo-500 shrink-0" />
              <span>{spot.title}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Main Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 mr-1">
            <Filter className="w-3.5 h-3.5" />
            Filter:
          </div>
          {/* Status filter */}
          <div className="flex rounded-xl border border-slate-200 dark:border-slate-800 p-0.5 bg-white dark:bg-slate-900 text-xs">
            {["All", "Practicing", "Identified", "Mastered"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilterStatus(s)}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  filterStatus === s
                    ? "bg-indigo-600 text-white font-semibold shadow-xs"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Category filter dropdown */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="h-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 text-xs font-medium text-slate-700 dark:text-slate-300 outline-none"
          >
            <option value="All">All Categories</option>
            {GROWTH_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => {
            if (showAddForm && editingItemId) {
              setEditingItemId(null);
            }
            setShowAddForm((prev) => !prev);
          }}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition"
        >
          {showAddForm ? (
            <>
              <X className="w-3.5 h-3.5" />
              Close Form
            </>
          ) : (
            <>
              <Plus className="w-3.5 h-3.5" />
              Log New Learning / Weakness
            </>
          )}
        </button>
      </div>

      {/* Add / Edit Form Modal or Card */}
      {showAddForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-3xl border border-indigo-200 dark:border-indigo-800/80 bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-md space-y-5 animate-in fade-in"
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                {editingItemId ? "Edit Learning Record" : "Log a Weakness, Blindspot, or Rejection Lesson"}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Be radically honest with yourself. This is your private growth playground.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setEditingItemId(null);
              }}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Weakness / Gap Title *
              <input
                required
                maxLength={150}
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="e.g. System Design: Redis Caching & Partitioning"
                className={`${inputClass} mt-1`}
              />
            </label>

            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Category
              <select
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
                className={`${inputClass} mt-1`}
              >
                {GROWTH_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Where was this discovered? (Source)
              <input
                maxLength={150}
                value={formSource}
                onChange={(e) => setFormSource(e.target.value)}
                placeholder="e.g. Google Round 2, Mock Interview, Self Assessment"
                className={`${inputClass} mt-1`}
              />
            </label>

            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Current Progress Status
              <div className="grid grid-cols-3 gap-2 mt-1">
                {(["Identified", "Practicing", "Mastered"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setFormStatus(st)}
                    className={`py-2 rounded-xl text-xs font-semibold border transition ${
                      formStatus === st
                        ? st === "Mastered"
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : st === "Practicing"
                          ? "bg-indigo-600 text-white border-indigo-600"
                          : "bg-amber-600 text-white border-amber-600"
                        : "border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800"
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </label>
          </div>

          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            What went wrong? / What did you learn? (The Honest Reflection)
            <textarea
              rows={3}
              maxLength={2000}
              value={formReflection}
              onChange={(e) => setFormReflection(e.target.value)}
              placeholder="e.g. When asked about handling database failovers, I couldn't explain replica promotion and split-brain scenarios clearly. Realized I need to study real-world high availability setups."
              className="mt-1 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-xs text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Action Plan: What will you do to fix it?
            <textarea
              rows={3}
              maxLength={2000}
              value={formActionPlan}
              onChange={(e) => setFormActionPlan(e.target.value)}
              placeholder="e.g. 1. Read Chapter 5 of Designing Data-Intensive Applications. 2. Build a Postgres primary-replica Docker compose lab. 3. Practice explaining it to a peer."
              className="mt-1 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-xs text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500"
            />
          </label>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setEditingItemId(null);
              }}
              className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm disabled:opacity-60 transition"
            >
              {submitting ? "Saving…" : editingItemId ? "Update Learning" : "Save to Growth Journal"}
            </button>
          </div>
        </form>
      )}

      {/* Items List */}
      <div className="space-y-4">
        {filteredItems.length > 0 ? (
          filteredItems.map((item) => (
            <article
              key={item.id}
              className="group rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs hover:shadow-md transition"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1.5 flex-1 min-w-[280px]">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Category pill */}
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-bold bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/80">
                      {item.category}
                    </span>

                    {/* Source badge */}
                    {item.source && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-[11px] font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800">
                        <MapPin className="w-2.5 h-2.5" />
                        {item.source}
                      </span>
                    )}

                    {/* Formatted Date */}
                    {item.created_at && (
                      <span className="text-[11px] text-slate-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(item.created_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  <h3 className="text-lg font-bold text-slate-900 dark:text-white pt-1">
                    {item.title}
                  </h3>
                </div>

                {/* Status Badge with Click-to-Cycle */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => cycleStatus(item)}
                    title="Click to cycle status (Identified → Practicing → Mastered)"
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border transition cursor-pointer shadow-2xs ${
                      item.status === "Mastered"
                        ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
                        : item.status === "Practicing"
                        ? "bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800"
                        : "bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800"
                    }`}
                  >
                    {item.status === "Mastered" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : item.status === "Practicing" ? (
                      <RotateCcw className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                    )}
                    <span>{item.status}</span>
                    <span className="text-[10px] opacity-60">↻</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => startEdit(item)}
                    className="p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
                    title="Edit"
                  >
                    <BookOpen className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete growth record "${item.title}"?`)) {
                        void onDelete(item.id);
                      }
                    }}
                    className="p-1.5 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Reflection and Action Plan */}
              <div className="grid gap-4 sm:grid-cols-2 mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 text-xs">
                {item.reflection && (
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-3.5 border border-slate-100 dark:border-slate-800">
                    <p className="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5 mb-1">
                      <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
                      What went wrong / The Takeaway:
                    </p>
                    <p className="text-slate-600 dark:text-slate-400 leading-relaxed italic">
                      &ldquo;{item.reflection}&rdquo;
                    </p>
                  </div>
                )}

                {item.action_plan && (
                  <div className="rounded-xl bg-indigo-50/40 dark:bg-indigo-950/30 p-3.5 border border-indigo-100/60 dark:border-indigo-900/40">
                    <p className="font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5 mb-1">
                      <Target className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                      Action Plan / Next Steps:
                    </p>
                    <p className="text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-line">
                      {item.action_plan}
                    </p>
                  </div>
                )}
              </div>
            </article>
          ))
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
              <BrainCircuit className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                No Weaknesses or Learnings Recorded Yet
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto mt-1">
                Every interview that didn&apos;t convert or job skill you don&apos;t know is a stepping stone.
                Start by logging a recent stumble, interview question, or technical blindspot.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              Log Your First Learning
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// TagInput with Autocomplete Suggestions Dropdown
// -----------------------------------------------------------------------------

interface TagInputProps {
  label: string;
  helperText?: string;
  icon?: ReactNode;
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
}

function TagInput({
  label,
  helperText,
  icon,
  tags,
  onChange,
  suggestions,
  placeholder,
  disabled = false,
}: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const existingSet = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags]);

  const filteredSuggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return suggestions
      .filter((item) => !existingSet.has(item.toLowerCase()))
      .filter((item) => !q || item.toLowerCase().includes(q))
      .slice(0, 8);
  }, [suggestions, existingSet, draft]);

  const quickSuggestions = useMemo(() => {
    return suggestions.filter((item) => !existingSet.has(item.toLowerCase())).slice(0, 5);
  }, [suggestions, existingSet]);

  function addTag(valueToAdd: string) {
    const clean = valueToAdd.trim();
    if (!clean || clean.length > 100) return;
    if (existingSet.has(clean.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...tags, clean]);
    setDraft("");
    setHighlightIdx(-1);
    setIsOpen(false);
  }

  function removeTag(tagToRemove: string) {
    onChange(tags.filter((t) => t !== tagToRemove));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (highlightIdx >= 0 && filteredSuggestions[highlightIdx]) {
        addTag(filteredSuggestions[highlightIdx]);
      } else if (draft.trim()) {
        addTag(draft);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) setIsOpen(true);
      setHighlightIdx((prev) => (prev < filteredSuggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((prev) => (prev > 0 ? prev - 1 : filteredSuggestions.length - 1));
    } else if (e.key === "Escape") {
      setIsOpen(false);
    } else if (e.key === "Backspace" && !draft && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }

  return (
    <div className="space-y-2" ref={containerRef}>
      <div>
        <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
          {icon}
          {label}
        </label>
        {helperText && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{helperText}</p>
        )}
      </div>

      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 py-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/70 shadow-2xs transition"
            >
              <span>{tag}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="rounded-full p-0.5 text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition"
                  title={`Remove ${tag}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : disabled ? (
        <p className="text-xs italic text-slate-400 dark:text-slate-500 py-1">No preferences added yet</p>
      ) : null}

      {!disabled && (
        <div className="relative">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setIsOpen(true);
                  setHighlightIdx(-1);
                }}
                onFocus={() => setIsOpen(true)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder || "Type and press Enter…"}
                className={inputClass}
              />
              {draft && (
                <button
                  type="button"
                  onClick={() => setDraft("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                if (draft.trim()) addTag(draft);
                inputRef.current?.focus();
              }}
              disabled={!draft.trim()}
              className="flex items-center gap-1 h-11 px-4 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 disabled:opacity-40 disabled:cursor-not-allowed transition shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>

          {isOpen && (filteredSuggestions.length > 0 || draft.trim().length > 0) && (
            <div className="absolute left-0 right-0 top-full mt-1.5 max-h-56 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-1.5 shadow-xl z-50">
              <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Suggestions
              </div>
              {filteredSuggestions.map((item, idx) => {
                const isHighlighted = idx === highlightIdx;
                return (
                  <button
                    key={item}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addTag(item);
                    }}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-left transition ${
                      isHighlighted
                        ? "bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300"
                        : "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-750"
                    }`}
                  >
                    <span>{item}</span>
                    <Plus className="w-3 h-3 text-slate-400 shrink-0" />
                  </button>
                );
              })}

              {draft.trim() &&
                !suggestions.some((s) => s.toLowerCase() === draft.trim().toLowerCase()) && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addTag(draft);
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 mt-1 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/40 hover:bg-indigo-50 dark:hover:bg-indigo-950/70 text-left border-t border-slate-100 dark:border-slate-700/60"
                  >
                    <span>Add custom: &quot;{draft.trim()}&quot;</span>
                    <Plus className="w-3 h-3" />
                  </button>
                )}
            </div>
          )}

          {quickSuggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2">
              <span className="text-[11px] text-slate-400 dark:text-slate-500 font-medium">
                Suggestions:
              </span>
              {quickSuggestions.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => addTag(item)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 hover:text-indigo-700 dark:hover:text-indigo-300 border border-slate-200 dark:border-slate-700/80 transition"
                >
                  <Plus className="w-2.5 h-2.5" />
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Interactive Employment Types Selector
// -----------------------------------------------------------------------------

function EmploymentTypesSelector({
  selected,
  disabled,
  onChange,
}: {
  selected: string[];
  disabled: boolean;
  onChange: (types: string[]) => void;
}) {
  const [customDraft, setCustomDraft] = useState("");
  const selectedSet = useMemo(() => new Set(selected.map((s) => s.toLowerCase())), [selected]);

  function toggle(type: string) {
    if (selectedSet.has(type.toLowerCase())) {
      onChange(selected.filter((item) => item.toLowerCase() !== type.toLowerCase()));
    } else {
      onChange([...selected, type]);
    }
  }

  function addCustom() {
    const clean = customDraft.trim();
    if (!clean || clean.length > 100) return;
    if (!selectedSet.has(clean.toLowerCase())) {
      onChange([...selected, clean]);
    }
    setCustomDraft("");
  }

  if (disabled) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-1">
        {selected.length > 0 ? (
          selected.map((item) => (
            <span
              key={item}
              className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
            >
              {item}
            </span>
          ))
        ) : (
          <p className="text-xs italic text-slate-400">None specified</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {COMMON_EMPLOYMENT_TYPES.map((type) => {
          const isActive = selectedSet.has(type.toLowerCase());
          return (
            <button
              key={type}
              type="button"
              onClick={() => toggle(type)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                isActive
                  ? "bg-indigo-600 text-white shadow-xs border border-indigo-600"
                  : "bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
              }`}
            >
              {isActive && <Check className="w-3 h-3 stroke-[2.5]" />}
              {type}
            </button>
          );
        })}
      </div>

      {selected.filter((s) => !COMMON_EMPLOYMENT_TYPES.some((c) => c.toLowerCase() === s.toLowerCase())).length >
        0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {selected
            .filter((s) => !COMMON_EMPLOYMENT_TYPES.some((c) => c.toLowerCase() === s.toLowerCase()))
            .map((item) => (
              <span
                key={item}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/70"
              >
                {item}
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((x) => x !== item))}
                  className="hover:text-indigo-900 dark:hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <input
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="Add custom employment type…"
          className="h-9 flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 text-xs text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500"
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={!customDraft.trim()}
          className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
      <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-bold text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
      {text}
    </p>
  );
}

function SavedJobs({ token }: { token: string }) {
  const [rows, setRows] = useState<Array<{ job: Job }>>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch(API + "/saved-jobs", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(await responseError(r));
        setRows(await r.json());
      })
      .catch((e) => setError(e.message));
  }, [token]);

  return (
    <div className="mt-6 space-y-3">
      {error && <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p>}
      {rows.length ? (
        rows.map(({ job }) => (
          <article
            key={String(job.id)}
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs"
          >
            <h2 className="font-semibold text-slate-900 dark:text-white">{job.title}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {job.company} · {job.location}
            </p>
            {job.apply_url && (
              <a
                href={job.apply_url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                Open listing
              </a>
            )}
          </article>
        ))
      ) : (
        !error && <Empty text="Saved job postings will appear here." />
      )}
    </div>
  );
}
