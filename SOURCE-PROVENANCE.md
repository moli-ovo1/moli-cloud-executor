# Cloud SKIP verification subset

This branch contains only the source files required to build and test the approved Cloud SKIP candidate. It does not include the MCP Gateway, Server plugin, phone panel, or product data. Existing MCP store code appears only because the original Wake authorization module imports it; no MCP capability is enabled in Cloud.

Original shared Core SHA-256: ff1e483c90408d5e35524724312e5d9a29eb20e8d31a8ccda5cacd3573c4a04e. The Core file is byte-identical to the local shared-headless-wake working copy at packaging time. This is a test subset, not a production integration. Recheck current MCP interfaces before any later integration.

The real runtime gate is `node --test tests/cloud-runtime.test.mjs`. It starts Miniflare/workerd with SQLite Durable Objects and real Alarms. Node-only tests cannot substitute for this gate. A passing Linux run does not substitute for a deployed Worker or a real phone test.
