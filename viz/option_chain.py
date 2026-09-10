"""An option chain in eight panels, from the JSON `option-chain.ts` writes.

    npm run option-chain -w @fleece/playground   # fetches, writes data/option-chain.json
    uv run --project viz viz/option_chain.py     # draws it

Two rows and four columns: calls on top, puts below; delta, implied volatility, theta and
the mid of the quote across. Every panel shares both axes — strike across, expiration up —
so a feature lands at the same place in all eight.

`tricontourf` rather than `contourf` because the chain is ragged: weeklies list far fewer
strikes than the monthlies beside them, and a gridded plotter would have to invent the
missing ones. Triangles bridging the gaps at the edge of the chain are dropped, so the
footprint is the shape of the data rather than its convex hull.

The y axis is the square root of the days to expiry, the axis on which a flat term
structure is flat and a diffusion spreads at a constant angle. The ticks carry dates.

Every contract the writer priced is drawn, both sides of spot. What varies is which
contracts the twelve colours are spent on — the `scale` and `calibrate` fields on `Panel`.
"""

import json
from datetime import date, datetime
from pathlib import Path
from typing import Callable, NamedTuple

import matplotlib.patheffects as effects
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import FuncFormatter, MaxNLocator
from matplotlib.tri import Triangulation

DATA = Path(__file__).parent / "data" / "option-chain.json"
OUTPUT = Path(__file__).parent / "data" / "option-chain.png"

# Text and furniture stay grey; only the contour fills carry a value.
INK = "#1f2328"
MUTED = "#6b7280"
GRID = "#dcdfe4"
SURFACE = "#ffffff"
SPOT = "#c2410c"

# Viridis is monotonic in lightness and holds that order under every kind of colour
# blindness. Delta gets a diverging pair because zero is a real place on its scale.
SEQUENTIAL = "viridis"
DIVERGING = "RdBu_r"

# Roughly this many bands per panel — roughly, because the boundaries are then moved onto
# round numbers, so a value can be read off the colourbar without interpolating.
LEVELS = 20

# Label every nth contour line. All of them on a panel this size is a thicket.
LABEL_EVERY = 5

# At most this many labels on a colourbar, whatever `LEVELS` is set to. Every band boundary
# is a tick, and past this they collide on a bar this narrow.
MAX_BAR_TICKS = 8

# The percentile the colour scale runs between, so one outlying contract cannot set the
# ends of a ramp the whole chain is drawn on. Where it bites, the colourbar grows an arrow;
# every contract is drawn either way.
ROBUST_PERCENTILE = 2.0

# A triangle whose longest side exceeds this many times the median is dropped: Delaunay
# fills the convex hull, and the slivers reaching across the chain's ragged corners
# interpolate between contracts that have nothing to do with each other. Measured in
# axis-normalised space, so "long" means long as drawn.
SLIVER = 4.0

# Roughly this many dates on the y axis, thinned by how far apart they fall as drawn —
# every nth would keep a colliding pair and drop a well-spaced one.
MAX_DATE_TICKS = 7


class Panel(NamedTuple):
    """One column: the measure it draws, and how its colour scale is built.

    `scale` spaces the bands: `linear` by equal intervals, `ratio` by equal multiples (for
    a measure spread over orders of magnitude — theta goes as one over the root of the time
    left, and on a linear scale 58% of a real chain landed in one band), `diverging` about
    zero for a measure with a sign.

    `calibrate` picks which contracts set the ends — `all`, or `out-of-the-money` for a
    measure of time value, whose in-the-money reading is mostly the width of a quote that
    is nearly all intrinsic. Everything is drawn either way; a contract outside the range
    saturates into the end band under the colourbar's arrow.
    """

    key: str
    title: str
    scale: str
    calibrate: str
    format: Callable[[float], str]


def money(value: float) -> str:
    """Cents below ten dollars, whole dollars above — one panel holds both."""
    return f"${value:,.0f}" if abs(value) >= 10 else f"${value:,.2f}"


def decay(value: float) -> str:
    """Ratio spacing puts 0.006 and 2.4 on one bar, which no fixed precision writes."""
    return f"{value:.2f}" if abs(value) >= 0.1 else f"{value:.3f}"


