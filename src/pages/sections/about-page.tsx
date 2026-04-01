import { useT } from "@/langs";
import pkg from "../../../package.json";

const dependencies = [
  { name: "Tauri", url: "https://github.com/tauri-apps/tauri" },
  { name: "React", url: "https://github.com/facebook/react" },
  { name: "Zustand", url: "https://github.com/pmndrs/zustand" },
  { name: "React Hook Form", url: "https://github.com/react-hook-form/react-hook-form" },
  { name: "shadcn/ui", url: "https://github.com/shadcn-ui/ui" },
  { name: "Tailwind CSS", url: "https://github.com/tailwindlabs/tailwindcss" },
  { name: "xterm.js", url: "https://github.com/xtermjs/xterm.js" },
  { name: "Monaco Editor", url: "https://github.com/microsoft/monaco-editor" },
  { name: "ssh2 (Rust)", url: "https://github.com/alexcrichton/ssh2-rs" },
];

export function AboutPage() {
  const t = useT();

  return (
    <div className="h-full overflow-auto px-4 py-3">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">{t.about.title}</h2>
        <p className="mt-2 text-sm text-zinc-300">{t.about.description}</p>

        <section className="mt-6 border-t border-white/10 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{t.about.projectSection}</h3>
          <p className="mt-2 text-sm text-zinc-300">
            {t.about.repoLabel}
            <a className="text-purple-300 hover:text-purple-200" href="https://github.com/drysius/termopen" target="_blank" rel="noreferrer">
              github.com/drysius/termopen
            </a>
          </p>
          <p className="mt-1 text-sm text-zinc-300">
            {t.about.versionLabel}<span className="font-medium text-zinc-100">{pkg.version}</span>
          </p>
          <p className="mt-1 text-sm text-zinc-300">{t.about.updatesInfo}</p>
        </section>

        <section className="mt-6 border-t border-white/10 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{t.about.stackSection}</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-300">
            {dependencies.map((item) => (
              <li key={item.name}>
                <a className="text-purple-300 hover:text-purple-200" href={item.url} target="_blank" rel="noreferrer">
                  {item.name}
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6 border-t border-white/10 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{t.about.syncSection}</h3>
          <p className="mt-2 text-sm text-zinc-300">{t.about.syncDescription}</p>
          <p className="mt-1 text-sm text-zinc-300">{t.about.syncConfig}</p>
        </section>
      </div>
    </div>
  );
}
