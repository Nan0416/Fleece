"""The implied-volatility surface of an option chain, from the JSON `option-iv-surface.ts` writes.

    npm run option-iv-surface -w @fleece/playground   # fetches, writes data/*.json
    uv run --project viz viz/option_iv_surface.py     # draws it

x is the strike, y the time to expiry, z the implied volatility.

The shape is the point. Black-Scholes assumes one volatility for every contract on an
underlying, which would draw this flat; the market does not agree, and the two ways it
disagrees are the two axes. Across strike it is the skew — puts bid up over calls, because
the crash the buyer is insuring against is the one that happens all at once. Along expiry
it is the term structure, which near-dated events push around and distance flattens.

`plot_trisurf` rather than `plot_surface`, as with the delta surface and more so here: the
chain is ragged to begin with — weeklies list far fewer strikes than monthlies — and the
minimum-bid filter makes it raggeder in a way that is itself informative. The near-dated
expirations survive it across about ±10% of spot and the quarterlies across ±35%, because
that is how far out anyone is willing to bid. So the footprint of this surface is a wedge,
not a rectangle, and it is drawn as a wedge.

The y axis is the square root of the days to expiry. The delta surface's argument for
plotting against days rather than one tick per expiration holds here — a month and a week
should not be drawn the same width — but volatility asks for one more step. Variance
accumulates with time and volatility is its square root, so a root-time axis is the one on
which a flat term structure is flat and a diffusion spreads at a constant angle. It also
happens to be what makes the chart readable: thirteen expirations in a hundred days are
not evenly spaced, seven of them fall inside the first fortnight, and on a linear axis that
whole crowded near end — where the structure actually moves — is squeezed into the first
sixth of the plot. The ticks carry dates, so nothing has to be read off the spacing.
"""

import json
from datetime import date, datetime
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import PercentFormatter

DATA = Path(__file__).parent / "data" / "option-iv-surface.json"
OUTPUT = Path(__file__).parent / "data" / "option-iv-surface.png"

# Ink, not series colour: everything that is text or furniture stays grey, and the one
# thing carrying a value is the surface. Same tokens as the delta surface — the two charts
# are one family and should read as one.
INK = "#1f2328"
MUTED = "#6b7280"
GRID = "#dcdfe4"
SURFACE = "#ffffff"
SPOT = "#c2410c"

# Volatility is a magnitude on one scale, so the colour is sequential, and viridis for the
# reason the delta surface picks it: monotonic in lightness, and it holds that order under
# every kind of colour blindness where a rainbow does not. The colourbar is the legend,
# since there is only the one measure.
COLORMAP = "viridis"

# Roughly this many dates on the y axis, thinned by how far apart they fall on the axis as
# drawn rather than by every nth — root-time still leaves the weeklies closer together than
# the monthlies, and every nth would keep a colliding pair and drop a well-spaced one.
MAX_DATE_TICKS = 6

# The z axis is rounded out to a multiple of this, so the ticks land on round percentages
# rather than on whatever the widest wing happened to quote.
Z_STEP = 0.05


