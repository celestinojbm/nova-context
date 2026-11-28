"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import ScrollReveal from "./react-bits/ScrollReveal";
import { landingCopy, type LandingLang } from "./copy";
import "./landing.css";

const DemoWidgets = dynamic(() => import("./DemoWidgets"), {
  ssr: false,
  loading: () => <div className="landing-slots" aria-hidden="true" />,
});

export function LandingPage() {
  const [lang, setLang] = useState<LandingLang>("en");
  const copy = landingCopy[lang];

  useEffect(() => {
    document.documentElement.lang = lang === "es" ? "es" : "en";
    return () => {
      document.documentElement.lang = "en";
    };
  }, [lang]);

  return (
    <div className="landing">
      <div className="landing-hero">
        <div className="landing-wrap">
          <h1>
            <span className="landing-h1-line">{copy.h1Lead}</span>
            <span className="landing-h1-line">{copy.h1Rest}</span>
          </h1>
          <p className="landing-lede">{copy.lede}</p>
          <div className="landing-actions">
            <a className="landing-cta" href="/login">
              {copy.signIn}
            </a>
            <div className="landing-lang" role="group" aria-label={lang === "es" ? "Idioma" : "Language"}>
              <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>
                EN
              </button>
              <button type="button" aria-pressed={lang === "es"} onClick={() => setLang("es")}>
                ES
              </button>
            </div>
          </div>
          <section className="landing-demo" aria-label={copy.demoLabel}>
            <p className="landing-demo-label">{copy.demoLabel}</p>
            <DemoWidgets key={lang} copy={copy} />
            <p className="landing-note">{copy.demoNote}</p>
          </section>
        </div>
      </div>
      {copy.sections.map((section) => (
        <section className="landing-section" key={section.title}>
          <div className="landing-wrap">
            <ScrollReveal
              key={`${lang}-${section.title}`}
              enableBlur={false}
              baseRotation={0}
              baseOffset={0}
              baseOpacity={0.25}
              effect="fade"
              mode="enter"
              duration={0.6}
              stagger={0.035}
              containerClassName="landing-reveal"
              textClassName="landing-reveal-text"
            >
              {section.title}
            </ScrollReveal>
            <p>{section.body}</p>
          </div>
        </section>
      ))}
      <footer className="landing-foot">
        <p>{copy.license}</p>
      </footer>
    </div>
  );
}
