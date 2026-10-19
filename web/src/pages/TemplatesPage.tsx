import { TemplateGallery } from '../components/TemplateGallery';

export function TemplatesPage() {
  return (
    <div className="stack">
      <h1>Templates</h1>
      <p className="muted">Start from a proven funnel. Using a template copies it into your workspace as a test funnel you can edit freely.</p>
      <TemplateGallery />
    </div>
  );
}
