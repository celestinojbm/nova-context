import { useState } from "react";
import { CONSENT_POINTS } from "@nova/context-engine";

/**
 * First-run onboarding (M4). Capture and live mode are blocked until the
 * user has read the disclosures and explicitly accepted. Reviewable and
 * resettable from Settings at any time.
 */
export function Onboarding({ onAccept }: { onAccept: () => void }) {
  const [checked, setChecked] = useState(false);

  return (
    <div className="onboarding">
      <h2>Before you start</h2>
      <p className="muted-small">
        Nova Context captures what you choose to keep. Here is exactly how it
        works — please read before using it.
      </p>
      {CONSENT_POINTS.map((point) => (
        <div className="consent-point" key={point.title}>
          <strong>{point.title}</strong>
          <p>{point.body}</p>
        </div>
      ))}
      <label className="consent-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        I understand what Nova captures, what stays temporary, what is stored,
        and the limits of redaction.
      </label>
      <button className="primary" disabled={!checked} onClick={onAccept}>
        Accept and start using Nova
      </button>
      <p className="muted-small">
        You can review or reset this consent anytime under Settings.
      </p>
    </div>
  );
}