PANELS = (
    Panel("delta", "Delta", "diverging", "all", lambda v: f"{v:.2f}"),
    Panel("iv", "Implied volatility", "linear", "out-of-the-money", lambda v: f"{v * 100:.0f}%"),
    Panel("theta", "Theta", "ratio", "all", decay),
    # `ratio` here if the wings matter more than the body: premium runs from half a cent to
    # a hundred dollars, and linear spends most of the ramp above $50.
    Panel("mid", "Mid price", "linear", "all", money),
)

ROWS = (("call", "Calls"), ("put", "Puts"))


def main() -> None:
    if not DATA.exists():
        raise SystemExit(f"No data at {DATA}. Run: npm run option-chain -w @fleece/playground")

    payload = json.loads(DATA.read_text())
    contracts = payload["contracts"]
    if not contracts:
        raise SystemExit(f"{DATA} holds no contracts.")

    as_of = datetime.fromisoformat(payload["generatedAt"]).date()
    spot = payload["spot"]
    chains = {side: [c for c in contracts if c["type"] == side] for side, _ in ROWS}

    apply_style()
    figure, grid = plt.subplots(2, 4, figsize=(18, 9), sharex=True, sharey=True, layout="constrained")
    figure.get_layout_engine().set(rect=(0.006, 0.006, 0.988, 0.885))

    for column, panel in enumerate(PANELS):
        levels, extend = contour_levels(chains, panel, spot)
        colours = DIVERGING if panel.scale == "diverging" else SEQUENTIAL
        drawn = None

        for row, (side, _) in enumerate(ROWS):
            axes = grid[row][column]
            drawn = draw(axes, chains[side], panel, levels, extend, colours, as_of) or drawn
            axes.axvline(spot, color=SPOT, linewidth=1.1, linestyle=(0, (4, 3)), zorder=6)

        if drawn is not None:
            bar = figure.colorbar(
                drawn,
                ax=list(grid[:, column]),
                location="bottom",
                shrink=0.86,
                aspect=34,
                pad=0.015,
                format=FuncFormatter(lambda v, _, write=panel.format: write(v)),
                ticks=bar_ticks(levels, panel),
            )
            bar.outline.set_edgecolor(GRID)
            bar.ax.tick_params(colors=MUTED, length=0, labelsize=8)

        grid[0][column].set_title(panel.title, fontsize=11, color=INK, pad=8)

    for row, (_, label) in enumerate(ROWS):
        grid[row][0].set_ylabel(label, fontsize=12, color=INK, weight="bold", labelpad=8)

    label_expirations(grid[0][0], contracts, as_of)
    grid[1][0].set_xlabel("Strike", fontsize=10, color=MUTED, labelpad=6)

    title(figure, payload, contracts, as_of, spot)

    figure.savefig(OUTPUT, dpi=160)
    print(f"Wrote {OUTPUT}")
    plt.show()


def apply_style() -> None:
    plt.rcParams.update(
        {
            "figure.facecolor": SURFACE,
            "axes.facecolor": SURFACE,
            "savefig.facecolor": SURFACE,
            "axes.edgecolor": GRID,
            "axes.linewidth": 0.8,
            "text.color": INK,
            "axes.labelcolor": MUTED,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "font.size": 10,
        }
    )


