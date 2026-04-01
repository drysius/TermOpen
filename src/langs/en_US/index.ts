import type { AppDictionary } from "../types";
import { app } from "./app";
import { vault } from "./vault";
import { home } from "./home";
import { settings } from "./settings";
import { keychain } from "./keychain";
import { knownHosts } from "./known-hosts";
import { about } from "./about";
import { hostDrawer } from "./host-drawer";
import { workspace } from "./workspace";
import { editor } from "./editor";
import { conflicts } from "./conflicts";
import { toasts } from "./toasts";
import { common } from "./common";

export const enUS: AppDictionary = {
  app,
  sidebar: {
    home: "Home",
    keychain: "Keychain",
    knownHosts: "Known Hosts",
    settings: "Settings",
    about: "About",
  },
  vault,
  home,
  settings,
  keychain,
  knownHosts,
  about,
  hostDrawer,
  workspace,
  editor,
  conflicts,
  toasts,
  common,
};
