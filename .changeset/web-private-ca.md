---
"@e2e-dev/web": patch
---

Honor `AGENT_BROWSER_CA_CERT`, `AGENT_BROWSER_PROXY`, and `AGENT_BROWSER_PROXY_BYPASS` on locally launched browsers. The CA file becomes the launch's trust anchor: Linux imports it into the isolated NSS store, macOS adds its public-key hashes to Chromium's SPKI allow list. Certificate and hostname checks stay enabled, and no certificate errors are ignored globally.
