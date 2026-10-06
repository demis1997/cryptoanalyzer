# Portfolio validation — 7 October 2026

Inspected revision: master at the start of this portfolio update; no application behavior changed.

- Node.js 22.20.0, macOS ARM. `npm ci --ignore-scripts` completed using a writable local cache; Chromium/native model install hooks were deliberately skipped.
- `node --check server.js`: passed.
- `node scripts/test-pool-scoring.mjs`: passed. One synthetic vault, curated_vault, 86.8/100, seven scored criteria, 67% weight applied. This score is a test output, not measured predictive accuracy.
- `node scripts/test-pool-metrics-resolver.mjs`: passed its six assertions: crawled TVL selection, source label, protocol API priority, API amount, retained search candidate, and subgraph preference (the script prints six OK messages). It disables web/Dune search; protocol/on-chain helpers may still attempt public data requests. It is not a fully network-isolated unit test and is not in the offline CI.
- Actual Express startup on port 3102 and `/api/health`: passed with hosted/website/risk/pool model flags disabled. No provider credentials or paid requests used.
- Real workbench screenshot: captured using Docker Playwright at desktop 1440×1000 with requests restricted to the running local app. No analysis submitted; default graph is illustrative. Host Chromium capture failed due to version/sandbox restrictions; Docker capture succeeded.
- External protocol/URL/accuracy/subgraph suites, GPT4All inference, hosted inference, PDF rendering, Neo4j and PostgreSQL: not executed.
- Existing demo URL `https://cryptoanalyzer-five.vercel.app`: HTTP 404 / DEPLOYMENT_NOT_FOUND. Not advertised as a demo.

The CI added by this PR runs server/UI/scorer syntax and the existing dependency-free scoring fixture, with no npm installation or model credentials. Its actual result is visible on the draft PR; no green outcome is assumed in advance.
