import { LogoLockup, Symbol } from "@/components/brand/mark";
import { EmailForm } from "@/components/email-form";
import { CaptureSlot } from "@/components/figures/capture/slot";
import { LockSlot } from "@/components/figures/lock/slot";
import { HeroDemoSlot } from "@/components/hero-demo-slot";
import { SectionHeading } from "@/components/section-heading";
import type { LandingCopy } from "@/content/types";

const tagClass = [
  "top-[16%] left-[8%]",
  "top-[22%] right-[8%]",
  "top-[64%] left-[11%]",
  "top-[70%] right-[9%]",
] as const;

export function LandingPage({ copy }: { copy: LandingCopy }) {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `document.documentElement.lang=${JSON.stringify(copy.lang)}`,
        }}
      />
      <header className="sticky top-0 z-20 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-10 gap-y-3 px-5 py-4 md:min-h-[76px] md:px-16">
          <a href="#inicio" aria-label="nova context" className="text-white">
            <LogoLockup />
          </a>
          <nav className="flex max-w-full flex-wrap gap-x-8 gap-y-2 text-lg text-[#A1A1A1]">
            <a href="#como-funciona" className="hover:text-[#EDEDED]">
              {copy.nav.how}
            </a>
            <a href="#modos" className="hover:text-[#EDEDED]">
              {copy.nav.modes}
            </a>
            <a href="#aprobacion" className="hover:text-[#EDEDED]">
              {copy.nav.approval}
            </a>
            <a href="#que-es" className="hover:text-[#EDEDED]">
              {copy.nav.what}
            </a>
          </nav>
          <a
            href={copy.language.href}
            hrefLang={copy.language.hrefLang}
            lang={copy.language.hrefLang}
            className="font-mono text-sm tracking-[0.08em] text-[#A1A1A1] uppercase hover:text-[#EDEDED] md:ml-auto"
          >
            {copy.language.label}
          </a>
        </div>
      </header>

      <section id="inicio" className="hero">
        <div className="hero-grid" aria-hidden="true" />
        <svg className="hero-grain" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <filter id="grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 1 0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#grain)" />
        </svg>

        <div className="hero-top">
          <p className="font-mono text-base tracking-[0.08em] text-[#A1A1A1] uppercase md:text-lg">{copy.hero.eyebrow}</p>
          <h1 className="hero-title mx-auto mt-5 w-full max-w-[1200px]">
            {copy.hero.title}
            <span className="mt-2 block text-[#8F8F8F]">{copy.hero.titleMuted}</span>
          </h1>
        </div>

        <div className="hero-stage">
          <div className="hero-halo" aria-hidden="true" />
          <div className="hero-star">
            <Symbol variant="hero" className="h-full w-full" />
          </div>
          {copy.hero.tags.map((tag, index) => (
            <span key={tag} className={`hero-tag hidden lg:inline ${tagClass[index]}`}>
              {tag}
            </span>
          ))}
        </div>

        <div className="hero-foot">
          <p className="max-w-3xl text-[1.125rem] leading-relaxed text-[#A1A1A1] md:text-[1.25rem]">{copy.hero.lede}</p>
          <HeroDemoSlot copy={copy.demo} />
          <EmailForm copy={copy.email} />
        </div>
      </section>

      <main className="mx-auto flex max-w-5xl flex-col gap-20 bg-black px-5 py-20">
        <section id="como-funciona" className="flex flex-col gap-6">
          <SectionHeading>{copy.how.title}</SectionHeading>
          <p className="max-w-2xl text-[#A1A1A1]">{copy.how.body}</p>
          <CaptureSlot />
          <div className="grid gap-8 md:grid-cols-3">
            {copy.how.steps.map((step) => (
              <article key={step.title} className="flex flex-col gap-2">
                <h3 className="text-2xl leading-tight font-semibold">{step.title}</h3>
                <p className="text-[#A1A1A1]">{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="modos" className="flex max-w-2xl flex-col gap-4">
          <SectionHeading>{copy.modes.title}</SectionHeading>
          {copy.modes.paragraphs.map((paragraph) => (
            <p key={paragraph} className="text-[#A1A1A1]">
              {paragraph}
            </p>
          ))}
        </section>

        <section id="aprobacion" className="flex flex-col gap-6">
          <SectionHeading>{copy.approval.title}</SectionHeading>
          <p className="max-w-2xl text-[#A1A1A1]">{copy.approval.body}</p>
          <LockSlot />
        </section>

        <section id="que-es" className="flex max-w-2xl flex-col gap-4">
          <SectionHeading>{copy.what.title}</SectionHeading>
          {copy.what.paragraphs.map((paragraph) => (
            <p key={paragraph} className="text-[#A1A1A1]">
              {paragraph}
            </p>
          ))}
        </section>

        <section className="flex max-w-2xl flex-col gap-4 border-t border-white/10 pt-10">
          <SectionHeading>{copy.contact.title}</SectionHeading>
          <p className="text-[#A1A1A1]">{copy.contact.body}</p>
          <EmailForm copy={copy.email} />
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-5 py-6 md:px-16">
          <LogoLockup />
        </div>
      </footer>
    </>
  );
}
