import React, { createContext, useContext, useEffect } from 'react';
import type { AppLanguage } from '../types/chess';

let activeLanguage: AppLanguage = 'de';

export function setActiveLanguage(lang: AppLanguage): void {
  activeLanguage = lang === 'en' ? 'en' : 'de';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = activeLanguage;
  }
}

export function getActiveLanguage(): AppLanguage {
  return activeLanguage;
}

export function trStatic(de: string, en: string, lang: AppLanguage = activeLanguage): string {
  return lang === 'en' ? en : de;
}

export function colorLabel(color: 'w' | 'b', lang: AppLanguage = activeLanguage): string {
  if (lang === 'en') {
    return color === 'b' ? 'Black' : 'White';
  }
  return color === 'b' ? 'Schwarz' : 'Weiß';
}

export function turnToMoveLabel(color: 'w' | 'b', lang: AppLanguage = activeLanguage): string {
  if (lang === 'en') {
    return color === 'b' ? 'Black to move' : 'White to move';
  }
  return color === 'b' ? 'Schwarz am Zug' : 'Weiß am Zug';
}

export function sideMovesLabel(color: 'w' | 'b', lang: AppLanguage = activeLanguage): string {
  if (lang === 'en') {
    return color === 'b' ? 'Black moves' : 'White moves';
  }
  return color === 'b' ? 'Schwarz zieht' : 'Weiß zieht';
}

interface I18nContextValue {
  lang: AppLanguage;
  isEn: boolean;
  tr: (de: string, en: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'de',
  isEn: false,
  tr: (de) => de,
});

export const LanguageProvider: React.FC<{ language?: AppLanguage; children: React.ReactNode }> = ({
  language = 'de',
  children,
}) => {
  const safeLang: AppLanguage = language === 'en' ? 'en' : 'de';
  setActiveLanguage(safeLang);

  useEffect(() => {
    setActiveLanguage(safeLang);
  }, [safeLang]);

  const value: I18nContextValue = {
    lang: safeLang,
    isEn: safeLang === 'en',
    tr: (de, en) => (safeLang === 'en' ? en : de),
  };

  return React.createElement(I18nContext.Provider, { value }, children);
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
