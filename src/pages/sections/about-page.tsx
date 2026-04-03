import pkg from "../../../package.json";
import { ExternalLink, Github, Network } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/langs";

export function AboutPage() {
  const t = useT();

  return (
    <div className="flex-1 p-6 flex items-center justify-center">
      <div className="max-w-md text-center space-y-8 animate-fade-in">
        <div className="flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10 glow-md">
            <Network className="h-10 w-10 text-primary" />
          </div>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">{t.app.name}</h1>
          <p className="text-muted-foreground text-sm">{t.about.description}</p>
          <p className="text-xs text-muted-foreground/60 font-mono">
            {t.about.versionLabel}: {pkg.version}
          </p>
        </div>

        <div className="rounded-xl border border-border/60 bg-card p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t.about.protocolsLabel}</span>
            <span className="text-foreground">SSH, SFTP, SMB, FTP, FTPS, RDP</span>
          </div>
          <div className="border-t border-border/30" />
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t.about.frameworkLabel}</span>
            <span className="text-foreground">Tauri + React</span>
          </div>
          <div className="border-t border-border/30" />
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t.about.licenseLabel}</span>
            <span className="text-foreground">MIT</span>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" className="gap-2" onClick={() => window.open("https://github.com/UrubuCode/TermOpen", "_blank")}>
            <Github className="h-4 w-4" />
            {t.about.githubButton}
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => window.open("https://tauri.app", "_blank")}>
            <ExternalLink className="h-4 w-4" />
            {t.about.docsButton}
          </Button>
        </div>
      </div>
    </div>
  );
}
