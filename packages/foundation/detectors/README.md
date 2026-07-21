# @euroclaw/detectors

PII detectors for euroclaw's redaction port (`Detector` from `@euroclaw/contracts`).
Two implementations of the one port, kept together so it proves itself without a stub:

- **`@euroclaw/detectors/regex`** — a deterministic, synchronous detector for the
  categories a pattern can reach exactly: email, phone, credit card, IBAN/id, IP, URL.
  No network, no scores, offsets are already JavaScript string indices.

- **`@euroclaw/detectors/presidio`** — the Microsoft Presidio analyzer behind the same
  port, for the categories regex cannot reach (names, locations). Async (HTTP `POST
  /analyze`), analyzer-only: the euroclaw redactor already owns the pseudonymization
  map, overlap resolution, and dedup, so this detector only *finds* spans.

Detection is **policy**, never mechanism — `@euroclaw/core` ships the redaction engine
and the neutral `noopDetector`; what counts as PII is opt-in and lives here. Compose
them with `composeDetectors(regexDetector, presidioDetector({ url }))`.

The Presidio integration tests are gated on `PRESIDIO_URL`:

```
docker run -p 5002:3000 mcr.microsoft.com/presidio-analyzer:2.2.358
PRESIDIO_URL=http://localhost:5002 pnpm --filter @euroclaw/detectors test
```
