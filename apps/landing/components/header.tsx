"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { LandingContent } from "../content/types";
import { Mark } from "./mark";

const links = [
  ["product", "#features"],
  ["sdk", "#sdk"],
  ["manifesto", "#manifesto"],
  ["privacy", "#privacy"],
  ["pricing", "#pricing"],
] as const;

function LangSwitch({ content }: { content: LandingContent }) {
  const locale = content.meta.locale;
  const [hash, setHash] = useState("");

  useEffect(() => {
    setHash(window.location.hash);
  }, []);

  return (
    <nav className="lang" aria-label={content.language.label}>
      <a
        href={`/${hash}`}
        hrefLang="en"
        lang="en"
        aria-label={content.language.en}
        aria-current={locale === "en" ? "page" : undefined}
      >
        EN
      </a>
      <a
        href={`/es${hash}`}
        hrefLang="es"
        lang="es"
        aria-label={content.language.es}
        aria-current={locale === "es" ? "page" : undefined}
      >
        ES
      </a>
    </nav>
  );
}

export function Header({ content }: { content: LandingContent }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const home = content.meta.locale === "es" ? "/es" : "/";

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1040px)");
    const onChange = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const background = ["content", "status"]
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (!open) {
      background.forEach((node) => node.removeAttribute("inert"));
      return;
    }
    background.forEach((node) => node.setAttribute("inert", ""));
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const root = menuRef.current;
    const focusable = [
      buttonRef.current,
      ...(root ? Array.from(root.querySelectorAll<HTMLElement>("a, button")) : []),
    ].filter((node): node is HTMLButtonElement | HTMLAnchorElement => node !== null);
    (focusable[1] ?? focusable[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      background.forEach((node) => node.removeAttribute("inert"));
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className="site-header">
      <a className="brand" href={home} aria-label={content.homeAria}>
        <Mark />
        <span>{content.brand}</span>
      </a>
      <nav className="desktop-nav" aria-label={content.navLabel}>
        {links.map(([key, href]) => (
          <a key={key} className="nav-link" href={href}>
            {content.nav[key]}
          </a>
        ))}
      </nav>
      <div className="header-actions">
        <LangSwitch content={content} />
        <a className="btn btn-ghost desktop-only" href="#start">
          {content.actions.signIn}
        </a>
        <a className="btn btn-secondary desktop-only" href="#start">
          {content.actions.start}
        </a>
        <button
          ref={buttonRef}
          className="menu-btn"
          type="button"
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X size={20} strokeWidth={1.5} aria-hidden="true" /> : <Menu size={20} strokeWidth={1.5} aria-hidden="true" />}
          <span className="sr-only">{open ? content.menu.close : content.menu.open}</span>
        </button>
      </div>
      {open ? (
        <div
          ref={menuRef}
          id="site-menu"
          className="mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <p id={titleId} className="sr-only">
            {content.menu.label}
          </p>
          <nav aria-label={content.navLabel}>
            {links.map(([key, href]) => (
              <a key={key} href={href} onClick={close}>
                {content.nav[key]}
              </a>
            ))}
          </nav>
          <div className="menu-lang">
            <p className="eyebrow">{content.language.label}</p>
            <LangSwitch content={content} />
          </div>
          <div className="mobile-cta">
            <a className="btn btn-secondary" href="#start" onClick={close}>
              {content.actions.signIn}
            </a>
            <a className="btn btn-primary" href="#start" onClick={close}>
              {content.actions.start}
            </a>
          </div>
        </div>
      ) : null}
    </header>
  );
}
