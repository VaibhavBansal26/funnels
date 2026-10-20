# Cloudflare WAF rate limiting rules for the Funnels zone (docs/CLOUDFLARE.md). Review limits against your plan.
# terraform init && terraform apply -var zone_id=... -var app_host=app.example.com
variable "zone_id" { type = string }
variable "app_host" { type = string }

resource "cloudflare_ruleset" "funnels_rate_limits" {
  zone_id = var.zone_id
  name    = "funnels-rate-limits"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    description = "event beacon flood"
    expression  = "http.request.method eq \"POST\" and starts_with(http.request.uri.path, \"/api/public/events\")"
    action      = "block"
    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = 100
      mitigation_timeout  = 60
    }
  }

  rules {
    description = "form and checkout posts"
    expression  = "http.request.method eq \"POST\" and (starts_with(http.request.uri.path, \"/api/public/forms/\") or starts_with(http.request.uri.path, \"/api/public/checkout/\"))"
    action      = "managed_challenge"
    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 20
      mitigation_timeout  = 600
    }
  }

  rules {
    description = "auth endpoints"
    expression  = "http.host eq \"${var.app_host}\" and starts_with(http.request.uri.path, \"/api/auth/\")"
    action      = "block"
    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 10
      mitigation_timeout  = 600
    }
  }
}

resource "cloudflare_ruleset" "funnels_block_internal" {
  zone_id = var.zone_id
  name    = "funnels-block-internal"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules {
    description = "/internal is for the Worker only"
    expression  = "starts_with(http.request.uri.path, \"/internal/\")"
    action      = "block"
  }
}
