import type { LandingContent } from "../content/types";
import { Header } from "./header";
import { Hero } from "./hero";
import { MotionRoot, Reveal } from "./motion";
import { Cta, Faq, Features, Footer, How, Pricing, Privacy, Sdk } from "./sections";

export function Landing({ content }: { content: LandingContent }) {
  return (
    <MotionRoot>
      <a className="skip" href="#content">
        {content.skip}
      </a>
      <div className="grain" aria-hidden="true" />
      <Header content={content} />
      <main id="content">
        <Hero content={content} />
        <Reveal>
          <How content={content} />
        </Reveal>
        <Reveal>
          <Features content={content} />
        </Reveal>
        <Reveal>
          <Sdk content={content} />
        </Reveal>
        <Reveal>
          <Privacy content={content} />
        </Reveal>
        <Reveal>
          <Pricing content={content} />
        </Reveal>
        <Reveal>
          <Faq content={content} />
        </Reveal>
        <Reveal>
          <Cta content={content} />
        </Reveal>
      </main>
      <Footer content={content} />
      <noscript>
        <style>{".reveal{opacity:1!important;transform:none!important}"}</style>
      </noscript>
    </MotionRoot>
  );
}
