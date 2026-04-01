import pkg from "../../../package.json";
import { useT } from "@/langs";

const coreDependencies = [
  { name: "Tauri", url: "https://github.com/tauri-apps/tauri" },
  { name: "React", url: "https://github.com/facebook/react" },
  { name: "Zustand", url: "https://github.com/pmndrs/zustand" },
  { name: "React Hook Form", url: "https://github.com/react-hook-form/react-hook-form" },
  { name: "shadcn/ui", url: "https://github.com/shadcn-ui/ui" },
  { name: "Tailwind CSS", url: "https://github.com/tailwindlabs/tailwindcss" },
  { name: "xterm.js", url: "https://github.com/xtermjs/xterm.js" },
  { name: "Monaco Editor", url: "https://github.com/microsoft/monaco-editor" },
  { name: "ssh2 (Rust)", url: "https://github.com/alexcrichton/ssh2-rs" },
  { name: "IronRDP (Rust)", url: "https://github.com/Devolutions/IronRDP" },
];

const recentPackages = [
  { name: "@tauri-apps/plugin-http", url: "https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/http" },
  { name: "tauri-plugin-deep-link", url: "https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/deep-link" },
  { name: "@tauri-apps/plugin-dialog", url: "https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/dialog" },
  { name: "@tauri-apps/plugin-opener", url: "https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/opener" },
];

export function AboutPage() {
  const t = useT();

  return (
    <div className="h-full overflow-auto px-4 py-4">
      <section className="rounded-xl border border-white/10 bg-gradient-to-br from-cyan-500/15 via-zinc-950 to-zinc-950 p-5 shadow-2xl shadow-black/20">
        <h2 className="text-lg font-semibold text-zinc-100">{t.about.title}</h2>
        <p className="mt-2 max-w-3xl text-sm text-zinc-300">{t.about.description}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-white/10 bg-zinc-900/60 px-2 py-1 text-zinc-300">
            {t.about.versionLabel}
            <span className="font-semibold text-zinc-100">{pkg.version}</span>
          </span>
          <span className="rounded-full border border-white/10 bg-zinc-900/60 px-2 py-1 text-zinc-300">{t.about.updatesInfo}</span>
        </div>
      </section>

      <section className="mt-4 grid gap-3 xl:grid-cols-3">
        <article className="rounded-xl border border-white/10 bg-zinc-950/70 p-4 xl:col-span-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{t.about.projectSection}</h3>
          <p className="mt-2 text-sm text-zinc-300">
            {t.about.repoLabel}
            <a
              className="text-cyan-300 hover:text-cyan-200"
              href="https://github.com/drysius/termopen"
              target="_blank"
              rel="noreferrer"
            >
              github.com/drysius/termopen
            </a>
          </p>
        </article>

        <article className="rounded-xl border border-white/10 bg-zinc-950/70 p-4 xl:col-span-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{t.about.newPackagesSection}</h3>
          <p className="mt-2 text-sm text-zinc-400">{t.about.newPackagesDescription}</p>
          <ul className="mt-3 space-y-1 text-sm text-zinc-300">
            {recentPackages.map((item) => (
              <li key={item.name}>
                <a className="text-cyan-300 hover:text-cyan-200" href={item.url} target="_blank" rel="noreferrer">
                  {item.name}
                </a>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="mt-4 rounded-xl border border-white/10 bg-zinc-950/70 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{t.about.projectVisionSection}</h3>
        <div className="mt-2 space-y-2 text-sm text-zinc-300">
          <p>{t.about.projectVisionP1}</p>
          <p>{t.about.projectVisionP2}</p>
          <p>{t.about.projectVisionP3}</p>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-white/10 bg-zinc-950/70 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{t.about.stackSection}</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {coreDependencies.map((item) => (
            <a
              key={item.name}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 transition hover:border-cyan-400/40 hover:text-zinc-100"
            >
              {item.name}
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
