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
| `option_chain.py` | `data/option-chain.json` | An option chain in eight contour panels — delta, implied volatility, theta and mid price, across the calls and across the puts |
| `option_term_structure.py` | `data/option-chain.json` | The same eight panels as lines against days to expiry, one line per strike |

Write the data once, then draw either:

```bash
npm run option-chain -w @fleece/playground
uv run --project viz viz/option_chain.py
uv run --project viz viz/option_term_structure.py
```

The two read the same file and are worth having side by side: the contour chart shows the
whole surface at once, and the term structure takes cross-sections along it, which is the
view that answers how one contract behaves as expiry approaches.

The figure is two rows and four columns. The top row is the call chain and the bottom row
the put chain; every panel plots strike across and expiration up, on axes all eight share,
so a feature at one strike and expiry lands at the same place in all of them. Each column
carries one colourbar for both of its rows, which is what makes the two chains comparable
rather than merely adjacent.

`tricontourf` rather than a gridded contour, because the chain is ragged: weeklies list far
fewer strikes than the monthlies beside them, so there is no rectangle to hand a gridded
plotter without inventing the strikes that are missing. The triangles that would bridge the
gaps at the edge of the chain are dropped, so the coloured footprint is the shape of the
data rather than the convex hull thrown around it.

**Every contract the writer priced is drawn, on both sides of spot.** What the panels
differ on is which contracts the twelve colours are spent on, and there are two knobs for
it on `Panel` in the script — `scale` for how the bands are spaced, `calibrate` for which
contracts set the ends. Both have their reasoning written next to them. The short of it:

- **Implied volatility** calibrates on the out-of-the-money contracts. An in-the-money
  contract trades a couple of hundred dollars of intrinsic value for a few cents of
  extrinsic, so the volatility solved out of its quote is largely the width of that
  spread. On one real AAPL chain the in-the-money half ran 10% to 163% and the
  out-of-the-money half 23% to 88%. Calibrated on the whole chain, the skew gets two bands
  out of twelve. The in-the-money contracts are still drawn — they saturate into the end
  band, under the arrow that says the data goes further — but at the top of the scale they
  are no longer distinguishable from a genuine wing. Read the smile on the
  out-of-the-money half: left of spot in the put row, right of it in the call row.
- **Theta** is spaced by ratio rather than by interval. It is not a spread, it is a power
  law — decay goes as one over the root of the time left, so an at-the-money contract a day
  out decays hundreds of times faster than a quarterly wing. A linear scale drawn to the
  second percentile still put 58% of one real chain's contracts in a single band.

### Reading it after hours

Run it while the option market is open, and the chart will tell you if you did not.

The writer checks the chain against put-call parity: a call and a put on the same strike
are one claim decomposed two ways, so they share an implied volatility, and two different
numbers mean the greeks and the quotes they were solved from are looking at different
underlying prices. That is the normal state of affairs after hours — OPRA stops quoting at
the option close while the stock trades on.

The calls are a row and the puts are a row on one shared scale, so the error arrives as two
rows sitting at visibly different levels — a reading rather than a forgery. It is measured,
logged, and stamped across the top of the figure in orange, and the chain is written either
way. See `SEAM_TOLERANCE` in `packages/playground/src/option-chain.ts`.

The script saves a PNG next to its data and then opens a window. `MPLBACKEND=Agg` in front
of the command skips the window.

## Term structure

Days to expiry along x, counting down so the axis runs the way the contracts do. One line
per strike, coloured by strike and labelled with it at the expiry end. The strike nearest
spot is drawn in orange over the top, since one hue out of a sequential ramp cannot be
picked out and it is the line a reader looks for first.

Labels are placed in two passes — spread upwards where lines converge, then pulled back
down from the ceiling — because a column whose lines all run together near the top, which
is delta at expiry and theta everywhere, would otherwise stack its labels out over the
title. They are nudged rather than dropped: the strikes that collide are exactly the ones a
reader cannot tell apart by position.

Only strikes quoted at `MIN_EXPIRATIONS` or more are drawn. A chain lists fine strikes near
the front month that exist nowhere else — on one AMZN chain, 13 of 29 strikes appeared at
one or two expirations — and a two-point line reads as a trend it has no standing to claim.
`MAX_LINES` caps the rest, spread by rank rather than by price so a chain that lists
half-strikes near the money does not spend most of its lines on the middle.

A column shares one y range between its call row and its put row, which is what makes the
two comparable — except delta, where the two occupy opposite halves of -1 to 1 and sharing
would leave each row using half its panel. That is the `share_rows` field on `Panel`.

## The data format

Tidy JSON: a small envelope of metadata, then one record per row.

```json
{
  "underlying": "AAPL",
  "generatedAt": "2026-09-10T04:47:11.739Z",
  "spot": 315.34,
  "seam": { "expirations": 13, "disagreement": 0.104, "greeksAhead": 2.58, "tolerance": 0.01, "stale": true },
  "seamNote": "Puts and calls disagree by 10.4 volatility points at the money ...",
  "contracts": [{ "symbol": "AAPL260911C00277500", "expiration": "2026-09-11", "strike": 277.5, "type": "call", "delta": 0.981, "iv": 0.42, "bid": 38.1, "ask": 38.6, "mid": 38.35, "...": "the rest of the greeks" }]
}
```

One record per contract rather than a grid, because an option chain has not got one: a
weekly lists far fewer strikes than the monthly beside it, and a grid built on the
TypeScript side would have to invent the strikes that are missing. The renderer
triangulates the points that exist instead. Shaping the data for the picture is the
picture's business.

Every measure is nullable and every key is always present, so a reader never has to ask
whether a missing field means missing or means zero — Alpaca omits the greeks and the
volatility wherever it could not solve them, which is around four contracts in ten of a
large chain. Nothing is filtered on the way out except a contract carrying neither greeks
nor a quote, which no panel could draw. The renderer drops the nulls panel by panel, so a
contract that is quoted but unsolved still appears in the price panel and simply is not in
the volatility one.

The envelope travels with the rows so a chart can title itself — what it is, when it was
taken, what the underlying was worth, whether the quotes behind it were stale — without a
second file or a filename convention.

## Adding one

Write `<name>.py` here and have the TypeScript that feeds it write `data/<name>.json`.
The dependencies are shared, so a new chart needs no `uv` command of its own unless it
needs a library the others do not.
