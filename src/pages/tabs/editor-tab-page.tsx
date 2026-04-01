import Editor from "@monaco-editor/react";

import { Button } from "@/components/ui/button";
import { formatBytes, type EditorViewMode, toDataUrl } from "@/functions/editor-file-utils";
import { Input } from "@/components/ui/input";
import { useT } from "@/langs";

interface EditorTabPageProps {
  path: string;
  content: string;
  view: EditorViewMode;
  language: string;
  mimeType: string | null;
  mediaBase64: string | null;
  previewError: string | null;
  sizeBytes: number | null;
  onContentChange: (value: string) => void;
  onSave: () => void;
  onOpenExternal: () => void;
}

export function EditorTabPage({
  path,
  content,
  view,
  language,
  mimeType,
  mediaBase64,
  previewError,
  sizeBytes,
  onContentChange,
  onSave,
  onOpenExternal,
}: EditorTabPageProps) {
  const t = useT();
  const canSave = view === "text";
  const previewUrl = mimeType && mediaBase64 ? toDataUrl(mimeType, mediaBase64) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-2 border-b border-white/10 p-2">
        <Input value={path} readOnly />
        <Button onClick={onSave} disabled={!canSave}>
          {t.editor.save}
        </Button>
        <Button variant="outline" onClick={onOpenExternal}>
          {t.editor.openExternal}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {view === "text" ? (
          <Editor
            height="100%"
            theme="vs-dark"
            language={language || "plaintext"}
            value={content}
            onChange={(value) => onContentChange(value ?? "")}
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
        ) : null}

        {view === "image" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-4">
            {previewUrl && !previewError ? (
              <img src={previewUrl} alt={path} className="max-h-full max-w-full object-contain" />
            ) : (
              <p className="text-sm text-zinc-400">
                {previewError ?? t.editor.imageError}
              </p>
            )}
          </div>
        ) : null}

        {view === "video" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-4">
            {previewUrl && !previewError ? (
              <video controls className="max-h-full max-w-full" src={previewUrl} />
            ) : (
              <p className="text-sm text-zinc-400">
                {previewError ?? t.editor.videoError}
              </p>
            )}
          </div>
        ) : null}

        {view === "binary" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-4">
            <p className="text-center text-sm text-zinc-400">
              {t.editor.binaryNoPreview}
              {sizeBytes ? ` ${t.editor.binarySize.replace("{size}", formatBytes(sizeBytes))}` : ""}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
