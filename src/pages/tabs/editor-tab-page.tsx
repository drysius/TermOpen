import Editor from "@monaco-editor/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface EditorTabPageProps {
  path: string;
  content: string;
  onContentChange: (value: string) => void;
  onSave: () => void;
  onOpenExternal: () => void;
}

export function EditorTabPage({
  path,
  content,
  onContentChange,
  onSave,
  onOpenExternal,
}: EditorTabPageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-2 border-b border-white/10 p-2">
        <Input value={path} readOnly />
        <Button onClick={onSave}>Salvar</Button>
        <Button variant="outline" onClick={onOpenExternal}>
          Abrir Externo
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          theme="vs-dark"
          language="plaintext"
          value={content}
          onChange={(value) => onContentChange(value ?? "")}
          options={{ minimap: { enabled: false }, fontSize: 13 }}
        />
      </div>
    </div>
  );
}
