import { useState } from 'react';
import type { FunnelDetail } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { PixelEditor } from './PixelForm';

/** Settings > Tracking of a funnel: ad pixels and the consent banner for the whole funnel or for one step. */
export function FunnelTracking({ funnel }: { funnel: FunnelDetail }) {
  const { can } = useAuth();
  const [step, setStep] = useState('');
  return (
    <section className="card stack" aria-label="Tracking and ad pixels">
      <div className="row between">
        <div><h2 style={{ margin: 0 }}>Ad pixels and consent</h2><span className="muted small">Meta, Google, TikTok, LinkedIn and Microsoft tags, generated from IDs.</span></div>
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="px-scope">Applies to</label>
          <select id="px-scope" className="input" value={step} onChange={(e) => setStep(e.target.value)}>
            <option value="">The whole funnel</option>
            {funnel.steps.map((s) => <option key={s.id} value={s.id}>Step: {s.name}</option>)}
          </select>
        </div>
      </div>
      <p className="muted small">{step ? 'A step overrides the funnel for the networks it sets.' : 'Overrides the workspace defaults (Settings > Tracking defaults) for the networks it sets.'}</p>
      <PixelEditor key={step || 'funnel'} funnelId={funnel.id} stepId={step || null} canEdit={can('integrations:manage')} />
    </section>
  );
}

/** Settings > Tracking defaults: pixels and consent that every funnel of the workspace starts with. */
export function WorkspaceTracking() {
  const { can } = useAuth();
  return (
    <section className="card stack" aria-label="Tracking defaults">
      <div><h2 style={{ margin: 0 }}>Tracking defaults</h2><span className="muted small">Pixels and the cookie consent banner that all funnels start with. A funnel or step can override them.</span></div>
      <PixelEditor canEdit={can('integrations:manage')} />
    </section>
  );
}