def bar_ticks(levels, panel: Panel):
    """Every nth band boundary, thinned to `MAX_BAR_TICKS`.

    Counted outwards from the centre on a diverging scale, so zero always carries a tick —
    it is the one value on that bar a reader needs to find.
    """
    stride = max(1, -(-len(levels) // MAX_BAR_TICKS))
    if panel.scale != "diverging":
        return levels[::stride]
    middle = (len(levels) - 1) // 2
    return levels[middle % stride :: stride]


def draw(axes, chain, panel: Panel, levels, extend: str, colours, as_of: date):
    """One panel. Returns the filled contour set, or None where there was nothing to draw."""
    axes.tick_params(colors=MUTED, length=0, labelsize=9)

    strike, term, value = points(chain, panel.key, as_of)
    triangles = triangulate(strike, term)
    if triangles is None:
        axes.text(0.5, 0.5, "not enough priced contracts", transform=axes.transAxes, ha="center", va="center", color=MUTED, fontsize=9)
        return None

    filled = axes.tricontourf(triangles, value, levels=levels, cmap=colours, extend=extend)

    # The bands are already edge to edge, so the lines exist only to be labelled. A fill
    # running near-black to near-yellow has no one legible text colour, so each label
    # carries a white halo out with it.
    lines = axes.tricontour(triangles, value, levels=levels[1:-1], colors=INK, linewidths=0.3, alpha=0.16)
    labels = axes.clabel(lines, levels=levels[1:-1][::LABEL_EVERY], fmt=panel.format, fontsize=8, colors=INK, inline_spacing=4)
    for label in labels:
        label.set_path_effects([effects.withStroke(linewidth=1.6, foreground=SURFACE)])

    return filled


def points(chain, key: str, as_of: date):
    """The contracts of one chain that carry this measure, as three parallel arrays."""
    kept = [c for c in chain if c.get(key) is not None]
    strike = np.array([c["strike"] for c in kept], dtype=float)
    term = np.array([term_axis(days_to(c["expiration"], as_of)) for c in kept], dtype=float)
    value = np.array([c[key] for c in kept], dtype=float)
    return strike, term, value


def contour_levels(chains, panel: Panel, spot: float):
    """The band boundaries for one column, and which ends of them the data runs past.

    Shared by both rows, which is the point of the column: volatility on one scale is where
    a stale chain gives itself away, as two rows at visibly different levels for contracts
    parity says share a number.
    """
    drawn = measured(chains, panel.key, lambda _: True, spot)
    if drawn.size == 0:
        return np.linspace(0.0, 1.0, LEVELS + 1), "neither"

    if panel.scale == "diverging":
        bound = float(np.abs(drawn).max()) or 1.0
        return MaxNLocator(nbins=LEVELS, symmetric=True).tick_values(-bound, bound), "neither"

    calibrating = drawn if panel.calibrate == "all" else measured(chains, panel.key, lambda c: out_of_the_money(c, spot), spot)
    if calibrating.size == 0:
        calibrating = drawn

    low, high = (float(v) for v in np.percentile(calibrating, [ROBUST_PERCENTILE, 100 - ROBUST_PERCENTILE]))
    if high <= low:
        low, high = float(calibrating.min()), float(calibrating.max())
    if high <= low:
        return np.linspace(low - 0.5, low + 0.5, LEVELS + 1), "neither"

    levels = ratio_levels(low, high) if panel.scale == "ratio" else None
    if levels is None:
        levels = trim(MaxNLocator(nbins=LEVELS).tick_values(low, high), calibrating)

    return levels, extent_of(drawn, levels)


def measured(chains, key: str, keep, spot: float) -> np.ndarray:
    """Every value of one measure across both chains, from the contracts `keep` accepts."""
    return np.array(
        [c[key] for chain in chains.values() for c in chain if c.get(key) is not None and keep(c)],
        dtype=float,
    )


def out_of_the_money(contract, spot: float) -> bool:
    """A call above spot, a put below. The strike landing on spot goes to the puts."""
    return contract["strike"] > spot if contract["type"] == "call" else contract["strike"] <= spot


def ratio_levels(low: float, high: float):
    """Boundaries spaced by equal multiples, worked out on the magnitudes and signed back.

    `None` where the range straddles zero, which no ratio can span.
    """
    if low > 0 and high > 0:
        return np.geomspace(low, high, LEVELS + 1)
    if low < 0 and high < 0:
        return -np.geomspace(abs(low), abs(high), LEVELS + 1)
    return None


def trim(levels: np.ndarray, values: np.ndarray) -> np.ndarray:
    """The rounded boundaries, with the ones no contract reaches dropped.

    An empty band takes a colour off the ramp, so the outermost contracts get drawn in the
    second colour from the end and the reader hunts the chart for the first.
    """
    first = max(0, int(np.searchsorted(levels, values.min(), side="right")) - 1)
    last = min(levels.size - 1, int(np.searchsorted(levels, values.max(), side="left")))
    return levels[first : last + 1] if last > first else levels


def extent_of(values: np.ndarray, levels) -> str:
    """Which ends of the scale the data runs past, in the word `contourf` wants for it.

    Asked of every contract drawn, not of the ones the scale was calibrated on.
    """
    below, above = float(values.min()) < levels[0], float(values.max()) > levels[-1]
    if below and above:
        return "both"
    return "min" if below else "max" if above else "neither"


def triangulate(strike: np.ndarray, term: np.ndarray):
    """Delaunay over the contracts, with the slivers that bridge the chain's gaps dropped.

    Triangulated in axis-normalised space and rebuilt on the real coordinates: strike runs
    over hundreds of dollars and root-time over about ten, so triangulating the raw numbers
    would judge shape and slivers by the units rather than the data.
    """
    if strike.size < 3:
        return None

    try:
        normalised = Triangulation(unit(strike), unit(term))
    except (ValueError, RuntimeError):
        return None

    triangles = Triangulation(strike, term, triangles=normalised.triangles)
    longest = triangle_sides(unit(strike), unit(term), normalised.triangles).max(axis=1)
    mask = longest > SLIVER * float(np.median(longest))
    if mask.any() and not mask.all():
        triangles.set_mask(mask)
    return triangles


def triangle_sides(x: np.ndarray, y: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    """The three side lengths of every triangle, as a (triangles, 3) array."""
    corners = np.stack([x, y], axis=1)[triangles]
    return np.linalg.norm(corners - np.roll(corners, 1, axis=1), axis=2)


def unit(values: np.ndarray) -> np.ndarray:
    """The values rescaled onto 0 to 1, so two axes in different units can be compared."""
    low, high = float(values.min()), float(values.max())
    return (values - low) / (high - low) if high > low else np.zeros_like(values)


def days_to(expiration: str, as_of: date) -> int:
    return (date.fromisoformat(expiration) - as_of).days


def term_axis(days: float) -> float:
    """Where a number of days to expiry sits on the y axis. See the module docstring."""
    return float(np.sqrt(max(days, 0)))


def label_expirations(axes, contracts, as_of: date) -> None:
    """Ticks at the expirations that exist, labelled with the date rather than the count."""
    expirations = sorted({c["expiration"] for c in contracts})
    positions = [term_axis(days_to(e, as_of)) for e in expirations]
    smallest_gap = (max(positions) - min(positions)) / MAX_DATE_TICKS

    shown = []
    for expiration, position in zip(expirations, positions):
        if not shown or position - shown[-1][1] >= smallest_gap:
            shown.append((expiration, position))

    axes.set_yticks([position for _, position in shown])
    axes.set_yticklabels([f"{date.fromisoformat(e):%-d %b}" for e, _ in shown], fontsize=9)


def title(figure, payload, contracts, as_of: date, spot: float) -> None:
    calls = sum(1 for c in contracts if c["type"] == "call")
    expirations = len({c["expiration"] for c in contracts})

    figure.suptitle(f"{payload['underlying']} option chain", x=0.008, y=0.982, ha="left", fontsize=16, weight="bold", color=INK)
    figure.text(
        0.008,
        0.947,
        f"{calls} calls and {len(contracts) - calls} puts across {expirations} expirations · "
        f"{as_of:%-d %B %Y} · strike across, expiration up · the dashed line is spot at {spot:,.2f}",
        ha="left",
        fontsize=10,
        color=MUTED,
    )

    stamp = seam_stamp(payload.get("seam"))
    if stamp is not None:
        # `wrap` is the safety net: the stamp is written to fit one line at this width.
        figure.text(0.008, 0.917, stamp, ha="left", fontsize=9, color=SPOT, wrap=True)


def seam_stamp(seam) -> str | None:
    """The parity warning, where there is one, in a line."""
    if seam is None:
        return "No strike is quoted on both sides, so put-call parity could not be checked. Read the two rows as unverified."
    if not seam["stale"]:
        return None
    return (
        f"Stale quotes: the calls and puts disagree by {seam['disagreement'] * 100:.1f} volatility points at the money against a "
        f"tolerance of {seam['tolerance'] * 100:.1f} — the greeks are marked against an underlying ${abs(seam['greeksAhead']):.2f} "
        f"{'above' if seam['greeksAhead'] >= 0 else 'below'} the quoted one, so the two rows sit offset. Re-run during the option session."
    )


if __name__ == "__main__":
    main()
