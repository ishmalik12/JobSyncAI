import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  BrainCircuit,
  Building2,
  Check,
  Heart,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import type { GrowthItem } from "./PortalPage";

const API = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

export type DebriefSession = {
  id: string;
  title: string;
  company?: string;
  role?: string;
  notes?: string;
  message_count?: number;
  created_at?: string;
  updated_at?: string;
};

export type ExtractedGrowth = {
  title: string;
  category: string;
  reflection: string;
  action_plan: string;
};

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  extracted_growth?: ExtractedGrowth[];
  created_at?: string;
};

export type InterviewMemory = {
  id: string;
  session_id?: string;
  company?: string;
  role?: string;
  weaknesses: string[];
  takeaways?: string;
  created_at?: string;
};



interface InterviewCoachSectionProps {
  token: string;
  onGrowthSaved?: (item: GrowthItem) => void;
  initialCompany?: string;
  initialRole?: string;
}

export default function InterviewCoachSection({
  token,
  onGrowthSaved,
  initialCompany = "",
  initialRole = "",
}: InterviewCoachSectionProps) {
  // Session list & active state
  const [sessions, setSessions] = useState<DebriefSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeSession, setActiveSession] = useState<DebriefSession | null>(null);

  // Input & sending
  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");

  // New debrief session modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [newCompany, setNewCompany] = useState(initialCompany);
  const [newRole, setNewRole] = useState(initialRole);
  const [newNotes, setNewNotes] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);

  // Memories drawer
  const [showMemories, setShowMemories] = useState(false);
  const [memories, setMemories] = useState<InterviewMemory[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);

  // Saved growth items cache to show checkmark
  const [savedGrowthIndices, setSavedGrowthIndices] = useState<Record<string, boolean>>({});

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const headers = useMemo(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token]
  );

  // Scroll to bottom helper
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // 1. Fetch session list on mount
  useEffect(() => {
    if (!token) return;

    const fetchSessions = async () => {
      try {
        const sessionsRes = await fetch(`${API}/interview-coach/sessions`, { headers });

        if (sessionsRes.ok) {
          const list = (await sessionsRes.json()) as DebriefSession[];
          setSessions(list);

          if (list.length > 0) {
            setActiveSessionId(list[0].id);
          } else if (initialCompany || initialRole) {
            // Auto open new session modal if navigated with params
            setShowNewModal(true);
          }
        }
      } catch (err) {
        console.error("Error loading coach data:", err);
      }
    };

    void fetchSessions();
  }, [token, headers, initialCompany, initialRole]);

  // 2. Fetch messages when active session changes
  useEffect(() => {
    if (!activeSessionId || !token) {
      setMessages([]);
      setActiveSession(null);
      return;
    }

    const fetchSessionDetails = async () => {
      setLoadingHistory(true);
      setErrorBanner("");
      try {
        const res = await fetch(`${API}/interview-coach/sessions/${activeSessionId}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setActiveSession(data);
          setMessages(data.messages || []);
          setTimeout(scrollToBottom, 80);
        } else {
          setErrorBanner("Could not load session messages.");
        }
      } catch {
        setErrorBanner("Backend connection error.");
      } finally {
        setLoadingHistory(false);
      }
    };

    void fetchSessionDetails();
  }, [activeSessionId, token, headers]);

  // Scroll down when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, isSending]);

  // Fetch memories on drawer open
  useEffect(() => {
    if (!showMemories || !token) return;
    const fetchMemories = async () => {
      setLoadingMemories(true);
      try {
        const res = await fetch(`${API}/interview-coach/memories`, { headers });
        if (res.ok) {
          setMemories(await res.json());
        }
      } catch (err) {
        console.error("Error fetching memories:", err);
      } finally {
        setLoadingMemories(false);
      }
    };
    void fetchMemories();
  }, [showMemories, token, headers]);

  // Create a new session
  const handleCreateSession = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    setCreatingSession(true);
    setErrorBanner("");

    const title = newCompany.trim()
      ? `Debrief: ${newCompany.trim()}${newRole.trim() ? ` (${newRole.trim()})` : ""}`
      : "Interview Debrief";

    try {
      const res = await fetch(`${API}/interview-coach/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title,
          company: newCompany.trim(),
          role: newRole.trim(),
          notes: newNotes.trim(),
        }),
      });

      if (!res.ok) throw new Error("Could not create debrief session.");

      const newSess = (await res.json()) as DebriefSession;
      setSessions((prev) => [newSess, ...prev]);
      setActiveSessionId(newSess.id);
      setShowNewModal(false);
      setNewCompany("");
      setNewRole("");
      setNewNotes("");

      // Automatically send a warm opening prompt if company was specified
      if (newSess.company) {
        setTimeout(() => {
          void sendOpeningMessage(newSess.id, newSess.company || "", newSess.role || "");
        }, 150);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Session creation failed.");
    } finally {
      setCreatingSession(false);
    }
  };

  // Helper for opening message
  const sendOpeningMessage = async (sessionId: string, company: string, role: string) => {
    setIsSending(true);
    const starterPrompt = `Hi coach, I just had an interview with ${company}${role ? ` for the ${role} role` : ""}. I'd like to share how it went, dissect what was tough, and get your advice!`;

    const userMsg: ChatMessage = {
      role: "user",
      content: starterPrompt,
      created_at: new Date().toISOString(),
    };
    setMessages([userMsg]);

    try {
      const res = await fetch(`${API}/interview-coach/sessions/${sessionId}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: starterPrompt }),
      });

      if (res.ok) {
        const data = await res.json();
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: data.reply,
          model: data.model,
          extracted_growth: data.extracted_growth,
          created_at: new Date().toISOString(),
        };
        setMessages([userMsg, assistantMsg]);
      }
    } catch (err) {
      console.error("Starter message error:", err);
    } finally {
      setIsSending(false);
    }
  };

  // Delete session
  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this interview debrief session?")) return;

    try {
      const res = await fetch(`${API}/interview-coach/sessions/${sessionId}`, {
        method: "DELETE",
        headers,
      });
      if (res.ok) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        setSessions(remaining);
        if (activeSessionId === sessionId) {
          setActiveSessionId(remaining[0]?.id || null);
        }
      }
    } catch {
      setErrorBanner("Could not delete session.");
    }
  };

  // Send message
  const handleSendMessage = async (customPrompt?: string) => {
    const textToSend = (customPrompt || inputText).trim();
    if (!textToSend || isSending) return;

    let targetSessionId = activeSessionId;

    // If no session exists, create one first
    if (!targetSessionId) {
      try {
        const createRes = await fetch(`${API}/interview-coach/sessions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: textToSend.slice(0, 40) + "…",
            company: "",
            role: "",
            notes: "",
          }),
        });
        if (createRes.ok) {
          const newSess = (await createRes.json()) as DebriefSession;
          setSessions((prev) => [newSess, ...prev]);
          setActiveSessionId(newSess.id);
          targetSessionId = newSess.id;
        } else {
          setErrorBanner("Could not start session.");
          return;
        }
      } catch {
        setErrorBanner("Connection error.");
        return;
      }
    }

    const optimisticUserMsg: ChatMessage = {
      role: "user",
      content: textToSend,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticUserMsg]);
    setInputText("");
    setIsSending(true);
    setErrorBanner("");

    try {
      const res = await fetch(`${API}/interview-coach/sessions/${targetSessionId}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: textToSend }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || "Coach was unable to generate a response.");
      }

      const data = await res.json();
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: data.reply,
        model: data.model,
        extracted_growth: data.extracted_growth,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsg]);

      // Update session title in list if changed
      setSessions((prev) =>
        prev.map((s) => (s.id === targetSessionId ? { ...s, message_count: (s.message_count || 0) + 2 } : s))
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setIsSending(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  };

  // Save extracted growth block to tracker
  const handleSaveGrowthBlock = async (item: ExtractedGrowth, messageIndex: number, itemIndex: number) => {
    const key = `${messageIndex}-${itemIndex}`;
    try {
      const res = await fetch(`${API}/interview-coach/save-growth`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: item.title,
          category: item.category,
          reflection: item.reflection,
          action_plan: item.action_plan,
          status: "Identified",
          source: activeSession?.company
            ? `${activeSession.company} Interview Debrief`
            : "Interview Debrief Coach",
        }),
      });

      if (res.ok) {
        const savedItem = (await res.json()) as GrowthItem;
        setSavedGrowthIndices((prev) => ({ ...prev, [key]: true }));
        if (onGrowthSaved) onGrowthSaved(savedItem);
      }
    } catch (err) {
      console.error("Failed to save growth item:", err);
    }
  };

  // Quick Starter Prompts
  const quickChips = [
    {
      label: "🎤 Debrief today's interview",
      prompt: "I just finished an interview today and want to debrief with you. What questions should we start with?",
    },
    {
      label: "🎯 What should I target next?",
      prompt: "Based on all my past interviews and recorded weaknesses, what exact topics or skills should I target for my upcoming interviews?",
    },
    {
      label: "💔 Feeling down after rejection",
      prompt: "I just heard back and got rejected after a tough interview. I'm feeling demoralized and doubting myself. Can you help me process this?",
    },
    {
      label: "🔍 Summarize my recurring weaknesses",
      prompt: "Looking at all the interview debriefs and growth items we've logged so far, what are my biggest recurring blindspots?",
    },
    {
      label: "🧠 Practice questions on my weak areas",
      prompt: "Can you give me 3 practice interview questions targeting the specific technical and behavioral areas I struggled with previously?",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl pb-16">
      {/* Top Banner / Morale Philosophy */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-violet-600 via-indigo-600 to-sky-600 p-6 text-white shadow-xl">
        <div className="absolute -right-8 -top-8 h-44 w-44 rounded-full bg-white/10 blur-2xl pointer-events-none" />
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-0.5 text-xs font-semibold backdrop-blur-md">
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                AI Interview Mentor
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/20 px-2.5 py-0.5 text-[11px] font-medium text-emerald-100 border border-emerald-300/30">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
                Online & Ready
              </span>
            </div>
            <h2 className="text-2xl font-black tracking-tight sm:text-3xl">
              Interview Debrief & Long-term Growth Coach
            </h2>
            <p className="max-w-2xl text-sm text-indigo-100 italic">
              “Everything is a learning until you win. Be patient to achieve big.” Share every detail of your interview—wins, hurdles, and rejections. The coach memorizes your journey so you always know what to target next.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowMemories(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-3.5 py-2 text-xs font-semibold text-white backdrop-blur-md hover:bg-white/25 transition border border-white/20 shadow-sm"
              title="View all past interview memories extracted by the coach"
            >
              <BrainCircuit className="w-4 h-4 text-amber-300" />
              Interview Memories
            </button>
          </div>
        </div>
      </div>

      {/* Main Workspace: Sidebar + Chat Thread */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Sidebar: Sessions */}
        <div className="lg:col-span-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                Debrief Sessions
              </h3>
              <span className="text-xs text-slate-400">({sessions.length})</span>
            </div>
            <button
              onClick={() => setShowNewModal(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700 transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              New Debrief
            </button>
          </div>

          {/* Session List */}
          <div className="mt-3 space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {sessions.length === 0 ? (
              <div className="py-8 text-center text-slate-400 dark:text-slate-500 text-xs">
                <MessageSquarePlus className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No interview debriefs yet.</p>
                <p className="mt-1">Click "+ New Debrief" after your next interview!</p>
              </div>
            ) : (
              sessions.map((sess) => {
                const isSelected = sess.id === activeSessionId;
                return (
                  <div
                    key={sess.id}
                    onClick={() => setActiveSessionId(sess.id)}
                    className={`group relative flex flex-col gap-1 rounded-xl p-3 text-left transition cursor-pointer border ${
                      isSelected
                        ? "border-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-950 dark:text-indigo-100 shadow-sm"
                        : "border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 text-slate-700 dark:text-slate-300 hover:bg-slate-100/80 dark:hover:bg-slate-800/80"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm truncate">
                        {sess.company ? `${sess.company}` : sess.title}
                      </span>
                      <button
                        onClick={(e) => handleDeleteSession(sess.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-500 rounded transition"
                        title="Delete session"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {sess.role && (
                      <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {sess.role}
                      </span>
                    )}

                    <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                      <span>{sess.message_count || 0} messages</span>
                      <span>
                        {sess.updated_at
                          ? new Date(sess.updated_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })
                          : ""}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Quick Philosophy Footer */}
          <div className="mt-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3 text-[11px] text-slate-500 dark:text-slate-400 border border-slate-100 dark:border-slate-800">
            <p className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1">
              <Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500" />
              Continuous Growth
            </p>
            <p className="mt-1">
              Every round you debrief is parsed for weak points and added to your long-term memory so future advice adapts to you.
            </p>
          </div>
        </div>

        {/* Right Area: Active Chat Conversation */}
        <div className="lg:col-span-8 flex flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden min-h-[620px]">
          {/* Header of Active Session */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 px-5 py-3.5 bg-slate-50/70 dark:bg-slate-800/50">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base">
                  {activeSession?.company
                    ? `${activeSession.company} Interview Debrief`
                    : activeSession?.title || "AI Debrief Room"}
                </h3>
                {activeSession?.role && (
                  <span className="rounded-full bg-slate-200 dark:bg-slate-700 px-2.5 py-0.5 text-xs text-slate-700 dark:text-slate-300">
                    {activeSession.role}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Intelligent interview debriefing · Morale support & weakness tracking active
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                AI Coach Active
              </span>
            </div>
          </div>

          {/* Error Banner */}
          {errorBanner && (
            <div className="m-3 flex items-center justify-between rounded-xl bg-rose-50 dark:bg-rose-950/50 p-3 text-xs text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900">
              <span className="flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-rose-500" />
                {errorBanner}
              </span>
              <button onClick={() => setErrorBanner("")} className="hover:opacity-75">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Conversation Stream */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 max-h-[500px]">
            {loadingHistory ? (
              <div className="flex items-center justify-center py-20 text-slate-400 text-sm gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-indigo-500" />
                Loading conversation memory…
              </div>
            ) : messages.length === 0 ? (
              <div className="py-12 text-center max-w-md mx-auto space-y-3">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 dark:bg-indigo-950/80 text-indigo-600 dark:text-indigo-400">
                  <Sparkles className="h-7 w-7" />
                </div>
                <h4 className="font-bold text-slate-800 dark:text-slate-200 text-base">
                  Welcome to your Interview Debrief
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  How did your interview go? Tell me the questions you faced, where you got stuck, or if you received tough feedback. Remember: every round is a step towards winning.
                </p>

                {/* Quick chip suggestions */}
                <div className="pt-2 text-left space-y-1.5">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Quick conversation starters:
                  </p>
                  {quickChips.slice(0, 3).map((chip, idx) => (
                    <button
                      key={idx}
                      onClick={() => void handleSendMessage(chip.prompt)}
                      className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 p-2.5 text-xs text-slate-700 dark:text-slate-300 hover:border-indigo-500 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 transition flex items-center justify-between"
                    >
                      <span>{chip.label}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, mIdx) => {
                const isUser = msg.role === "user";
                return (
                  <div
                    key={mIdx}
                    className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    {!isUser && (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-600 text-white shadow-sm">
                        <Sparkles className="h-4 w-4" />
                      </div>
                    )}

                    <div className={`max-w-[85%] space-y-2 ${isUser ? "items-end" : "items-start"}`}>
                      <div
                        className={`rounded-2xl p-4 sm:p-5 text-sm leading-relaxed ${
                          isUser
                            ? "ai-chat-bubble-user bg-indigo-600 text-white rounded-tr-sm shadow-md"
                            : "ai-chat-bubble-assistant bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-tl-sm border border-slate-200 dark:border-slate-800 shadow-sm"
                        }`}
                      >
                        {isUser ? (
                          <div className="space-y-2 whitespace-pre-wrap">{msg.content}</div>
                        ) : (
                          <FormattedMessage content={msg.content} />
                        )}
                      </div>

                      {/* Render Extracted Growth / Weakness Cards */}
                      {!isUser && msg.extracted_growth && msg.extracted_growth.length > 0 && (
                        <div className="mt-2 space-y-2">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                            <BrainCircuit className="w-3.5 h-3.5" />
                            Extracted Weakness & Growth Points:
                          </p>
                          {msg.extracted_growth.map((growth, gIdx) => {
                            const isSaved = savedGrowthIndices[`${mIdx}-${gIdx}`];
                            return (
                              <div
                                key={gIdx}
                                className="ai-growth-card rounded-xl border border-indigo-200 dark:border-indigo-800/80 bg-indigo-50/70 dark:bg-slate-950 p-4 text-xs text-slate-800 dark:text-slate-100 space-y-2 shadow-xs"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-bold text-indigo-950 dark:text-indigo-200 text-sm">
                                    {growth.title}
                                  </span>
                                  <span className="rounded-full bg-indigo-100 dark:bg-indigo-950 border border-indigo-200 dark:border-indigo-800 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
                                    {growth.category}
                                  </span>
                                </div>
                                <p className="text-slate-700 dark:text-slate-200 leading-relaxed">
                                  <strong className="text-slate-900 dark:text-white font-bold">Reflection:</strong>{" "}
                                  {growth.reflection}
                                </p>
                                <p className="text-slate-700 dark:text-slate-200 leading-relaxed">
                                  <strong className="text-slate-900 dark:text-white font-bold">Action Plan:</strong>{" "}
                                  {growth.action_plan}
                                </p>

                                <div className="pt-1 flex justify-end">
                                  {isSaved ? (
                                    <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-100 dark:bg-emerald-950 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                                      <Check className="w-3.5 h-3.5" />
                                      Saved to Weakness Tracker
                                    </span>
                                  ) : (
                                    <button
                                      onClick={() => handleSaveGrowthBlock(growth, mIdx, gIdx)}
                                      className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 transition shadow-sm"
                                    >
                                      <Plus className="w-3.5 h-3.5" />
                                      Save to Weakness & Growth Tracker
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <span className="text-[10px] text-slate-400 block px-1">
                        {msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                      </span>
                    </div>

                    {isUser && (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold">
                        <User className="h-4 w-4" />
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {isSending && (
              <div className="flex gap-3 justify-start items-center">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-600 text-white shadow-sm">
                  <Sparkles className="h-4 w-4 animate-spin" />
                </div>
                <div className="rounded-2xl bg-slate-100 dark:bg-slate-800 p-3.5 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                  <span className="flex gap-1">
                    <span className="h-2 w-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="h-2 w-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="h-2 w-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  <span>AI Coach is analyzing your interview experience…</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompt Chips above Input */}
          {messages.length > 0 && (
            <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 overflow-x-auto text-xs scrollbar-none">
              <span className="text-[11px] font-semibold text-slate-400 shrink-0">Prompts:</span>
              {quickChips.map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => void handleSendMessage(chip.prompt)}
                  disabled={isSending}
                  className="shrink-0 rounded-full bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-400 px-3 py-1 text-slate-600 dark:text-slate-300 transition text-[11px] font-medium"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}

          {/* Chat Input Bar */}
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendMessage();
              }}
              className="flex items-end gap-2"
            >
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendMessage();
                  }
                }}
                placeholder="Share your interview experience (questions asked, where you felt stuck, feedback)…"
                rows={2}
                className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-3 text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none"
              />
              <button
                type="submit"
                disabled={!inputText.trim() || isSending}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition shadow-sm"
                title="Send debrief message"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
            <p className="mt-2 text-[11px] text-slate-400 flex items-center justify-between">
              <span>Shift + Enter for new line · AI memorizes your lessons for future interview targeting</span>
              <a
                href="/growth"
                className="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold"
              >
                View Weaknesses & Growth Tracker →
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Modal: New Debrief Session */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base">
                  Start New Interview Debrief
                </h3>
              </div>
              <button
                onClick={() => setShowNewModal(false)}
                className="rounded-lg p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateSession} className="mt-4 space-y-3.5">
              <div>
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Company Name (e.g. Google, Stripe, Microsoft)
                </label>
                <input
                  type="text"
                  value={newCompany}
                  onChange={(e) => setNewCompany(e.target.value)}
                  placeholder="e.g. Amazon"
                  className="mt-1 h-10 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 text-sm outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Role or Round (Optional)
                </label>
                <input
                  type="text"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  placeholder="e.g. SDE II / System Design Round"
                  className="mt-1 h-10 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 text-sm outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Initial Notes or Questions (Optional)
                </label>
                <textarea
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="e.g. Got asked 1 LC medium on graphs, and system design for distributed rate limiter..."
                  rows={3}
                  className="mt-1 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-sm outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="rounded-xl px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingSession}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition shadow-sm"
                >
                  {creatingSession ? "Creating…" : "Launch Debrief Room"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Interview Memories Drawer */}
      {showMemories && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <BrainCircuit className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base">
                  All Memorized Interview Experiences
                </h3>
              </div>
              <button
                onClick={() => setShowMemories(false)}
                className="rounded-lg p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              The AI coach references these memories every time you ask what to target, what your recurring weaknesses are, or how to prepare for your next round.
            </p>

            <div className="mt-4 flex-1 overflow-y-auto space-y-3 pr-1">
              {loadingMemories ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-indigo-500" />
                  Loading interview memories…
                </div>
              ) : memories.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  <p>No interview memories recorded yet.</p>
                  <p className="mt-1">
                    Complete your first debrief with the AI Coach to start building your interview memory bank!
                  </p>
                </div>
              ) : (
                memories.map((mem) => (
                  <div
                    key={mem.id}
                    className="rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 p-4 text-xs space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-800 dark:text-slate-200 text-sm">
                        {mem.company || "General Interview"} {mem.role ? `(${mem.role})` : ""}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {mem.created_at ? new Date(mem.created_at).toLocaleDateString() : ""}
                      </span>
                    </div>

                    {mem.weaknesses && mem.weaknesses.length > 0 && (
                      <div>
                        <span className="font-semibold text-rose-600 dark:text-rose-400">
                          Identified Weak Points:
                        </span>
                        <ul className="mt-1 list-disc list-inside space-y-0.5 text-slate-600 dark:text-slate-300">
                          {mem.weaknesses.map((w, wIdx) => (
                            <li key={wIdx}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {mem.takeaways && (
                      <p className="text-slate-500 dark:text-slate-400 italic bg-white dark:bg-slate-900/60 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800">
                        “{mem.takeaways}”
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
              <button
                onClick={() => setShowMemories(false)}
                className="rounded-xl bg-slate-100 dark:bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-200 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// High-Contrast Formatted Markdown Renderer for AI Messages
// -----------------------------------------------------------------------------

function FormattedMessage({ content }: { content: string }) {
  const paragraphs = content.split(/\n\n+/);

  return (
    <div className="space-y-3.5 text-sm leading-relaxed text-slate-800 dark:text-slate-100 font-normal">
      {paragraphs.map((para, pIdx) => {
        const trimmed = para.trim();
        if (!trimmed) return null;

        // Heading check (### or ##)
        if (trimmed.startsWith("###") || trimmed.startsWith("##")) {
          const title = trimmed.replace(/^#+\s*/, "");
          return (
            <h4
              key={pIdx}
              className="text-base sm:text-lg font-bold text-indigo-700 dark:text-indigo-300 pt-1 pb-0.5 tracking-tight flex items-center gap-1.5"
            >
              {title}
            </h4>
          );
        }

        // Philosophy / Motivation Quotes
        if (
          (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
          (trimmed.startsWith('**"') && trimmed.endsWith('"**')) ||
          trimmed.startsWith(">")
        ) {
          const quoteText = trimmed
            .replace(/^>+\s*/, "")
            .replace(/^\*+|\*+$/g, "")
            .replace(/^"+|"+$/g, "");
          return (
            <blockquote
              key={pIdx}
              className="rounded-r-xl border-l-4 border-indigo-500 bg-indigo-50/90 dark:bg-slate-950 p-3.5 my-3 text-xs sm:text-sm font-semibold italic text-indigo-950 dark:text-indigo-200 shadow-xs"
            >
              &ldquo;{quoteText}&rdquo;
            </blockquote>
          );
        }

        // Bullet lists
        if (
          trimmed.includes("\n- ") ||
          trimmed.includes("\n* ") ||
          trimmed.startsWith("- ") ||
          trimmed.startsWith("* ")
        ) {
          const lines = trimmed.split("\n");
          return (
            <ul key={pIdx} className="space-y-2 my-2 list-none pl-0">
              {lines.map((line, lIdx) => {
                const lineTrimmed = line.trim();
                if (!lineTrimmed) return null;
                const isBullet = lineTrimmed.startsWith("- ") || lineTrimmed.startsWith("* ");
                const bulletContent = isBullet
                  ? lineTrimmed.replace(/^[-*]\s*/, "")
                  : lineTrimmed;
                return (
                  <li key={lIdx} className="flex items-start gap-2.5 text-slate-800 dark:text-slate-100">
                    {isBullet && (
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500 dark:bg-indigo-400" />
                    )}
                    <span className="flex-1 leading-relaxed">
                      {parseInlineBold(bulletContent)}
                    </span>
                  </li>
                );
              })}
            </ul>
          );
        }

        // Standard paragraph
        return (
          <p key={pIdx} className="text-slate-800 dark:text-slate-100 leading-relaxed">
            {parseInlineBold(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

function parseInlineBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-extrabold text-slate-950 dark:text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

