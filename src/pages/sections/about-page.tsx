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
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">Sobre o TermOpen</h2>
        <p className="mt-2 text-sm text-zinc-300">
          Gerenciador desktop de SSH/SFTP com workspace em blocos, vault criptografado e sincronizacao de perfil.
        </p>

        <section className="mt-6 border-t border-white/10 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Projeto</h3>
          <p className="mt-2 text-sm text-zinc-300">Repositorio oficial: <a className="text-purple-300 hover:text-purple-200" href="https://github.com/drysius/termopen" target="_blank" rel="noreferrer">github.com/drysius/termopen</a></p>
          <p className="mt-1 text-sm text-zinc-300">Versao do app: <span className="font-medium text-zinc-100">{pkg.version}</span></p>
          <p className="mt-1 text-sm text-zinc-300">Atualizacoes: verifique releases e commits no GitHub.</p>
        </section>

        <section className="mt-6 border-t border-white/10 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Stack e Bibliotecas</h3>
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
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Google Sync</h3>
          <p className="mt-2 text-sm text-zinc-300">
            O sync usa OAuth Device Flow com escopo <code>drive.file</code>.
          </p>
          <p className="mt-1 text-sm text-zinc-300">
            Configure no ambiente: <code>TERMOPEN_GOOGLE_CLIENT_ID</code> e, se necessario,
            <code> TERMOPEN_GOOGLE_CLIENT_SECRET</code>.
          </p>
        </section>
      </div>
    </div>
  );
}
