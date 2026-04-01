import Editor from "@monaco-editor/react";
import { FileText, Grip, RefreshCw } from "lucide-react";

import { formatBytes, toDataUrl } from "@/functions/editor-file-utils";

import type { EditorBlock } from "./types";
import type { WorkspaceBlockModule } from "./block-module";

export interface EditorBlockViewProps {
  block: EditorBlock;
  onChange: (value: string) => void;
  onSave: () => void;
  onOpenExternal: () => void;
}


export function EditorBlockView({ block, onChange, onSave, onOpenExternal }: EditorBlockViewProps) {
  const canSave = block.view === "text" && !block.loading;
  const previewUrl = block.mimeType && block.mediaBase64 ? toDataUrl(block.mimeType, block.mediaBase64) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 items-center justify-between border-b border-white/10 px-2">
        <div className="inline-flex items-center gap-2 text-xs text-zinc-400">
          <Grip className="h-3.5 w-3.5" />
          <span className="truncate">{block.path}</span>
          {block.dirty ? <span className="text-cyan-300">*</span> : null}
        </div>
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded border border-white/10 px-2 text-[11px] text-zinc-100 hover:border-cyan-400/60 hover:bg-zinc-900"
            onClick={onSave}
            disabled={!canSave || block.saving}
          >
            {block.saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            Salvar
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded border border-white/10 px-2 text-[11px] text-zinc-100 hover:border-cyan-400/60 hover:bg-zinc-900"
            onClick={onOpenExternal}
          >
            Externo
          </button>
        </div>
      </div>
      {block.view === "text" && (block.loading || block.loadError) ? (
        <div className="border-b border-white/10 px-3 py-2">
          {block.loading ? (
            <>
              <p className="text-[11px] text-cyan-200">Carregando arquivo por streaming... {block.loadProgress}%</p>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-cyan-500/80 transition-all"
                  style={{ width: `${Math.max(2, Math.min(100, block.loadProgress))}%` }}
                />
              </div>
            </>
          ) : null}
          {block.loadError ? <p className="text-[11px] text-red-300">{block.loadError}</p> : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {block.view === "text" ? (
          <Editor
            height="100%"
            theme="vs-dark"
            language={block.language || "plaintext"}
            value={block.content}
            onChange={(value) => onChange(value ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              smoothScrolling: true,
              automaticLayout: true,
              readOnly: block.loading,
            }}
          />
        ) : null}
        {block.view === "image" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-3">
            {previewUrl && !block.previewError ? (
              <img src={previewUrl} alt={block.path} className="max-h-full max-w-full object-contain" />
            ) : (
              <p className="text-sm text-zinc-400">
                {block.previewError ?? "Nao foi possivel carregar o preview da imagem."}
              </p>
            )}
          </div>
        ) : null}
        {block.view === "video" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-3">
            {previewUrl && !block.previewError ? (
              <video controls className="max-h-full max-w-full" src={previewUrl} />
            ) : (
              <p className="text-sm text-zinc-400">
                {block.previewError ?? "Nao foi possivel carregar o preview do video."}
              </p>
            )}
          </div>
        ) : null}
        {block.view === "binary" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-3">
            <p className="text-center text-sm text-zinc-400">
              Arquivo binario sem preview interno.
              {block.sizeBytes ? ` Tamanho: ${formatBytes(block.sizeBytes)}.` : ""}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const editorWorkspaceModule: WorkspaceBlockModule<EditorBlockViewProps> = {
  name: "editor",
  description: "Bloco de edição/preview de arquivos com streaming e salvamento.",
  render: (props) => <EditorBlockView {...props} />,
  onNotFound: ({ blockId, action }) => `Editor não encontrado (${action}) [${blockId}]`,
  onFailureLoad: ({ blockId, action }) => `Falha no editor (${action}) [${blockId}]`,
  onDropDownSelect: ({ blockId, action, value }) => `Editor dropdown (${action}) [${blockId}] => ${value}`,
  onStatusChange: ({ blockId, action, status }) =>
    `Estado do editor atualizado (${action}) [${blockId}] => ${status}`,
};

export default editorWorkspaceModule;

