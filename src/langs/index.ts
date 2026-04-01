import { create } from "zustand";
import type { AppDictionary } from "./types";
import { ptBR } from "./pt_BR";
import { enUS } from "./en_US";

export type Locale = "pt_BR" | "en_US";

const dictionaries: Record<Locale, AppDictionary> = {
  pt_BR: ptBR,
  en_US: enUS,
};

export const LOCALE_LABELS: Record<Locale, string> = {
  pt_BR: "Portugues (BR)",
  en_US: "English (US)",
};

interface I18nState {
  locale: Locale;
  t: AppDictionary;
  setLocale: (locale: Locale) => void;
}

function loadLocale(): Locale {
  const saved = localStorage.getItem("termopen.locale");
  if (saved && saved in dictionaries) return saved as Locale;
  const browserLang = navigator.language;
  if (browserLang.startsWith("pt")) return "pt_BR";
  return "en_US";
}

export const useI18n = create<I18nState>((set) => {
  const initial = loadLocale();
  return {
    locale: initial,
    t: dictionaries[initial],
    setLocale: (locale) => {
      localStorage.setItem("termopen.locale", locale);
      set({ locale, t: dictionaries[locale] });
    },
  };
});

export function useT(): AppDictionary {
  return useI18n((s) => s.t);
}

/** Non-hook accessor for use outside React components (store actions, utils). */
export function getT(): AppDictionary {
  return useI18n.getState().t;
}

export type { AppDictionary };
