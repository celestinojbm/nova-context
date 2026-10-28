"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LandingContent } from "../content/types";

function highlight(code: string) {
  const parts = code.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g);
  return parts.map((part, index) =>
    part.startsWith('"') || part.startsWith("'") ? (
      <span key={index} className="tok-s">
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function tokens(text: string, count: number) {
  const parts = text.split(/("(?:[^"\\]|\\.)*")/g);
  const nodes: { text: string; string: boolean; key: number }[] = [];
  let seen = 0;
  parts.forEach((part, index) => {
    if (seen >= count || part.length === 0) return;
    const slice = part.slice(0, count - seen);
    seen += slice.length;
    nodes.push({ text: slice, string: part.startsWith('"'), key: index });
  });
  return nodes;
}

export function SdkPanel({ content }: { content: LandingContent }) {
  const { sdk, actions } = content;
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const [count, setCount] = useState(sdk.response.length);
  const outRef = useRef<HTMLPreElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = outRef.current;
    if (!node) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const rect = node.getBoundingClientRect();
    const alreadyVisible = rect.top < window.innerHeight * 0.92 && rect.bottom > 0;
    if (alreadyVisible) return;

    setCount(0);
    let timer = 0;
    let index = 0;
    const text = sdk.response;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        timer = window.setInterval(() => {
          index += 2;
          setCount(Math.min(index, text.length));
          if (index >= text.length) window.clearInterval(timer);
        }, 24);
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [sdk.response]);

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = sdk.tabs.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowRight"
            ? (index + 1) % sdk.tabs.length
            : (index - 1 + sdk.tabs.length) % sdk.tabs.length;
    setTab(next);
    document.getElementById(`sdk-tab-${sdk.tabs[next]?.id}`)?.focus();
  };

  const onCopy = async () => {
    const text = sdk.tabs[tab]?.code ?? "";
    const write = navigator.clipboard?.writeText(text);
    try {
      await Promise.race([
        write ?? Promise.reject(new Error("clipboard")),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("clipboard")), 400)),
      ]);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const active = sdk.tabs[tab];

  return (
    <div className="sdk-card">
      <div className="sdk-code">
        <div className="sdk-toolbar">
          <div role="tablist" aria-label={sdk.tabsLabel}>
            {sdk.tabs.map((item, index) => (
              <button
                key={item.id}
                id={`sdk-tab-${item.id}`}
                role="tab"
                type="button"
                className={tab === index ? "tab is-on" : "tab"}
                aria-selected={tab === index}
                aria-controls={`sdk-panel-${item.id}`}
                tabIndex={tab === index ? 0 : -1}
                onClick={() => setTab(index)}
                onKeyDown={(event) => onKey(event, index)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary copy-btn" type="button" onClick={onCopy}>
            {copied ? (
              <Check size={16} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
            )}
            <span ref={liveRef} aria-live="polite">
              {copied ? actions.copied : actions.copy}
            </span>
          </button>
        </div>
        {sdk.tabs.map((item, index) => (
          <div
            key={item.id}
            role="tabpanel"
            id={`sdk-panel-${item.id}`}
            aria-labelledby={`sdk-tab-${item.id}`}
            hidden={tab !== index}
          >
            <pre>
              <code>{highlight(item.code)}</code>
            </pre>
          </div>
        ))}
      </div>
      <div className="sdk-out">
        <div className="sdk-out-head">
          <span className="placeholder-badge">{sdk.example}</span>
          <p className="eyebrow">{sdk.responseLabel}</p>
        </div>
        <p className="sr-only">{sdk.response}</p>
        <pre ref={outRef} aria-hidden="true">
          <code>
            {count >= sdk.response.length
              ? highlight(sdk.response)
              : tokens(sdk.response, count).map((part) =>
                  part.string ? (
                    <span key={part.key} className="tok-s">
                      {part.text}
                    </span>
                  ) : (
                    <span key={part.key}>{part.text}</span>
                  ),
                )}
            {count < sdk.response.length ? <span className="caret" /> : null}
          </code>
        </pre>
        <p className="sr-only">{active?.label}</p>
      </div>
    </div>
  );
}
