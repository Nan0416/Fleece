# viz

Python renderers for the JSON the `@fleece/playground` scripts write. They read a file
and draw it; they never call a provider. Fetching is TypeScript's job, so the credentials,
the pagination and the normalisation stay in one language and on one side of the line, and
a chart can be re-drawn a hundred times off one request.

Not a package under `packages/`, because that path is the npm workspace glob — a
`pyproject.toml` and a virtualenv in there would make a Python project pretend to be a
workspace member. `uv` owns this directory; npm does not know it exists.

## Setup

```bash
uv sync --project viz
```

That is all of it. `uv` reads `pyproject.toml`, fetches the Python in `.python-version`
if the machine has not got it, and builds `.venv/` — both it and `data/` are gitignored.
The pinned interpreter is not fussiness: matplotlib's wheels lag new CPython releases by
months, and the system Python here is ahead of them.

## Charts

| Script | Reads | Draws |
| --- | --- | --- |
| `option_delta_surface.py` | `data/option-delta-surface.json` | An option chain's delta as a surface over strike and expiration |

Each one is two commands — write the data, then draw it:

```bash
npm run option-delta-surface -w @fleece/playground
uv run --project viz viz/option_delta_surface.py
```

Every script saves a PNG next to its data and then opens an interactive window. Rotating
a 3D surface is most of the value in one, so the window is the point and the PNG is the
copy you keep. `MPLBACKEND=Agg` in front of the command skips the window when you only
want the file.

## The data format

Tidy JSON: a small envelope of metadata, then one record per row.

```json
{
  "underlying": "AAPL",
  "type": "call",
  "generatedAt": "2026-09-09T06:50:38.850Z",
  "spot": 316.22,
  "contracts": [{ "symbol": "AAPL260911C00277500", "expiration": "2026-09-11", "strike": 277.5, "delta": 0.981, "...": "the rest of the greeks" }]
}
```

One record per contract rather than a grid, because an option chain has not got one: a
weekly lists far fewer strikes than the monthly beside it, and a grid built on the
TypeScript side would have to invent the strikes that are missing. The renderer
triangulates the points that exist instead. Shaping the data for the picture is the
picture's business.

The envelope travels with the rows so a chart can title itself — what it is, when it was
taken, what the underlying was worth — without a second file or a filename convention.

## Adding one

Write `<name>.py` here and have the TypeScript that feeds it write `data/<name>.json`.
The dependencies are shared, so a new chart needs no `uv` command of its own unless it
needs a library the others do not.
