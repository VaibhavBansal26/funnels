export interface FunnelRow {
  id: string;
  workspace_id: string;
  name: string;
  base_path: string;
  domain_id: string | null;
  status: 'live' | 'test';
  favicon: string | null;
  header_tracking_code: string | null;
  footer_tracking_code: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StepRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  name: string;
  base_path: string;
  path_key: string;
  position: number;
  title: string | null;
  seo_description: string | null;
  custom_css: string | null;
  header_tracking_code: string | null;
  footer_tracking_code: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  step_id: string;
  workspace_id: string;
  funnel_id: string;
  doc_json: string;
  html: string;
  checksum: string;
  scripts_ok: number;
  updated_at: string;
}

export interface BackupRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  step_id: string;
  version: number;
  label: string;
  doc_json: string;
  html: string;
  checksum: string;
  created_by: string | null;
  created_at: string;
}

export interface DomainRow {
  id: string;
  workspace_id: string;
  hostname: string;
  status: 'pending' | 'active' | 'failed';
  verification_token: string;
  failure_reason: string | null;
  default_home_step_id: string | null;
  default_404_step_id: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TagRow {
  id: string;
  workspace_id: string;
  name: string;
  name_lower: string;
  created_at: string;
}
