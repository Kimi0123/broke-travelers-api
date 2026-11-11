# Golden Test Vectors for Backend Parity

These JSON vector files are generated directly from the Dart domain reference logic in the sibling Flutter repository (`../broke_travelers`), at commit `d2b0672` (branch `phase-4-vectors`).

## Generation Source
Generated via the Dart CLI in the Flutter repository:
```powershell
dart run tool/generate_test_vectors.dart
```

## Schema & Rules
- `schemaVersion`: 1
- `domain`: identifier matching domain logic module under test
- `source`: exact Dart file and symbols ported
- `cases`: array of canonical test scenarios, each with a unique snake_case `name`
- **Integer Paisa Only**: Money amounts are strictly formatted as integer paisa (JSON integers). No floats or doubles exist anywhere in the files.
- **Wall-clock Date Components**: All calendar dates and times are serialized as integer wall-clock components `{ "y": 2026, "m": 11, "d": 5, "h": 0, "mi": 0, "s": 0, "ms": 0 }` to remain immune to machine timezone and daylight saving offsets.
- **Enums**: Formatted as their canonical Dart `.name` string (e.g. `"contribution"`, `"verified"`, `"esewa"`).
- **Rule**: NEVER edit these JSON files by hand; regenerate them in the Flutter repository and copy them here.
