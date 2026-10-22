import {
  Brain,
  Camera,
  Check,
  Clock,
  CodeXml,
  Eye,
  Link2,
  LockKeyhole,
  Network,
  Plug,
  Shield,
} from "lucide-react";
import type { LandingContent } from "../content/types";
import { GridLights } from "./grid-lights";
import { Mark } from "./mark";
import { SdkPanel } from "./sdk-panel";

const howIcons = [Camera, Brain, Link2, Plug];
const featureIcons = [LockKeyhole, Eye, Network, CodeXml, Clock, Shield];

function IconBox({ icon: Icon }: { icon: typeof Camera }) {
  return (
    <span className="icon-box" aria-hidden="true">
      <Icon size={20} strokeWidth={1.5} />
    </span>
  );
}

function Head({
  index,
  eyebrow,
  lines,
  title,
  lede,
  ledeId,
  badge,
}: {
  index?: string;
  eyebrow: string;
  lines?: readonly [string, string];
  title?: string;
  lede: string;
  ledeId?: string;
  badge?: string;
}) {
  return (
    <header className="section-head">
      <p className="eyebrow-row">
        <span className="eyebrow">
          {index ? `${index} · ` : ""}
          {eyebrow}
        </span>
        {badge ? <span className="placeholder-badge">{badge}</span> : null}
      </p>
      <h2>
        {lines ? (
          lines.map((line) => <span key={line}>{line}</span>)
        ) : (
          <span>{title}</span>
        )}
      </h2>
      <p className="lede" id={ledeId}>
        {lede}
      </p>
    </header>
  );
}

export function How({ content }: { content: LandingContent }) {
  const { how } = content;
  return (
    <section className="section" id="how">
      <div className="wrap">
        <Head index={how.index} eyebrow={how.eyebrow} lines={how.lines} lede={how.lede} />
        <div className="panel">
          <div className="how-steps">
            {how.steps.map((step, index) => {
              const Icon = howIcons[index] ?? Camera;
              return (
                <article key={step.title} className="how-step">
                  <div className="how-step-top">
                    <IconBox icon={Icon} />
                    <span className="step-num">{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </article>
              );
            })}
          </div>
          <div className="how-foot">
            <p>
              <span aria-hidden="true">&gt; </span>
              {how.pipeline}
            </p>
            <p className="metric">
              <span className="placeholder-badge">{how.metricNote}</span>
              <span>{how.metric}</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Features({ content }: { content: LandingContent }) {
  const { features } = content;
  return (
    <section className="section" id="features">
      <div className="wrap">
        <Head
          index={features.index}
          eyebrow={features.eyebrow}
          lines={features.lines}
          lede={features.lede}
        />
        <div className="feature-grid">
          {features.items.map((item, index) => {
            const Icon = featureIcons[index] ?? Eye;
            return (
              <article key={item.title} className="feature">
                <IconBox icon={Icon} />
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function Sdk({ content }: { content: LandingContent }) {
  const { sdk } = content;
  return (
    <section className="section" id="sdk">
      <div className="wrap">
        <Head index={sdk.index} eyebrow={sdk.eyebrow} title={sdk.title} lede={sdk.lede} />
        <SdkPanel content={content} />
      </div>
    </section>
  );
}

export function Privacy({ content }: { content: LandingContent }) {
  const { privacy } = content;
  return (
    <section className="section" id="privacy">
      <div className="wrap">
        <div id="manifesto" />
        <Head
          index={privacy.index}
          eyebrow={privacy.eyebrow}
          title={privacy.title}
          lede={privacy.lede}
        />
        <dl className="privacy-table">
          {privacy.rows.map((row) => (
            <div key={row.label} className="privacy-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function Pricing({ content }: { content: LandingContent }) {
  const { pricing } = content;
  return (
    <section className="section" id="pricing" aria-describedby="pricing-note">
      <div className="wrap">
        <Head
          eyebrow={pricing.eyebrow}
          lines={pricing.lines}
          lede={pricing.note}
          ledeId="pricing-note"
          badge={pricing.badge}
        />
        <div className="plan-grid">
          {pricing.plans.map((plan) => (
            <article key={plan.name} className="plan" data-placeholder="true">
              <div className="plan-top">
                <h3>{plan.name}</h3>
                {plan.recommended ? <span className="recommend">{plan.recommended}</span> : <span />}
              </div>
              <p className="price-row">
                <span className="sr-only">{pricing.badge}. </span>
                <span className="price">{plan.price}</span>
                <span className="period">{plan.period}</span>
              </p>
              <a
                className={`btn btn-${plan.variant}`}
                href="#start"
                aria-describedby="pricing-note"
              >
                {plan.cta}
              </a>
              <ul>
                {plan.items.map((item) => (
                  <li key={item}>
                    <Check size={16} strokeWidth={1.5} aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Faq({ content }: { content: LandingContent }) {
  const { faq } = content;
  return (
    <section className="section" id="faq">
      <div className="wrap narrow-wrap">
        <Head index={faq.index} eyebrow={faq.eyebrow} title={faq.title} lede={faq.lede} />
        <div className="faq">
          {faq.items.map((item) => (
            <details key={item.q} className="faq-item" open={item.open}>
              <summary>
                <span>{item.q}</span>
                <span className="pm" aria-hidden="true" />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Cta({ content }: { content: LandingContent }) {
  const { cta, actions } = content;
  return (
    <section className="cta" id="start">
      <div className="grid-bg" aria-hidden="true">
        <GridLights />
      </div>
      <div className="wrap cta-inner">
        <h2>{cta.title}</h2>
        <p className="lede">{cta.lede}</p>
        <div className="hero-actions">
          <a className="btn btn-primary" href="#pricing">
            {actions.createAccount}
          </a>
          <a className="btn btn-secondary" href="#manifesto">
            {actions.readManifesto}
          </a>
        </div>
      </div>
    </section>
  );
}

export function Footer({ content }: { content: LandingContent }) {
  const { footer } = content;
  const home = content.meta.locale === "es" ? "/es" : "/";
  const columns = [
    {
      title: footer.product,
      links: [
        [footer.links.capture, "#how"],
        [footer.links.sdk, "#sdk"],
        [footer.links.pricing, "#pricing"],
      ],
    },
    {
      title: footer.resources,
      links: [
        [footer.links.manifesto, "#manifesto"],
        [footer.links.docs, "#sdk"],
        [footer.links.status, "#status"],
      ],
    },
    {
      title: footer.privacy,
      links: [
        [footer.links.export, "#privacy"],
        [footer.links.erase, "#privacy"],
        [footer.links.policy, "#privacy"],
      ],
    },
  ] as const;

  return (
    <footer className="site-footer" id="status">
      <div className="wrap footer-grid">
        <div className="footer-brand">
          <a className="brand" href={home} aria-label={content.homeAria}>
            <Mark />
            <span>{content.brand}</span>
          </a>
          <p>{footer.tagline}</p>
        </div>
        {columns.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <p className="eyebrow">{column.title}</p>
            <ul>
              {column.links.map(([label, href]) => (
                <li key={label}>
                  <a href={href}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
    </footer>
  );
}
