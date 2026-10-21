import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight, Bookmark, BrainCircuit, BriefcaseBusiness, Check, ChevronDown, ChevronLeft,
  ChevronRight, CircleHelp, FileText, FilterX, Globe2,
  LoaderCircle, MapPin, Menu, Moon, Search, Sparkles, Sun,
  ShieldCheck, Target, TrendingUp, UploadCloud, X, Zap,
} from "lucide-react";

const API = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const PAGE_SIZE = 20;
const APPLICATION_STATUSES = ["Saved", "Applied", "Interviewing", "Rejected", "Offered", "Withdrawn"] as const;

type Job = {
  id: number | string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  skills?: string[];
  apply_url?: string;
  posted_at?: string;
  match_score: number;
  matched_skills?: string[];
  missing_skills?: string[];
  source?: string;
  country?: string;
  work_mode?: string;
};
type ResumeResult = { filename: string; text: string };
type SortMode = "score-desc" | "score-asc" | "title-asc";
type ApiStatus = "checking" | "online" | "offline";
type MatchStage = "idle" | "starting" | "streaming" | "complete" | "cancelled" | "error";
type MatchProgress = { processed: number; emitted: number; total: number | null };
type MatchEvent = {
  jobs?: Job[];
  message?: string;
  processed_count?: number;
  emitted_count?: number;
  total_jobs?: number | null;
  ranked_ids?: Array<number | string>;
  partial?: boolean;
};
type Theme = "light" | "dark";
type RoleType = "all" | "ai_ml" | "software" | "data" | "internship" | "entry";
type CatalogStats = { job_count: number; company_count: number; india_job_count: number; remote_india_count: number };
type AuthUser = { id: string; email: string; name: string };
type SavedJob = { saved_at?: string; job: Job };
type TrackedApplication = { status: typeof APPLICATION_STATUSES[number]; notes?: string; job: Job };
type GrowthItem = {
  id: string;
  title: string;
  category: string;
  source?: string;
  reflection?: string;
  action_plan?: string;
  status: "Identified" | "Practicing" | "Mastered";
  created_at?: string;
};

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem("jobsync-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* Storage can be unavailable in private browsing. */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initialAuthToken() {
  try { return localStorage.getItem("jobsync-token") ?? ""; }
  catch { return ""; }
}

function isIndiaListing(job: Job) {
  const country = (job.country ?? "").toLocaleLowerCase().trim();
  const location = (job.location ?? "").toLocaleLowerCase();
  return ["in", "ind", "india"].includes(country)
    || /\bindia\b/.test(location)
    || /\b(bengaluru|bangalore|hyderabad|gurugram|gurgaon|delhi|noida|pune|mumbai|chennai|kolkata|ahmedabad|jaipur|kochi|cochin|coimbatore|mysore|mangalore|lucknow|indore)\b/.test(location);
}

function hasRoleEvidence(job: Job, roleType: RoleType) {
  if (roleType === "all") return true;
  const text = `${job.title ?? ""} ${job.description ?? ""}`.toLocaleLowerCase();
  const patterns: Record<Exclude<RoleType, "all">, RegExp> = {
    ai_ml: /\b(ai|artificial intelligence|machine learning|ml engineer|gen(?:erative)? ai|nlp|llm|data science)\b/,
    software: /\b(software|developer|backend|back-end|frontend|front-end|full[ -]?stack|platform engineer)\b/,
    data: /\b(data analyst|data engineer|data scientist|analytics|business intelligence)\b/,
    internship: /\b(intern|internship|apprentice)\b/,
    entry: /\b(entry[ -]?level|graduate|fresher|new grad|junior|early career|trainee)\b/,
  };
  return patterns[roleType].test(text);
}

const DESCRIPTION_SKILL_TERMS = [
  "natural language processing", "machine learning", "deep learning", "data analysis",
  "data visualization", "scikit-learn", "javascript", "typescript", "postgresql",
  "tensorflow", "pytorch", "fastapi", "django", "flask", "python", "java",
  "react", "html", "css", "sql", "mysql", "mongodb", "pandas", "numpy",
  "excel", "statistics", "git", "rest apis", "docker", "nlp",
];

