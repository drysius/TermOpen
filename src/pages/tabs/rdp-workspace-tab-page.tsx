import { ChevronDown, Loader2, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getError, supportsProtocol } from "@/functions/common";
import { useT } from "@/langs";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";

interface RdpWorkspaceTabPageProps {
  tabId: string;
  initialSourceId?: string;
}

type RdpViewStatus = "idle" | "connecting" | "ready" | "auth_required" | "error";

const DEFAULT_CAPTURE_WIDTH = 1280;
const DEFAULT_CAPTURE_HEIGHT = 720;
const AUTO_REFRESH_MS = 7000;

function profileIdFromSource(source?: string): string | null {
  if (!source) {
    return null;
  }
  if (source.startsWith("profile:")) {
    return source.slice("profile:".length);
  }
  return source;
}

function formatTimestamp(value: number | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString();
}

export function RdpWorkspaceTabPage({ tabId, initialSourceId }: RdpWorkspaceTabPageProps) {
  const t = useT();
  const connections = useAppStore((state) => state.connections);
  const setWorkspaceBlockCount = useAppStore((state) => state.setWorkspaceBlockCount);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() => profileIdFromSource(initialSourceId));
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [status, setStatus] = useState<RdpViewStatus>("idle");
  const [statusMessage, setStatusMessage] = useState(t.workspace.rdp.waitingFrame);
  const [frameBase64, setFrameBase64] = useState<string | null>(null);
  const [frameWidth, setFrameWidth] = useState<number>(0);
  const [frameHeight, setFrameHeight] = useState<number>(0);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);

  const rdpProfiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "rdp")),
    [connections],
  );
  const selectedProfile = useMemo(
    () => rdpProfiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [rdpProfiles, selectedProfileId],
  );

  const captureFrame = useCallback(
    async (passwordOverride?: string | null) => {
      if (!selectedProfileId) {
        return;
      }

      setStatus("connecting");
      setStatusMessage(t.workspace.rdp.connecting);
      try {
        const result = await api.rdpCapture(selectedProfileId, {
          width: DEFAULT_CAPTURE_WIDTH,
          height: DEFAULT_CAPTURE_HEIGHT,
          passwordOverride: passwordOverride ?? null,
          saveAuthChoice: false,
        });

        if (result.status === "ready") {
          setStatus("ready");
          setStatusMessage(t.workspace.rdp.ready);
          setFrameBase64(result.image_base64);
          setFrameWidth(result.width);
          setFrameHeight(result.height);
          setCapturedAt(result.captured_at);
          return;
        }

        if (result.status === "auth_required") {
          setStatus("auth_required");
          setStatusMessage(result.message || t.workspace.rdp.authRequired);
          return;
        }

        setStatus("error");
        setStatusMessage(result.message || t.workspace.rdp.error);
      } catch (error) {
        setStatus("error");
        setStatusMessage(getError(error));
      }
    },
    [selectedProfileId, t.workspace.rdp.authRequired, t.workspace.rdp.connecting, t.workspace.rdp.error, t.workspace.rdp.ready],
  );

  useEffect(() => {
    if (!selectedProfileId && rdpProfiles.length > 0) {
      setSelectedProfileId(rdpProfiles[0].id);
    }
  }, [rdpProfiles, selectedProfileId]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!profileMenuRef.current) {
        return;
      }
      if (!profileMenuRef.current.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    setWorkspaceBlockCount(tabId, 1);
    return () => setWorkspaceBlockCount(tabId, 0);
  }, [setWorkspaceBlockCount, tabId]);

  useEffect(() => {
    if (!selectedProfileId) {
      return;
    }
    void captureFrame(null);
  }, [captureFrame, selectedProfileId]);

  useEffect(() => {
    if (!autoRefreshEnabled || status !== "ready" || !selectedProfileId) {
      return;
    }
    const timer = window.setInterval(() => {
      void captureFrame(null);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefreshEnabled, captureFrame, selectedProfileId, status]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex h-11 items-center gap-2 border-b border-white/10 px-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="inline-flex h-7 w-7 items-center justify-center rounded border border-cyan-400/40 bg-cyan-500/15 text-cyan-200">
            <Monitor className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{t.workspace.rdp.title}</p>
            <p className="truncate text-[11px] text-zinc-500">{selectedProfile?.name ?? t.workspace.rdp.selectProfile}</p>
          </div>
        </div>

        <div ref={profileMenuRef} className="relative ml-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded border border-white/15 bg-zinc-900 px-2 text-xs text-zinc-100 hover:border-cyan-400/50"
            onClick={() => setProfileMenuOpen((current) => !current)}
          >
            <span className="max-w-[220px] truncate">{selectedProfile?.name ?? t.workspace.rdp.profileLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>
          {profileMenuOpen ? (
            <div className="absolute left-0 top-9 z-[240] w-[320px] max-w-[80vw] rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
              {rdpProfiles.length === 0 ? (
                <p className="px-2 py-2 text-xs text-zinc-400">{t.workspace.rdp.noProfiles}</p>
              ) : (
                rdpProfiles.map((profile) => {
                  const selected = profile.id === selectedProfileId;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      className={cn(
                        "w-full rounded px-2 py-2 text-left text-xs transition",
                        selected
                          ? "border border-cyan-400/60 bg-cyan-500/15 text-cyan-100"
                          : "border border-transparent text-zinc-200 hover:bg-zinc-900",
                      )}
                      onClick={() => {
                        setSelectedProfileId(profile.id);
                        setProfileMenuOpen(false);
                      }}
                    >
                      <p className="truncate font-medium">{profile.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                        {profile.username}@{profile.host}:{profile.port}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className={cn(
              "rounded border px-2 py-1 text-xs transition",
              autoRefreshEnabled
                ? "border-cyan-400/70 bg-cyan-500/15 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.35)]"
                : "border-white/15 text-zinc-300 hover:border-cyan-400/60",
            )}
            onClick={() => setAutoRefreshEnabled((current) => !current)}
          >
            {t.workspace.rdp.autoRefresh}
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded border border-cyan-400/50 bg-cyan-500/15 px-2 text-xs font-medium text-cyan-100 hover:bg-cyan-500/20"
            onClick={() => void captureFrame(null)}
            disabled={!selectedProfileId || status === "connecting"}
          >
            {status === "connecting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t.workspace.rdp.captureNow}
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-zinc-950">
          {frameBase64 ? (
            <img
              className="h-full w-full object-contain"
              src={`data:image/png;base64,${frameBase64}`}
              alt="RDP frame"
              draggable={false}
            />
          ) : null}

          {!selectedProfileId || status !== "ready" || !frameBase64 ? (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/85 px-4">
              <div className="w-full max-w-md rounded-xl border border-cyan-500/30 bg-zinc-900/90 p-4 text-center shadow-[0_0_28px_rgba(34,211,238,0.2)]">
                <p className="text-sm font-semibold text-zinc-100">
                  {!selectedProfileId ? t.workspace.rdp.selectProfile : status === "connecting" ? t.workspace.rdp.connecting : statusMessage}
                </p>
                <p className="mt-1 text-xs text-zinc-400">{t.workspace.rdp.description}</p>

                {status === "auth_required" ? (
                  <div className="mt-3 space-y-2">
                    <input
                      type="password"
                      className="h-9 w-full rounded border border-white/15 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400/70"
                      placeholder={t.workspace.rdp.passwordPlaceholder}
                      value={passwordDraft}
                      onChange={(event) => setPasswordDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="h-9 w-full rounded border border-cyan-400/60 bg-cyan-500/20 text-sm font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-60"
                      disabled={!passwordDraft.trim()}
                      onClick={() => void captureFrame(passwordDraft)}
                    >
                      {t.workspace.rdp.applyPassword}
                    </button>
                  </div>
                ) : null}

                {status === "error" ? (
                  <button
                    type="button"
                    className="mt-3 h-9 w-full rounded border border-white/20 text-sm text-zinc-200 hover:border-cyan-400/60 hover:bg-zinc-900"
                    onClick={() => void captureFrame(null)}
                  >
                    {t.workspace.rdp.retry}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-8 items-center gap-4 border-t border-white/10 px-3 text-[11px] text-zinc-400">
        <span>
          {t.workspace.rdp.lastFrame}: {formatTimestamp(capturedAt)}
        </span>
        <span>
          {t.workspace.rdp.resolution}: {frameWidth > 0 && frameHeight > 0 ? `${frameWidth}x${frameHeight}` : "-"}
        </span>
      </div>
    </div>
  );
}