def main() -> None:
    if not DATA.exists():
        raise SystemExit(f"No data at {DATA}. Run: npm run option-iv-surface -w @fleece/playground")

    payload = json.loads(DATA.read_text())
    contracts = payload["contracts"]
    if not contracts:
        raise SystemExit(f"{DATA} holds no contracts.")

    as_of = datetime.fromisoformat(payload["generatedAt"]).date()
    spot = payload["spot"]

    strike = np.array([c["strike"] for c in contracts], dtype=float)
    term = np.array([term_axis(days_to(c["expiration"], as_of)) for c in contracts], dtype=float)
    iv = np.array([c["iv"] for c in contracts], dtype=float)

    plt.rcParams.update(
        {
            "figure.facecolor": SURFACE,
            "axes.facecolor": SURFACE,
            "savefig.facecolor": SURFACE,
            "grid.color": GRID,
            "grid.linewidth": 0.6,
            "text.color": INK,
            "axes.labelcolor": MUTED,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "font.size": 10,
        }
    )

    figure = plt.figure(figsize=(12, 8.5))
    axes = figure.add_subplot(111, projection="3d")
    # mplot3d leaves a wide margin around the cube by default, which under a title reads as
    # a hole. Widen the strike axis, flatten volatility, and zoom the whole thing into its box.
    axes.set_box_aspect((1.45, 1.0, 0.72), zoom=1.08)
    figure.subplots_adjust(left=0.0, right=0.94, bottom=0.04, top=0.99)

    # A hairline in the surface colour between facets, so the mesh reads as a shape
    # rather than as a single poured sheet, without drawing a wireframe over the data.
    surface = axes.plot_trisurf(strike, term, iv, cmap=COLORMAP, linewidth=0.15, edgecolor=SURFACE, antialiased=True)

    floor, ceiling = z_bounds(iv)
    axes.set_zlim(floor, ceiling)
    axes.zaxis.set_major_formatter(PercentFormatter(xmax=1))
    for axis in (axes.xaxis, axes.yaxis, axes.zaxis):
        axis.set_pane_color(SURFACE)
        axis.line.set_color(GRID)

    # Spot on the floor of the plot. On the delta surface this is a check that the picture
    # is the right way round; here it is also the seam, because every contract left of it
    # is a put and every one right of it is a call. That the surface crosses the line
    # without a step is the whole of the parity check the writer ran, made visible.
    axes.plot([spot, spot], [term.min(), term.max()], [floor, floor], color=SPOT, linewidth=1.4, linestyle=(0, (4, 3)), zorder=10)
    axes.text(spot, term.min(), floor, f"spot {spot:,.2f}  ", color=SPOT, fontsize=9, ha="right", va="top")

    label_expirations(axes, contracts, as_of)

    axes.set_xlabel("Strike", labelpad=12)
    axes.set_ylabel("Expiration", labelpad=26)
    axes.set_zlabel("Implied volatility", labelpad=8)
    axes.tick_params(colors=MUTED, length=0)
    axes.view_init(elev=24, azim=-128)

    # Colour repeats what height already says. That redundancy is the point in 3D — it is
    # what lets you read a value where the perspective is ambiguous — but the bar does not
    # need a second caption when the z axis is already carrying one.
    bar = figure.colorbar(surface, ax=axes, shrink=0.45, aspect=24, pad=0.02, format=PercentFormatter(xmax=1))
    bar.outline.set_edgecolor(GRID)
    bar.ax.tick_params(colors=MUTED, length=0)

    figure.suptitle(f"{payload['underlying']} implied volatility", x=0.045, y=0.975, ha="left", fontsize=15, weight="bold", color=INK)
    figure.text(
        0.045,
        0.935,
        f"{len(contracts)} out-of-the-money contracts — puts below spot, calls above — "
        f"{len({c['expiration'] for c in contracts})} expirations · {as_of:%-d %B %Y} · spot {spot:,.2f}",
        ha="left",
        fontsize=10,
        color=MUTED,
    )

    figure.savefig(OUTPUT, dpi=160, bbox_inches="tight")
    print(f"Wrote {OUTPUT}")
    plt.show()


def days_to(expiration: str, as_of: date) -> int:
    return (date.fromisoformat(expiration) - as_of).days


def term_axis(days: float) -> float:
    """Where a number of days to expiry sits on the y axis. See the module docstring."""
    return float(np.sqrt(max(days, 0)))


def z_bounds(iv: np.ndarray) -> tuple[float, float]:
    """The volatility axis, rounded out to whole `Z_STEP`s.

    Out to the data rather than down to zero: a surface that runs 25% to 60% drawn on an
    axis starting at zero is a third of a plot and two thirds of an empty box. There is no
    argument for a zero baseline here — nothing is a length being compared to another
    length, and the colourbar carries the absolute reading for anyone who wants it.
    """
    return float(np.floor(iv.min() / Z_STEP) * Z_STEP), float(np.ceil(iv.max() / Z_STEP) * Z_STEP)


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


if __name__ == "__main__":
    main()