function normalizeSkill(skill: string) {
  return skill.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function formatPostingDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function skillsForJob(job: Job) {
  // Prefer API-extracted job skills, then matcher skill metadata. Only scan descriptions when both are absent.
  const metadata = job.skills?.length ? job.skills : [...(job.matched_skills ?? []), ...(job.missing_skills ?? [])];
  if (metadata.length) return new Set(metadata.map(normalizeSkill).filter(Boolean));
  const description = normalizeSkill(job.description ?? "");
  return new Set(DESCRIPTION_SKILL_TERMS.filter((skill) =>
    new RegExp("(^|[^a-z0-9+#.])" + skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z0-9+#.])", "i").test(description),
  ).map(normalizeSkill));
}

function matchesRequiredSkills(job: Job, requiredSkills: string[], mode: "any" | "all") {
  if (!requiredSkills.length) return true;
  const jobSkills = skillsForJob(job);
  const selected = requiredSkills.map(normalizeSkill);
  return mode === "all"
    ? selected.every((skill) => jobSkills.has(skill))
    : selected.some((skill) => jobSkills.has(skill));
}

export function Dashboard() {
  const fileInput = useRef<HTMLInputElement>(null);
  const matchController = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [resume, setResume] = useState<ResumeResult | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [matchCompleted, setMatchCompleted] = useState(false);
  const [parseLoading, setParseLoading] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchStage, setMatchStage] = useState<MatchStage>("idle");
  const [progress, setProgress] = useState<MatchProgress>({ processed: 0, emitted: 0, total: null });
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [locationSearch, setLocationSearch] = useState("");
  const [requiredSkills, setRequiredSkills] = useState<string[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillMatchMode, setSkillMatchMode] = useState<"any" | "all">("any");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [minScore, setMinScore] = useState(0);
  const [sortMode, setSortMode] = useState<SortMode>("score-desc");
  const [page, setPage] = useState(1);
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [catalogStats, setCatalogStats] = useState<CatalogStats | null>(null);
  const [indiaOnly, setIndiaOnly] = useState(false);
  const [remoteIndiaOnly, setRemoteIndiaOnly] = useState(false);
  const [roleType, setRoleType] = useState<RoleType>("all");
  const [firstResultMs, setFirstResultMs] = useState<number | null>(null);
  const [authToken, setAuthToken] = useState(initialAuthToken);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState("");
  const [savedJobs, setSavedJobs] = useState<SavedJob[]>([]);
  const [applications, setApplications] = useState<TrackedApplication[]>([]);
  const [growthItems, setGrowthItems] = useState<GrowthItem[]>([]);
  const matchStartedAt = useRef<number | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("dark", theme === "dark");
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    themeMeta?.setAttribute("content", theme === "dark" ? "#111827" : "#f5f7fb");
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncPreference = (event: MediaQueryListEvent) => {
      try { if (!localStorage.getItem("jobsync-theme")) setTheme(event.matches ? "dark" : "light"); }
      catch { setTheme(event.matches ? "dark" : "light"); }
    };
    media.addEventListener("change", syncPreference);
    return () => media.removeEventListener("change", syncPreference);
  }, []);

  useEffect(() => {
    if (!authToken) return;
    const controller = new AbortController();
    const headers = { Authorization: `Bearer ${authToken}` };
    void Promise.all([
      fetch(API + "/auth/me", { headers, signal: controller.signal }),
      fetch(API + "/saved-jobs", { headers, signal: controller.signal }),
      fetch(API + "/applications", { headers, signal: controller.signal }),
      fetch(API + "/preferences", { headers, signal: controller.signal }),
      fetch(API + "/growth", { headers, signal: controller.signal }).catch(() => null),
    ]).then(async ([userResponse, savedResponse, applicationsResponse, preferencesResponse, growthResponse]) => {
      if (!userResponse.ok) throw new Error("Your sign-in expired. Please sign in again.");
      const user = await userResponse.json() as AuthUser;
      const saved = savedResponse.ok ? await savedResponse.json() as SavedJob[] : [];
      const tracked = applicationsResponse.ok ? await applicationsResponse.json() as TrackedApplication[] : [];
      const preferences = preferencesResponse.ok ? await preferencesResponse.json() as Record<string, unknown> : {};
      const growth = growthResponse && growthResponse.ok ? await growthResponse.json() as GrowthItem[] : [];
      setAuthUser(user);
      setSavedJobs(saved);
      setApplications(tracked);
      setGrowthItems(growth);
      if (typeof preferences.search === "string") setSearch(preferences.search);
      if (typeof preferences.location_search === "string") setLocationSearch(preferences.location_search);
      if (typeof preferences.remote_only === "boolean") setRemoteOnly(preferences.remote_only);
      if (typeof preferences.india_only === "boolean") setIndiaOnly(preferences.india_only);
      if (typeof preferences.remote_india_only === "boolean") setRemoteIndiaOnly(preferences.remote_india_only);
      if (typeof preferences.role_type === "string") setRoleType(preferences.role_type as RoleType);
      if (typeof preferences.min_score === "number") setMinScore(preferences.min_score);
      if (Array.isArray(preferences.required_skills)) setRequiredSkills(preferences.required_skills.filter((skill): skill is string => typeof skill === "string"));
      if (preferences.skill_match_mode === "all" || preferences.skill_match_mode === "any") setSkillMatchMode(preferences.skill_match_mode);
      if (preferences.sort_mode === "score-desc" || preferences.sort_mode === "score-asc" || preferences.sort_mode === "title-asc") setSortMode(preferences.sort_mode);
      if (preferences.theme === "light" || preferences.theme === "dark") setTheme(preferences.theme);
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      setAuthError(err instanceof Error ? err.message : "Could not load your account data.");
      if (err instanceof Error && err.message.includes("sign-in expired")) {
        try { localStorage.removeItem("jobsync-token"); } catch { /* Clear in-memory session below. */ }
        setAuthToken("");
        setAuthUser(null);
        setSavedJobs([]);
        setApplications([]);
        setGrowthItems([]);
      }
    });
    return () => controller.abort();
  }, [authToken]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(API + "/jobs/stats", { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Catalog unavailable"); return response.json() as Promise<CatalogStats>; })
      .then(setCatalogStats)
      .catch(() => setCatalogStats(null));
    return () => controller.abort();
  }, []);

  useLayoutEffect(() => {
    if (!jobs.length || firstResultMs !== null || matchStartedAt.current === null) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (matchStartedAt.current !== null) setFirstResultMs(performance.now() - matchStartedAt.current);
        matchStartedAt.current = null;
      });
    });
    return () => { window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame); };
  }, [jobs.length, firstResultMs]);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const checkApi = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const response = await fetch(API + "/health", { signal: requestController.signal });
        if (!response.ok) throw new Error("Health check failed");
        if (active) setApiStatus("online");
      } catch {
        if (active && !requestController.signal.aborted) setApiStatus("offline");
      }
    };
    void checkApi();
    const timer = window.setInterval(checkApi, 15000);
    return () => {
      active = false;
      controller?.abort();
      matchController.current?.abort();
      window.clearInterval(timer);
    };
  }, []);

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const place = locationSearch.trim().toLocaleLowerCase();
    const filtered = jobs.filter((job) => {
      const title = job.title ?? "";
      const company = job.company ?? "";
      const location = job.location ?? "";
      const isRemote = (job.work_mode ?? "").toLocaleLowerCase() === "remote" || location.toLocaleLowerCase().includes("remote");
      const eligibleRemoteIndia = isRemote && isIndiaListing(job);
      return (!query || (title + " " + company).toLocaleLowerCase().includes(query))
        && (!place || location.toLocaleLowerCase().includes(place))
        && (!remoteOnly || isRemote)
        && (!indiaOnly || isIndiaListing(job))
        && (!remoteIndiaOnly || eligibleRemoteIndia)
        && hasRoleEvidence(job, roleType)
        && matchesRequiredSkills(job, requiredSkills, skillMatchMode)
        && job.match_score >= minScore;
    });
    if (sortMode === "score-desc") return filtered;
    return filtered.sort((a, b) => {
      if (sortMode === "score-asc") return a.match_score - b.match_score;
      if (sortMode === "title-asc") return (a.title ?? "").localeCompare(b.title ?? "");
      return 0;
    });
  }, [indiaOnly, jobs, locationSearch, minScore, remoteIndiaOnly, remoteOnly, requiredSkills, roleType, search, skillMatchMode, sortMode]);

  const availableSkills = useMemo(() => {
    const labels = new Map<string, string>();
    for (const job of jobs) {
      for (const skill of skillsForJob(job)) {
        if (!labels.has(skill)) labels.set(skill, skill);
      }
    }
    return [...labels.values()].sort((a, b) => a.localeCompare(b));
  }, [jobs]);
  const skillSuggestions = availableSkills.filter((skill) =>
    !requiredSkills.some((selected) => normalizeSkill(selected) === normalizeSkill(skill))
      && (!skillQuery.trim() || skill.toLocaleLowerCase().includes(skillQuery.trim().toLocaleLowerCase())),
  ).slice(0, 8);

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageJobs = filteredJobs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const summary = useMemo(() => {
    if (!jobs.length) return { best: 0, average: 0, companies: 0 };
    return {
      best: Math.max(...jobs.map((job) => job.match_score)),
      average: jobs.reduce((sum, job) => sum + job.match_score, 0) / jobs.length,
      companies: new Set(jobs.map((job) => job.company).filter(Boolean)).size,
    };
  }, [jobs]);

  function selectFile(candidate?: File) {
    if (!candidate) return;
    if (!candidate.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF resume.");
      return;
    }
    if (candidate.size > 5 * 1024 * 1024) {
      setError("This PDF is larger than the 5 MB upload limit.");
      return;
    }
    matchController.current?.abort();
    matchController.current = null;
    setMatching(false);
    setMatchStage("idle");
    setProgress({ processed: 0, emitted: 0, total: null });
    setFirstResultMs(null);
    matchStartedAt.current = null;
    setFile(candidate);
    setResume(null);
    setJobs([]);
    setMatchCompleted(false);
    setError("");
  }

  async function responseError(response: Response, fallback: string) {
    try {
      const body = (await response.json()) as { detail?: unknown };
      return typeof body.detail === "string" ? body.detail : fallback;
    } catch {
      return fallback;
    }
  }

  async function analyzeResume() {
    if (!file || parseLoading) return;
    setParseLoading(true);
    setError("");
    setResume(null);
    setJobs([]);
    setMatchCompleted(false);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(API + "/resume/parse", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseError(response, "Resume parsing failed."));
      setResume((await response.json()) as ResumeResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this resume.");
    } finally {
      setParseLoading(false);
    }
  }

  async function findJobs() {
    if (!resume || matching) return;
    const controller = new AbortController();
    matchController.current = controller;
    setMatching(true);
    setMatchStage("starting");
    setError("");
    setJobs([]);
    setMatchCompleted(false);
    setProgress({ processed: 0, emitted: 0, total: null });
    setFirstResultMs(null);
    matchStartedAt.current = performance.now();
    setPage(1);
    setExpandedJobs(new Set());
    requestAnimationFrame(() => document.getElementById("find-jobs")?.scrollIntoView({ behavior: "smooth" }));

    let terminalEvent = false;
    let buffer = "";
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const consumeFrame = (frame: string) => {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) return;
      const payload = JSON.parse(dataLines.join("\n")) as MatchEvent;
      if (typeof payload.processed_count === "number") {
        setProgress({
          processed: payload.processed_count,
          emitted: payload.emitted_count ?? 0,
          total: typeof payload.total_jobs === "number" ? payload.total_jobs : null,
        });
      }
      if (eventName === "started") {
        setMatchStage("starting");
      } else if (eventName === "ready") {
        setMatchStage("streaming");
      } else if (eventName === "batch") {
        setMatchStage("streaming");
        if (Array.isArray(payload.jobs)) {
          setJobs((current) => {
            const byId = new Map(current.map((job) => [String(job.id), job]));
            for (const job of payload.jobs ?? []) byId.set(String(job.id), job);
            return [...byId.values()].sort((a, b) => b.match_score - a.match_score);
          });
        }
      } else if (eventName === "completed") {
        terminalEvent = true;
        const rankedIds = payload.ranked_ids ?? [];
        setJobs((current) => {
          const byId = new Map(current.map((job) => [String(job.id), job]));
          return rankedIds.map((id) => byId.get(String(id))).filter((job): job is Job => Boolean(job));
        });
        setMatchCompleted(true);
        setMatchStage("complete");
      } else if (eventName === "error") {
        terminalEvent = true;
        setMatchStage("error");
        setError(payload.message || "Matching stopped. Received results are partial.");
      }
    };

    try {
      if (!resume.text.trim()) throw new Error("The extracted resume text is empty. Please upload a readable PDF.");
      const response = await fetch(API + "/jobs/match/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume_text: resume.text, limit: 5000, batch_size: PAGE_SIZE }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response, "Job matching failed."));
      if (!response.body) throw new Error("The server did not provide a readable matching stream.");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          consumeFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode().replace(/\r\n/g, "\n");
      if (buffer.trim()) consumeFrame(buffer);
      if (!terminalEvent && !controller.signal.aborted) {
        throw new Error("The matching stream ended unexpectedly. Any results shown are partial.");
      }
    } catch (err) {
      if (matchController.current === controller) {
        if (controller.signal.aborted) {
          setMatchStage("cancelled");
        } else {
          setMatchStage("error");
          setError(err instanceof Error ? err.message : "Could not find matching jobs. Any results shown are partial.");
        }
      }
    } finally {
      reader?.releaseLock();
      if (matchController.current === controller) {
        setMatching(false);
        matchController.current = null;
      }
    }
  }

  function cancelMatching() {
    matchController.current?.abort();
    setMatchStage("cancelled");
    setMatching(false);
  }

  function clearFilters() {
    setSearch("");
    setLocationSearch("");
    setRequiredSkills([]);
    setSkillQuery("");
    setSkillMatchMode("any");
    setRemoteOnly(false);
    setIndiaOnly(false);
    setRemoteIndiaOnly(false);
    setRoleType("all");
    setMinScore(0);
    setSortMode("score-desc");
    setPage(1);
  }

  function signOut() {
    if (authToken) void fetch(API + "/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${authToken}` } });
    try { localStorage.removeItem("jobsync-token"); } catch { /* Sign-out still clears this view. */ }
    setAuthToken("");
    setAuthUser(null);
    setSavedJobs([]);
    setApplications([]);
    setGrowthItems([]);
  }

  async function refreshPersonalData() {
    if (!authToken) return;
    const headers = { Authorization: `Bearer ${authToken}` };
    const [savedResponse, applicationsResponse, growthResponse] = await Promise.all([
      fetch(API + "/saved-jobs", { headers }),
      fetch(API + "/applications", { headers }),
      fetch(API + "/growth", { headers }).catch(() => null),
    ]);
    if (savedResponse.ok) setSavedJobs(await savedResponse.json() as SavedJob[]);
    if (applicationsResponse.ok) setApplications(await applicationsResponse.json() as TrackedApplication[]);
    if (growthResponse && growthResponse.ok) setGrowthItems(await growthResponse.json() as GrowthItem[]);
  }

  async function toggleSavedJob(job: Job) {
    if (!authToken) { setAuthError("Sign in to save jobs."); return; }
    const alreadySaved = savedJobs.some((record) => String(record.job.id) === String(job.id));
    try {
      const response = await fetch(API + "/saved-jobs/" + encodeURIComponent(String(job.id)), {
        method: alreadySaved ? "DELETE" : "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not update saved jobs."));
      await refreshPersonalData();
      setAuthError("");
    } catch (err) { setAuthError(err instanceof Error ? err.message : "Could not update saved jobs."); }
  }

  async function updateApplication(job: Job, status: string) {
    if (!authToken || !status) return;
    const exists = applications.some((record) => String(record.job.id) === String(job.id));
    try {
      const response = await fetch(API + (exists ? "/applications/" + encodeURIComponent(String(job.id)) : "/applications"), {
        method: exists ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(exists ? { status } : { job_id: String(job.id), status }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not update application tracking."));
      await refreshPersonalData();
      setAuthError("");
    } catch (err) { setAuthError(err instanceof Error ? err.message : "Could not update application tracking."); }
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("jobsync-theme", next); } catch { /* Theme still changes for this session. */ }
    setTheme(next);
  }

  function goToUpload() {
    document.getElementById("resume-upload")?.scrollIntoView({ behavior: "smooth", block: "start" });
    fileInput.current?.click();
  }

  function toggleDescription(id: string) {
    setExpandedJobs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function recordJobVisit(job: Job) {
    if (!authToken) return;
    try {
      const response = await fetch(API + "/users/me/job-visits", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ job_id: String(job.id) }),
      });
      if (!response.ok && response.status === 401) {
        try { localStorage.removeItem("jobsync-token"); } catch { /* Session is cleared in memory below. */ }
        setAuthToken(""); setAuthUser(null);
      }
    } catch { /* Activity is optional while the backend is offline. */ }
  }

  const avatarLabel = (authUser?.name || authUser?.email || "U").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toLocaleUpperCase()).join("");

  return (
    <div id="dashboard" className="min-h-screen bg-[#f5f7fb] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-[72px] max-w-[1400px] items-center justify-between px-4 sm:px-6 lg:px-10">
          <a href="#home" className="flex items-center gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/20"><Sparkles size={21} aria-hidden="true" /></span>
            <span><span className="block text-[15px] font-bold tracking-tight">JobSync <span className="text-indigo-600">AI</span></span><span className="hidden text-[11px] text-slate-500 sm:block">AI-powered job matching</span></span>
          </a>
          <nav className="hidden items-center gap-8 md:flex" aria-label="Main navigation">
            <a className="text-sm font-medium text-slate-600 hover:text-indigo-700" href="#features">Features</a>
            <a className="text-sm font-medium text-slate-600 hover:text-indigo-700" href="#how-it-works">How it works</a>
            <a className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-indigo-700" href="#growth">
              <span>Weakness & Growth</span>
              {growthItems.length > 0 && (
                <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                  {growthItems.length}
                </span>
              )}
            </a>
            <a className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-indigo-700" href="/coach">
              <Sparkles size={14} className="text-purple-600" />
              <span>Interview Coach</span>
            </a>
            <a className="text-sm font-medium text-slate-600 hover:text-indigo-700" href="#resume-upload">Find jobs</a>
          </nav>
          <div className="flex items-center gap-2">
          {authUser ? <details className="relative"><summary aria-label="Profile menu" className="inline-flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{avatarLabel}</span><span className="hidden sm:inline">{authUser.name || authUser.email}</span><ChevronDown size={14} /></summary><div className="absolute right-0 top-12 z-40 min-w-48 rounded-xl border border-slate-200 bg-white p-2 shadow-lg"><a className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-50" href="/profile">Profile</a><a className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-50" href="/coach">Interview Coach</a><a className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-50" href="/applications">Applications</a><a className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-50" href="/growth">Weaknesses & Growth</a><a className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-50" href="/activity">Activity</a><a className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-50" href="/saved-jobs">Saved Jobs</a><button onClick={signOut} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50">Logout</button></div></details> : <a href="/login" className="rounded-lg px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50">Login</a>}
          <button type="button" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} aria-pressed={theme === "dark"} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"><span aria-hidden="true">{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</span><span className="hidden sm:inline">{theme === "dark" ? "Light" : "Dark"}</span></button>
          <button type="button" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 md:hidden" aria-label={mobileNavOpen ? "Close menu" : "Open menu"} aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}>
            {mobileNavOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
          </div>
        </div>
        {mobileNavOpen && <nav className="border-t border-slate-100 bg-white px-5 py-3 md:hidden" aria-label="Mobile navigation">
          <a onClick={() => setMobileNavOpen(false)} className="block rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" href="#features">Features</a>
          <a onClick={() => setMobileNavOpen(false)} className="block rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" href="#how-it-works">How it works</a>
          <a onClick={() => setMobileNavOpen(false)} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" href="#growth">
            <span>Weakness & Growth</span>
            {growthItems.length > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-700">
                {growthItems.length}
              </span>
            )}
          </a>
          <a onClick={() => setMobileNavOpen(false)} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" href="/coach">
            <span className="flex items-center gap-1.5">
              <Sparkles size={14} className="text-purple-600" />
              Interview Coach
            </span>
          </a>
          <a onClick={() => setMobileNavOpen(false)} className="block rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" href="#resume-upload">Find jobs</a>
        </nav>}
      </header>

      <main id="home" className="mx-auto max-w-[1400px] px-4 pb-16 pt-8 sm:px-6 sm:pt-11 lg:px-10">
        {authError && <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{authError}</p>}
        <section className="hero-panel grid items-center gap-10 overflow-hidden rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-9 lg:grid-cols-[1.12fr_0.88fr] lg:px-12 lg:py-12">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700"><Zap size={14} /> A clearer path from resume to opportunity</div>
            <h1 className="max-w-2xl text-4xl font-bold leading-[1.08] tracking-[-0.04em] text-slate-950 sm:text-5xl lg:text-[58px]">Your next opportunity starts <span className="text-indigo-600">with your skills.</span></h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">Discover relevant jobs from real companies. Upload your resume, understand your strengths, and find opportunities that fit your experience.</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <button type="button" onClick={goToUpload} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Find my matches <ArrowRight size={17} /></button>
              <a href="#features" className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">Explore opportunities <Globe2 size={16} /></a>
            </div>
            {catalogStats && <div className="mt-8 flex flex-wrap gap-x-7 gap-y-3 border-t border-slate-100 pt-5" aria-label="Current job database statistics"><div><p className="text-2xl font-bold tracking-tight text-slate-900">{catalogStats.job_count.toLocaleString()}</p><p className="text-xs text-slate-500">current listings</p></div><div><p className="text-2xl font-bold tracking-tight text-slate-900">{catalogStats.company_count.toLocaleString()}</p><p className="text-xs text-slate-500">employers</p></div><div><p className="text-2xl font-bold tracking-tight text-slate-900">{catalogStats.india_job_count.toLocaleString()}</p><p className="text-xs text-slate-500">jobs in India</p></div></div>}
            <p className="mt-4 text-xs text-slate-500">PDF only · Maximum file size 5 MB</p>
          </div>
          <MatchIllustration />
        </section>

        <section id="features" className="scroll-mt-24 pt-20" aria-labelledby="features-heading">
          <div className="mx-auto max-w-2xl text-center"><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">A more useful way to search</p><h2 id="features-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Turn your experience into a focused search.</h2><p className="mt-3 text-sm leading-6 text-slate-600">Real listings, transparent skill comparisons, and results you can act on.</p></div>
          <div className="mt-9 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <FeatureCard icon={<BrainCircuit size={19} />} title="Relevant matches" text="Semantic similarity and skill overlap help surface roles connected to your resume." />
            <FeatureCard icon={<Target size={19} />} title="Transparent scores" text="Compare semantic relevance and skill overlap; scores estimate fit and are not hiring probabilities." />
            <FeatureCard icon={<BriefcaseBusiness size={19} />} title="Real employers" text="Explore sourced openings with original application links and employer attribution." />
            <FeatureCard icon={<Globe2 size={19} />} title="India opportunities" text={catalogStats ? `${catalogStats.india_job_count.toLocaleString()} listings currently identify an India location.` : "Filter listings by their published location and supported work mode."} />
            <FeatureCard icon={<Zap size={19} />} title="Results as they arrive" text="Scored job cards appear in batches while the rest of the catalog is processed." />
            <FeatureCard icon={<Bookmark size={19} />} title="Saved jobs and tracking" text="Keep a shortlist and update each application from Saved through interview and offer outcomes." />
            <FeatureCard icon={<ShieldCheck size={19} />} title="Resume privacy" text="Resume text is processed by the local API for matching and is not stored with your account." />
            <FeatureCard icon={<TrendingUp size={19} />} title="Weakness & Growth" text="Log interview reflections, identify skill blindspots, and systematically turn gaps into strengths." />
          </div>
        </section>

        <section id="how-it-works" className="mt-20 scroll-mt-24 rounded-3xl border border-slate-200 bg-slate-900 px-6 py-9 text-white sm:px-9 lg:px-12" aria-labelledby="how-heading">
          <div className="grid gap-8 lg:grid-cols-[0.7fr_1.3fr] lg:items-start"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-300">How it works</p><h2 id="how-heading" className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Three steps to your next move.</h2><p className="mt-4 text-sm leading-6 text-slate-300">A straightforward way to compare what you know with what employers are asking for.</p></div><ol className="grid gap-6 sm:grid-cols-3"><HowStep number="01" icon={<UploadCloud size={19} />} title="Upload your resume" text="Add a text-readable PDF. The app extracts its content before matching." /><HowStep number="02" icon={<Sparkles size={19} />} title="Review your fit" text="The matcher evaluates resume relevance and overlap with listed skills." /><HowStep number="03" icon={<ArrowRight size={19} />} title="Explore and apply" text="Compare roles, refine results, and follow the original application link." /></ol></div>
          <p className="mt-7 border-t border-white/10 pt-4 text-xs text-slate-400">Match scores estimate relevance between a resume and a listing; they are not probabilities of getting hired.</p>
        </section>

        <section id="growth" className="mt-20 scroll-mt-24 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9 lg:p-12" aria-labelledby="growth-heading">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8 pb-8 border-b border-slate-100">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                <BrainCircuit size={14} /> Weakness & Growth Engine
              </div>
              <h2 id="growth-heading" className="text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
                Turn your interview gaps into <span className="text-indigo-600">career strengths.</span>
              </h2>
              <p className="mt-3 text-base text-slate-600 leading-relaxed">
                JobSync AI doesn’t just show where you match — it highlights where you have skill blindspots. Log interview takeaways, track missing job requirements, and turn weaknesses into actionable study plans.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
              <a
                href="/coach"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:from-violet-700 hover:to-indigo-700"
              >
                <Sparkles size={16} className="text-amber-300" /> AI Debrief Coach
              </a>
              <a
                href="/growth"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"
              >
                <TrendingUp size={16} /> Open Tracker
              </a>
              {authUser && (
                <span className="text-center sm:text-left text-xs font-medium text-slate-500">
                  {growthItems.length} {growthItems.length === 1 ? "record" : "records"} logged
                </span>
              )}
            </div>
          </div>

          <div className="mt-8 grid gap-5 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-5 transition hover:border-indigo-200 hover:bg-indigo-50/30">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700 font-bold text-sm">
                01
              </div>
              <h3 className="mt-4 font-bold text-slate-900">1. Spot the Blindspot</h3>
              <p className="mt-1.5 text-xs leading-5 text-slate-600">
                Identify missing skills from target job descriptions or capture questions you stumbled on during recent technical interviews.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-5 transition hover:border-indigo-200 hover:bg-indigo-50/30">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700 font-bold text-sm">
                02
              </div>
              <h3 className="mt-4 font-bold text-slate-900">2. Structured Practice</h3>
              <p className="mt-1.5 text-xs leading-5 text-slate-600">
                Create clear action plans: tutorials, code implementations, system design deep-dives, and spaced repetition drills.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-5 transition hover:border-indigo-200 hover:bg-indigo-50/30">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 font-bold text-sm">
                03
              </div>
              <h3 className="mt-4 font-bold text-slate-900">3. Proven Mastery</h3>
              <p className="mt-1.5 text-xs leading-5 text-slate-600">
                Transition your logs from <span className="font-semibold text-slate-700">Identified</span> → <span className="font-semibold text-slate-700">Practicing</span> → <span className="font-semibold text-emerald-700">Mastered</span> with measurable confidence.
              </p>
            </div>
          </div>

          <div className="mt-7 rounded-2xl border border-slate-200/80 bg-slate-50/50 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                {growthItems.length > 0 ? "Your Active Growth Journey" : "Common Interview Blindspots You Can Track"}
              </p>
              <a href="/growth" className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                View all in workspace <ArrowRight size={13} />
              </a>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {(growthItems.length > 0 ? growthItems.slice(0, 3) : [
                { id: "sample-1", title: "Distributed Caching & Invalidation", category: "System Design", status: "Practicing" as const, reflection: "Got tripped up on Cache-Aside vs Write-Through failure modes." },
                { id: "sample-2", title: "PostgreSQL Indexing & EXPLAIN Plans", category: "Technical Skills", status: "Mastered" as const, reflection: "Understood B-tree vs GIN indexes and sequential scan causes." },
                { id: "sample-3", title: "Handling Conflict in Cross-Team Projects", category: "Behavioral & Soft Skills", status: "Identified" as const, reflection: "Prepare clear STAR stories highlighting empathy and stakeholder alignment." },
              ]).map((item) => (
                <div key={item.id} className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{item.category}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        item.status === "Mastered"
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200/60"
                          : item.status === "Practicing"
                          ? "bg-indigo-50 text-indigo-700 border border-indigo-200/60"
                          : "bg-amber-50 text-amber-700 border border-amber-200/60"
                      }`}>
                        {item.status}
                      </span>
                    </div>
                    <h4 className="mt-2 text-sm font-bold text-slate-900 line-clamp-1">{item.title}</h4>
                    {item.reflection && (
                      <p className="mt-1 text-xs text-slate-500 line-clamp-2 leading-relaxed">{item.reflection}</p>
                    )}
                  </div>
                  <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                    <a href={`/growth?source=${encodeURIComponent(item.title)}`} className="font-semibold text-indigo-600 hover:underline">
                      Review / Practice →
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Interview Debrief AI Mentor Callout */}
        <section className="ai-mentor-callout mt-8 rounded-3xl border border-indigo-100 dark:border-indigo-900/60 bg-gradient-to-r from-violet-50 via-indigo-50 to-sky-50 dark:from-slate-900 dark:via-indigo-950/70 dark:to-slate-900 p-6 sm:p-9 shadow-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-2 max-w-2xl">
              <span className="ai-mentor-badge inline-flex items-center gap-1.5 rounded-full bg-indigo-100 dark:bg-indigo-900/70 border border-indigo-200/60 dark:border-indigo-700/60 px-3 py-0.5 text-xs font-semibold text-indigo-800 dark:text-indigo-200">
                <Sparkles size={13} className="text-indigo-600 dark:text-indigo-300" /> AI Debrief Room · Intelligent Mentorship
              </span>
              <h3 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                Just had an interview? Talk to your AI Coach.
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                “Everything is a learning until you win. Be patient to achieve big.” Share your entire experience—questions asked, tricky edge-cases, or rejections. The AI mentor boosts your confidence, memorizes your journey, and advises on what to target next.
              </p>
            </div>
            <a
              href="/coach"
              className="inline-flex shrink-0 min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-6 text-sm font-semibold text-white shadow-md transition hover:from-violet-700 hover:to-indigo-700 hover:shadow-indigo-500/25"
            >
              <Sparkles size={16} className="text-amber-300" /> Start AI Interview Debrief →
            </a>
          </div>
        </section>

        <section id="resume-upload" className="mt-20 scroll-mt-24 grid gap-6 lg:grid-cols-[minmax(0,1fr)_330px]" aria-labelledby="resume-heading">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-indigo-600">Step 1 · Resume</p><h2 id="resume-heading" className="mt-2 text-xl font-bold tracking-tight text-slate-900">Start with your experience</h2><p className="mt-1.5 text-sm text-slate-500">The PDF is parsed first; extracted text is sent when you request job matches.</p></div>
              {resume && <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700"><Check size={14} /> Resume parsed</span>}
            </div>
            <input ref={fileInput} type="file" accept=".pdf,application/pdf" className="sr-only" aria-label="Choose a PDF resume" onChange={(event) => { selectFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            {!file ? (
              <div
                role="button"
                tabIndex={0}
                aria-label="Choose a PDF resume or drop it here"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.current?.click(); } }}
                onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
                onDrop={(event) => { event.preventDefault(); setDragOver(false); selectFile(event.dataTransfer.files[0]); }}
                className={"mt-6 flex min-h-[210px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-5 py-7 text-center transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 " + (dragOver ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-slate-50/70 hover:border-indigo-400 hover:bg-indigo-50/50")}
              >
                <span className={"flex h-12 w-12 items-center justify-center rounded-2xl " + (dragOver ? "bg-indigo-600 text-white" : "bg-white text-indigo-600 shadow-sm")}><UploadCloud size={23} aria-hidden="true" /></span>
                <span className="mt-4 text-sm font-semibold text-slate-800">Drop your resume here</span>
                <span className="mt-1.5 text-sm text-slate-500">or choose a PDF from your device</span>
                <span className="mt-4 inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-700 shadow-sm">Choose PDF</span>
              </div>
            ) : (
              <div className="mt-6 flex flex-col justify-between gap-4 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 sm:flex-row sm:items-center sm:p-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm"><FileText size={20} /></span>
                  <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{file.name}</p><p className="mt-1 text-xs text-slate-500">{(file.size / (1024 * 1024)).toFixed(2)} MB · PDF</p></div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">Replace</button>
                  <button type="button" aria-label="Remove selected resume" onClick={() => { setFile(null); setResume(null); setJobs([]); setError(""); }} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:text-rose-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"><X size={16} /></button>
                </div>
              </div>
            )}

            {error && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3" role="alert"><p className="text-sm text-rose-800">{error}</p>{resume ? <button type="button" onClick={findJobs} className="text-sm font-semibold text-rose-800 underline">Retry matching</button> : file ? <button type="button" onClick={analyzeResume} className="text-sm font-semibold text-rose-800 underline">Retry parsing</button> : null}</div>}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {!resume ? (
                <button type="button" disabled={!file || parseLoading || apiStatus === "offline"} onClick={analyzeResume} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-300">
                  {parseLoading ? <><LoaderCircle size={17} className="animate-spin" /> Reading resume…</> : <>Read resume <ArrowRight size={16} /></>}
                </button>
              ) : (
                <button type="button" disabled={matching || apiStatus === "offline"} onClick={findJobs} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-300">
                  {matching ? <><LoaderCircle size={17} className="animate-spin" /> Finding relevant jobs…</> : <><Sparkles size={16} /> Find matching jobs</>}
                </button>
              )}
              {matching && <button type="button" onClick={cancelMatching} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"><X size={16} /> Cancel</button>}
              {apiStatus === "offline" && <span className="text-xs text-rose-600">Start the FastAPI backend to continue.</span>}
            </div>
          </div>

          <aside id="resume-guide" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-center gap-2"><CircleHelp size={17} className="text-indigo-600" /><h2 className="text-sm font-bold text-slate-900">How it works</h2></div>
            <ol className="mt-5 space-y-5">
              <li className="flex gap-3"><StepNumber n="1" /><div><p className="text-sm font-semibold text-slate-800">Upload a PDF</p><p className="mt-1 text-xs leading-5 text-slate-500">We extract the readable text from your resume.</p></div></li>
              <li className="flex gap-3"><StepNumber n="2" /><div><p className="text-sm font-semibold text-slate-800">Compare your experience</p><p className="mt-1 text-xs leading-5 text-slate-500">The matcher scores relevance and skill overlap against the job database.</p></div></li>
              <li className="flex gap-3"><StepNumber n="3" /><div><p className="text-sm font-semibold text-slate-800">Explore your matches</p><p className="mt-1 text-xs leading-5 text-slate-500">Filter, sort, and open the original application listing.</p></div></li>
            </ol>
          </aside>
        </section>

          {(jobs.length > 0 || matching) && (
          <section id="find-jobs" className="mt-12 scroll-mt-24" aria-labelledby="jobs-heading">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-indigo-600">Step 2 · Your matches</p><h2 id="jobs-heading" className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Opportunities that fit</h2><p className="mt-1.5 text-sm text-slate-500">Ranked using semantic relevance and skill overlap.</p></div>
              <p className="rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600">{progress.emitted.toLocaleString()} jobs received</p>
            </div>

            {matching && <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-900" role="status" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-semibold">{matchStage === "starting" ? "Analyzing your resume and preparing job matches…" : jobs.length ? "Loading more jobs · results are provisional until ranking completes" : "Finding matching opportunities…"}</span>
                <span className="text-xs tabular-nums">{progress.processed.toLocaleString()} processed · {progress.emitted.toLocaleString()} emitted{progress.total !== null ? " · " + progress.total.toLocaleString() + " total" : ""}</span>
              </div>
              {progress.total !== null && progress.total > 0 && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-indigo-100" role="progressbar" aria-label="Jobs processed" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.processed}><div className="h-full rounded-full bg-indigo-600 transition-[width] duration-200" style={{ width: Math.min(100, progress.processed / progress.total * 100) + "%" }} /></div>}
            </div>}
            {!matching && (matchStage === "cancelled" || matchStage === "error") && jobs.length > 0 && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{matchStage === "cancelled" ? "Matching cancelled. These partial results are provisional." : "Matching stopped early. These partial results are provisional."}</p>}
            {matchCompleted && <p className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">All {progress.processed.toLocaleString()} jobs processed. Strong matches lead, with similarly scored roles spread across employers.</p>}

            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric icon={<BriefcaseBusiness size={17} />} label={matchCompleted ? "Jobs matched" : "Jobs received"} value={jobs.length.toLocaleString()} />
              <Metric icon={<Sparkles size={17} />} label="Best match" value={summary.best.toFixed(1) + "%"} />
              <Metric icon={<ArrowRight size={17} />} label="Average score" value={summary.average.toFixed(1) + "%"} />
              <Metric icon={<BriefcaseBusiness size={17} />} label="Companies" value={summary.companies.toLocaleString()} />
            </div>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 xl:items-end">
                <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">Search roles</span><span className="relative block"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Title or company" className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" /></span></label>
                <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">Location</span><span className="relative block"><MapPin size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={locationSearch} onChange={(event) => { setLocationSearch(event.target.value); setPage(1); }} placeholder="City or region" className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" /></span></label>
                <div className="sm:col-span-2 lg:col-span-2 xl:col-span-2">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-600" id="required-skills-label">Required Skills</span>
                  <div className="rounded-lg border border-slate-200 bg-white p-2 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100">
                    <div className="flex flex-wrap gap-1.5">
                      {requiredSkills.map((skill) => <span key={normalizeSkill(skill)} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-800">{skill}<button type="button" onClick={() => { setRequiredSkills((current) => current.filter((item) => normalizeSkill(item) !== normalizeSkill(skill))); setPage(1); }} aria-label={`Remove ${skill}`} className="rounded-full p-0.5 hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"><X size={12} /></button></span>)}
                      <input aria-labelledby="required-skills-label" aria-label="Search or enter a required skill" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && skillQuery.trim()) { event.preventDefault(); const entered = skillSuggestions.find((item) => normalizeSkill(item) === normalizeSkill(skillQuery)) ?? skillQuery.trim().replace(/\s+/g, " "); if (!requiredSkills.some((item) => normalizeSkill(item) === normalizeSkill(entered))) setRequiredSkills((current) => [...current, entered]); setSkillQuery(""); setPage(1); } }} placeholder={requiredSkills.length ? "Add another skill" : "Search or enter a skill"} className="h-8 min-w-32 flex-1 border-0 bg-transparent px-2 text-sm outline-none placeholder:text-slate-400 focus:ring-0" />
                      {skillQuery.trim() && <button type="button" onClick={() => { const entered = skillSuggestions.find((item) => normalizeSkill(item) === normalizeSkill(skillQuery)) ?? skillQuery.trim().replace(/\s+/g, " "); if (!requiredSkills.some((item) => normalizeSkill(item) === normalizeSkill(entered))) setRequiredSkills((current) => [...current, entered]); setSkillQuery(""); setPage(1); }} className="rounded-md px-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">Add</button>}
                    </div>
                    {skillSuggestions.length > 0 && <ul aria-label="Available job skills" className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto border-t border-slate-100 pt-2">{skillSuggestions.map((skill) => <li key={normalizeSkill(skill)}><button type="button" onClick={() => { setRequiredSkills((current) => [...current, skill]); setSkillQuery(""); setPage(1); }} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">{skill}</button></li>)}</ul>}
                    <div className="mt-2 flex items-center gap-1 border-t border-slate-100 pt-2" role="group" aria-label="Required skill matching mode"><span className="mr-2 text-[11px] text-slate-500">Match</span><button type="button" aria-pressed={skillMatchMode === "any"} onClick={() => { setSkillMatchMode("any"); setPage(1); }} className={`rounded-md px-2.5 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 ${skillMatchMode === "any" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>Any</button><button type="button" aria-pressed={skillMatchMode === "all"} onClick={() => { setSkillMatchMode("all"); setPage(1); }} className={`rounded-md px-2.5 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 ${skillMatchMode === "all" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>All</button></div>
                  </div>
                </div>
                <label className="flex min-h-10 items-center gap-2 rounded-lg px-1 text-sm text-slate-700"><input type="checkbox" checked={remoteOnly} onChange={(event) => { setRemoteOnly(event.target.checked); setPage(1); }} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" /> Remote only</label>
                <label className="flex min-h-10 items-center gap-2 rounded-lg px-1 text-sm text-slate-700"><input type="checkbox" checked={indiaOnly} onChange={(event) => { setIndiaOnly(event.target.checked); setPage(1); }} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" /> Located in India</label>
                <label className="flex min-h-10 items-center gap-2 rounded-lg px-1 text-sm text-slate-700"><input type="checkbox" checked={remoteIndiaOnly} onChange={(event) => { setRemoteIndiaOnly(event.target.checked); setPage(1); }} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" /> Remote within India</label>
                <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">Role evidence</span><span className="relative block"><select value={roleType} onChange={(event) => { setRoleType(event.target.value as RoleType); setPage(1); }} className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-9 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"><option value="all">All roles</option><option value="ai_ml">AI and machine learning</option><option value="software">Software engineering</option><option value="data">Data roles</option><option value="internship">Internships</option><option value="entry">Entry level and graduate</option></select><ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" /></span></label>
                <label className="block"><span className="flex items-center justify-between text-xs font-semibold text-slate-600"><span>Minimum match</span><span className="text-indigo-700">{minScore}%</span></span><input aria-label={"Minimum match score " + minScore + " percent"} type="range" min="0" max="90" step="5" value={minScore} onChange={(event) => { setMinScore(Number(event.target.value)); setPage(1); }} className="mt-2 block h-5 w-full cursor-pointer accent-indigo-600" /></label>
                <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">Sort by</span><span className="relative block"><select value={sortMode} onChange={(event) => { setSortMode(event.target.value as SortMode); setPage(1); }} className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-9 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"><option value="score-desc">Best match · diverse</option><option value="score-asc">Lowest match first</option><option value="title-asc">Job title A–Z</option></select><ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" /></span></label>
                <button type="button" onClick={clearFilters} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"><FilterX size={15} /> Clear filters</button>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-slate-600"><span className="font-semibold text-slate-900">{filteredJobs.length.toLocaleString()}</span> matching {filteredJobs.length === 1 ? "role" : "roles"}{jobs.length !== filteredJobs.length && <span> · filtered from {jobs.length.toLocaleString()}</span>}</p>
              <p className="text-xs text-slate-500">{sortMode === "score-desc" ? "Close scores are ordered with employer diversity in mind." : "Sorted by the selected field; match scores are unchanged."} · Page {currentPage} of {totalPages}{firstResultMs !== null ? ` · First cards rendered in ${(firstResultMs / 1000).toFixed(2)}s` : ""}</p>
            </div>

            {matching && jobs.length === 0 ? (
              <div className="mt-3 grid gap-4" aria-label="Loading real matching jobs" aria-busy="true"><JobCardSkeleton /><JobCardSkeleton /><JobCardSkeleton /></div>
            ) : pageJobs.length ? (
              <div className="mt-3 grid gap-4">
                {pageJobs.map((job) => {
                  const id = String(job.id);
                  const description = job.description?.trim() || "No description was provided for this listing.";
                  const isExpanded = expandedJobs.has(id);
                  const mode = job.work_mode || ((job.location ?? "").toLocaleLowerCase().includes("remote") ? "Remote" : "");
                  const score = Math.max(0, Math.min(100, job.match_score));
                  return (
                    <article key={id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md sm:p-6">
                      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold tracking-tight text-slate-900">{job.title || "Untitled role"}</h3>{mode && <span className="rounded-full bg-teal-50 px-2.5 py-1 text-[10px] font-semibold text-teal-700">{mode}</span>}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500"><span className="font-medium text-slate-700">{job.company || "Company not listed"}</span>{job.location && <span className="inline-flex items-center gap-1"><MapPin size={13} />{job.location}</span>}{job.source && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{job.source}</span>}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 self-start rounded-xl bg-indigo-50 px-3 py-2.5 sm:self-auto" aria-label={Math.round(score) + "% match"}>
                          <span className="relative flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "conic-gradient(#4f46e5 " + score + "%, #dbe3f2 0)" }}><span className="absolute inset-[4px] rounded-full bg-indigo-50" /><span className="relative text-[10px] font-bold text-indigo-800">{Math.round(score)}%</span></span>
                          <span className="text-xs font-semibold text-indigo-800">Match</span>
                        </div>
                      </div>

                      {Boolean((job.matched_skills && job.matched_skills.length > 0) || (job.missing_skills && job.missing_skills.length > 0)) && (
                        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-slate-100 bg-slate-50/80 p-3 text-xs">
                          {job.matched_skills && job.matched_skills.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="flex items-center gap-1 font-semibold text-emerald-800 shrink-0">
                                <Check size={13} className="text-emerald-600 stroke-[2.5]" /> Strengths:
                              </span>
                              {job.matched_skills.map((skill) => (
                                <span key={skill} className="rounded-md border border-emerald-200/60 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                                  {skill}
                                </span>
                              ))}
                            </div>
                          )}
                          {job.missing_skills && job.missing_skills.length > 0 && (
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/60 pt-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="flex items-center gap-1 font-semibold text-amber-800 shrink-0">
                                  <BrainCircuit size={13} className="text-amber-600" /> Weakness & Growth:
                                </span>
                                {job.missing_skills.map((skill) => (
                                  <span key={skill} className="rounded-md border border-amber-200/80 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                                    {skill}
                                  </span>
                                ))}
                              </div>
                              <a
                                href={`/growth?source=${encodeURIComponent((job.company || "Job") + " (" + (job.title || "Role") + ") - Focus: " + job.missing_skills.slice(0, 3).join(", "))}`}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
                              >
                                <TrendingUp size={12} />
                                <span>Track in Growth</span>
                              </a>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="mt-5 border-t border-slate-100 pt-4">
                        <p id={"description-" + encodeURIComponent(id)} className={"text-sm leading-6 text-slate-600 " + (isExpanded ? "" : "line-clamp-3")}>{description}</p>
                        {description.length > 240 && <button type="button" aria-expanded={isExpanded} aria-controls={"description-" + encodeURIComponent(id)} onClick={() => { toggleDescription(id); if (!isExpanded) void recordJobVisit(job); }} className="mt-1 text-xs font-semibold text-indigo-700 hover:text-indigo-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">{isExpanded ? "Show less" : "Read full description"}</button>}
                        {job.posted_at && <p className="mt-2 text-xs text-slate-400">Posted {formatPostingDate(job.posted_at)}</p>}
                      </div>

                      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" onClick={() => void toggleSavedJob(job)} aria-pressed={savedJobs.some((record) => String(record.job.id) === id)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"><Bookmark size={14} />{savedJobs.some((record) => String(record.job.id) === id) ? "Saved" : "Save job"}</button>
                          <select aria-label={`Track application status for ${job.title ?? "this role"}`} value={applications.find((record) => String(record.job.id) === id)?.status ?? ""} onChange={(event) => void updateApplication(job, event.target.value)} className="h-9 max-w-48 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"><option value="">Track application</option>{APPLICATION_STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}</select>
                          <span className="text-xs text-slate-400">Scores estimate fit from the resume and job details.</span>
                        </div>
                        {job.apply_url ? <a href={job.apply_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-indigo-600 px-4 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Apply now <ArrowRight size={14} /></a> : <span className="text-xs text-slate-400">Application link unavailable</span>}
                      </div>
                    </article>
                  );
                })}
                {matching && Array.from({ length: 3 }, (_, index) => <div key={"skeleton-" + index} aria-hidden="true" className="animate-pulse rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 motion-reduce:animate-none"><div className="flex justify-between gap-5"><div className="flex-1"><div className="h-5 w-2/5 rounded bg-slate-200" /><div className="mt-3 h-3 w-1/3 rounded bg-slate-100" /></div><div className="h-12 w-20 rounded-xl bg-indigo-50" /></div><div className="mt-6 h-3 w-full rounded bg-slate-100" /><div className="mt-2 h-3 w-4/5 rounded bg-slate-100" /></div>)}
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-12 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500"><Search size={21} /></span>
                <h3 className="mt-4 text-base font-semibold text-slate-900">No roles match these filters</h3>
                <p className="mt-1 text-sm text-slate-500">{requiredSkills.length ? `No jobs match the selected required skills (${skillMatchMode === "all" ? "all" : "any"}). Try removing a skill or switching the match mode.` : "Try changing your search or lowering the minimum score."}</p>
                <button type="button" onClick={clearFilters} className="mt-4 text-sm font-semibold text-indigo-700 hover:text-indigo-900">Clear all filters</button>
              </div>
            )}

            {filteredJobs.length > PAGE_SIZE && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-xs text-slate-500">Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredJobs.length)} of {filteredJobs.length.toLocaleString()}</p><div className="flex items-center gap-2"><button type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft size={15} /> Previous</button><span className="min-w-16 text-center text-xs font-medium text-slate-600">{currentPage} / {totalPages}</span><button type="button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40">Next <ChevronRight size={15} /></button></div></div>}
          </section>
        )}

        {resume && matchCompleted && jobs.length === 0 && !matching && !error && <div className="mt-8 rounded-2xl border border-slate-200 bg-white px-5 py-8 text-center"><BriefcaseBusiness size={22} className="mx-auto text-slate-400" /><h2 className="mt-3 font-semibold text-slate-800">No listings returned</h2><p className="mt-1 text-sm text-slate-500">Try matching again in a moment.</p><button type="button" onClick={findJobs} className="mt-4 text-sm font-semibold text-indigo-700">Retry matching</button></div>}
        {matching && jobs.length === 0 && <div className="mt-8 flex items-center justify-center gap-3 rounded-2xl border border-indigo-100 bg-white px-5 py-7 text-sm font-medium text-indigo-800" role="status"><LoaderCircle size={18} className="animate-spin" /> {matchStage === "starting" ? "Analyzing your resume and preparing matching data…" : "Finding matching opportunities…"}</div>}

        <section className="mt-12 grid gap-4 rounded-2xl border border-slate-200 bg-slate-900 px-5 py-6 text-white sm:grid-cols-[1fr_auto] sm:items-center sm:px-7">
          <div><p className="text-sm font-semibold">A more focused job search starts with a clearer match.</p><p className="mt-1 text-xs leading-5 text-slate-300">Compare your skills with the roles that matter to you, then decide where to apply.</p></div>
          <button type="button" onClick={() => fileInput.current?.click()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white px-4 text-xs font-semibold text-slate-900 transition hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"><UploadCloud size={15} /> Choose resume</button>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-10">
          <div className="flex items-center gap-2 font-semibold text-slate-700"><Sparkles size={15} className="text-indigo-600" /> JobSync AI <span className="font-normal text-slate-400">· AI-powered job matching</span></div>
          <p>Match scores are estimates based on resume and listing information; they do not guarantee an outcome.</p>
          <p className="text-slate-400">React · FastAPI · Sentence Transformers</p>
        </div>
      </footer>

      {/* Floating Action Button for Interview Coach */}
      <a
        href="/coach"
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-3 text-xs font-bold text-white shadow-xl shadow-indigo-600/30 hover:scale-105 transition-all border border-white/20 backdrop-blur-sm"
        title="Talk to AI Interview Coach"
      >
        <Sparkles size={15} className="text-amber-300 animate-pulse" />
        <span>AI Interview Coach</span>
      </a>
    </div>
  );
}

function FeatureCard({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <article className="h-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">{icon}</span><h3 className="mt-4 text-sm font-bold text-slate-900">{title}</h3><p className="mt-2 text-xs leading-5 text-slate-600">{text}</p></article>;
}

function HowStep({ number, icon, title, text }: { number: string; icon: ReactNode; title: string; text: string }) {
  return <li className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"><div className="flex items-center justify-between"><span className="text-xs font-bold tracking-[0.16em] text-indigo-300">{number}</span><span className="text-indigo-300">{icon}</span></div><h3 className="mt-5 text-sm font-bold text-white">{title}</h3><p className="mt-2 text-xs leading-5 text-slate-300">{text}</p></li>;
}

function JobCardSkeleton() {
  return <div aria-hidden="true" className="animate-pulse rounded-2xl border border-slate-200 bg-white p-5 shadow-sm motion-reduce:animate-none sm:p-6"><div className="flex justify-between gap-5"><div className="flex-1"><div className="h-5 w-2/5 rounded bg-slate-200" /><div className="mt-3 h-3 w-1/3 rounded bg-slate-100" /></div><div className="h-12 w-20 rounded-xl bg-indigo-50" /></div><div className="mt-6 h-3 w-full rounded bg-slate-100" /><div className="mt-2 h-3 w-4/5 rounded bg-slate-100" /></div>;
}

function StepNumber({ n }: { n: string }) {
  return <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-700">{n}</span>;
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-500">{label}</span><span className="text-indigo-600">{icon}</span></div><p className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{value}</p></div>;
}

function MatchIllustration() {
  return <div className="relative mx-auto hidden w-full max-w-[390px] lg:block" aria-hidden="true">
    <div className="absolute inset-8 rounded-full bg-indigo-100/70 blur-3xl" />
    <div className="relative rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm">
      <div className="flex items-center gap-3 border-b border-slate-200 pb-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm"><FileText size={19} /></span>
        <div className="flex-1 space-y-2"><div className="h-2.5 w-28 rounded bg-slate-300" /><div className="h-2 w-20 rounded bg-slate-200" /></div>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">Resume</span>
      </div>
      <div className="my-5 flex items-center justify-center gap-2.5"><span className="h-px flex-1 bg-indigo-200" /><span className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 text-white shadow-md shadow-indigo-600/20"><Sparkles size={18} /></span><span className="h-px flex-1 bg-indigo-200" /></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold text-slate-700">Experience meets opportunity</p>
        <div className="mt-4 space-y-3"><div className="h-2 w-full rounded bg-indigo-100"><div className="h-2 w-4/5 rounded bg-indigo-500" /></div><div className="h-2 w-3/4 rounded bg-slate-100"><div className="h-2 w-2/3 rounded bg-teal-400" /></div><div className="h-2 w-5/6 rounded bg-slate-100"><div className="h-2 w-1/2 rounded bg-violet-300" /></div></div>
        <p className="mt-4 text-[10px] text-slate-400">Semantic relevance · Skill overlap</p>
      </div>
    </div>
  </div>;
}

