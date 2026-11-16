# Raw DX log (evidence feed for FELTKIT_EXPERIENCE.md)
- [component] principal id "payments-gateway" accepted by `feltkit codegen`, refused only at ComponentHost.start ("neither component:payments nor an app.agent principal"). Error message excellent; validation late. COMPONENTS.md says refused "at definition, build and start" — definition (codegen/load) did NOT refuse.
- [integration] app.integration sends JSON only (runtime/integrations.js:288). Stripe API is form-encoded → cannot use app.integration for Stripe.
- [inbound webhooks] services.webhooks.inbound verifies AppPort's own x-appport-signature scheme only. Stripe-Signature (t=,v1=) not supported → provider events go through a component; AppPort's inbound event lifecycle (processing/failed/dead, replay) can't be reused.
- [tenancy] tenant-scoped collections closed to calls without tenant; no system/operator cross-tenant reader → billing state uses explicit accountId.
- [schedules] no ctx.services.schedules and no code-declared schedule; schedules run as the person who created them → lifecycle clock lives in the component.
- [intent] FeltDB "Intent" (@feltdb/core intent.d.ts) is NL→module implementation planning, not durable workflows.
- [deps] FeltKit 0.3.30 pins @appport/sdk 1.8.1 (latest 1.9.0), authorization 1.1.1 (1.2.0), server 1.3.2 (1.3.3), mcp 1.3.8 (1.3.9). Not overridable without violating FeltKit's no-overrides release check.
