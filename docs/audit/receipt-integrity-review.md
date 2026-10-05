# PR #7 follow-up review — 5 October 2026

N1: Native and MCP rescans can fill unknown-provenance null prices, blank descriptions and blank initial placeholders. Existing populated manual values and explicit user provenance remain protected, as do cost allocations and quantities. Missing-price warnings are generated from the resulting fields. Tests cover both recognition paths, explicit zero/blank confirmations and retained legacy manual values.

N7: Streaming bounds distinguish raw completed text (1 MB), its JSON-escaped event (worst-case sixfold escape expansion plus envelope), and overall transport (36,098,304 bytes after the F3 follow-up). A valid structured receipt with a completed event exceeding 1 MB succeeds; malformed and oversized output/event/stream cases still fail without changing saved records.

PR5 auth and PR6 scoped receipt/OAuth/ownership fixes are integrated. Earlier N1/N7 validation: 980 tests passed; TypeScript, production build and lint pass (four existing warnings). All accounts/provider responses are synthetic. No paid model call, production write, deployment or merge into main was performed.

## F6 and integrated follow-ups

MCP recognition now agrees with native recognition: a blank price placeholder has an empty name, zero amount, no quantity and no source evidence. A meaningful untagged legacy zero retains its price/provenance; null unknown values remain fillable and explicit user confirmation stays protected. The other scoped-save, fingerprint, streaming, owner-CLI, identity and test-harness fixes are integrated. PR7 full verification passes 1,010 tests, types and lint (zero errors/four existing warnings), with no paid model call.
