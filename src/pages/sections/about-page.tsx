import pkg from "../../../package.json";
import cargoManifest from "../../../src-tauri/Cargo.toml?raw";
import { ExternalLink, Github, Network, PackageSearch } from "lucide-react";
import { useMemo, useState } from "react";

import { AppDialog } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/langs";
import { api } from "@/lib/tauri";

type DependencyEntry = {
  name: string;
  version: string;
};

function parseCargoDependencyVersion(rawValue: string): string {
  const cleanedValue = rawValue.split("#")[0]?.trim() ?? "";
  if (!cleanedValue) {
    return "-";
  }
  if (cleanedValue.startsWith("\"")) {
    const match = cleanedValue.match(/^"([^"]+)"/);
    return match?.[1] ?? cleanedValue;
  }
  if (cleanedValue.startsWith("{")) {
    const match = cleanedValue.match(/version\s*=\s*"([^"]+)"/);
    return match?.[1] ?? "custom";
  }
  return cleanedValue;
}

function parseCargoDependencies(manifest: string): DependencyEntry[] {
  const dependencies = new Map<string, string>();
  let currentSection = "";

  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentSection = trimmed.slice(1, -1).trim();
      continue;
    }

    const isDependencySection =
      currentSection === "dependencies" ||
      currentSection === "build-dependencies" ||
      currentSection.endsWith(".dependencies");
    if (!isDependencySection) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }

    const name = match[1];
    const rawValue = match[2];

    if (!dependencies.has(name)) {
      dependencies.set(name, parseCargoDependencyVersion(rawValue));
    }
  }

  return Array.from(dependencies.entries())
    .map(([name, version]) => ({ name, version }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function AboutPage() {
  const t = useT();
  const [dependenciesOpen, setDependenciesOpen] = useState(false);
  const frontendDependencies = useMemo(
    () =>
      Object.entries({
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      })
        .map(([name, version]) => ({
          name,
          version: String(version),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [],
  );
  const backendDependencies = useMemo(() => parseCargoDependencies(cargoManifest), []);

  return (
    <div className="flex h-full flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-8 text-center animate-fade-in">
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

        <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4">
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
            <span className="text-foreground">AGPLv3</span>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setDependenciesOpen(true)}
          >
            <PackageSearch className="h-4 w-4" />
            {t.about.dependenciesButton}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void api.openExternalUrl("https://github.com/urubucode/OpenPtl").catch(() => undefined)}
          >
            <Github className="h-4 w-4" />
            {t.about.githubButton}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void api.openExternalUrl("https://openptl.example.com").catch(() => undefined)}
          >
            <ExternalLink className="h-4 w-4" />
            {t.about.docsButton}
          </Button>
        </div>
      </div>

      <AppDialog
        open={dependenciesOpen}
        title={t.about.dependenciesTitle}
        description={t.about.dependenciesDescription}
        onClose={() => setDependenciesOpen(false)}
        footer={
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setDependenciesOpen(false)}>
              {t.app.header.windowClose}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t.about.dependenciesIntro}</p>

          <div className="grid gap-4 md:grid-cols-2">
            <section className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">{t.about.frontendPackagesTitle}</h4>
                <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {frontendDependencies.length}
                </span>
              </div>
              <div className="max-h-72 overflow-auto rounded-md border border-border/40">
                <ul className="divide-y divide-border/30 text-xs">
                  {frontendDependencies.map((dependency) => (
                    <li key={`frontend:${dependency.name}`} className="flex items-center justify-between px-2 py-1.5">
                      <span className="font-medium text-foreground">{dependency.name}</span>
                      <span className="font-mono text-muted-foreground">{dependency.version}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">{t.about.backendPackagesTitle}</h4>
                <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {backendDependencies.length}
                </span>
              </div>
              <div className="max-h-72 overflow-auto rounded-md border border-border/40">
                <ul className="divide-y divide-border/30 text-xs">
                  {backendDependencies.map((dependency) => (
                    <li key={`backend:${dependency.name}`} className="flex items-center justify-between px-2 py-1.5">
                      <span className="font-medium text-foreground">{dependency.name}</span>
                      <span className="font-mono text-muted-foreground">{dependency.version}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}
