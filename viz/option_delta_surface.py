"""The delta surface of an option chain, from the JSON `option-delta-surface.ts` writes.

    npm run option-delta-surface -w @fleece/playground   # fetches, writes data/*.json
    uv run --project viz viz/option_delta_surface.py     # draws it

x is the strike, y the days to expiry, z the delta.

`plot_trisurf` rather than `plot_surface`, because the chain is ragged: the weeklies list
far fewer strikes than the monthlies, so there is no rectangular grid to hand
`plot_surface` without inventing the strikes that are missing. `plot_trisurf` triangulates
the points that exist and leaves it at that.

The y axis is days to expiry rather than the date itself. It is the axis delta actually
moves along — an option's delta is a function of the time left, not of the calendar — and
it spaces the weeklies and the monthlies apart honestly, where one tick per expiration
would draw a month and a week the same width. The ticks are relabelled with the dates.
"""

import json
from datetime import date, datetime
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

DATA = Path(__file__).parent / "data" / "option-delta-surface.json"
OUTPUT = Path(__file__).parent / "data" / "option-delta-surface.png"

# Ink, not series colour: everything that is text or furniture stays grey, and the one
# thing carrying a value is the surface.
INK = "#1f2328"
MUTED = "#6b7280"
GRID = "#dcdfe4"
SURFACE = "#ffffff"
SPOT = "#c2410c"

# Delta is a magnitude on one scale, so the colour is sequential. Viridis is monotonic in
# lightness and holds that order under every kind of colour blindness, which a rainbow
# does not — and the colourbar is the legend, since there is only the one measure.
COLORMAP = "viridis"

# Roughly this many dates on the y axis. Thirteen of them in 100 days overlap, and they
# are not evenly spaced — four in the first fortnight, then monthlies — so they are thinned
# by how far apart they fall rather than by every nth, which would still collide up front.
MAX_DATE_TICKS = 6


def main() -> None:
    if not DATA.exists():
        raise SystemExit(f"No data at {DATA}. Run: npm run option-delta-surface -w @fleece/playground")

    payload = json.loads(DATA.read_text())
    contracts = payload["contracts"]
    if not contracts:
        raise SystemExit(f"{DATA} holds no contracts.")

    as_of = datetime.fromisoformat(payload["generatedAt"]).date()
    spot = payload["spot"]

    strike = np.array([c["strike"] for c in contracts], dtype=float)
    dte = np.array([days_to(c["expiration"], as_of) for c in contracts], dtype=float)
    delta = np.array([c["delta"] for c in contracts], dtype=float)

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
    # a hole. Widen the strike axis, flatten delta, and zoom the whole thing into its box.
    axes.set_box_aspect((1.45, 1.0, 0.72), zoom=1.08)
    figure.subplots_adjust(left=0.0, right=0.94, bottom=0.04, top=0.99)

    # A hairline in the surface colour between facets, so the mesh reads as a shape
    # rather than as a single poured sheet, without drawing a wireframe over the data.
    surface = axes.plot_trisurf(strike, dte, delta, cmap=COLORMAP, linewidth=0.15, edgecolor=SURFACE, antialiased=True)

    axes.set_zlim(0.0, 1.0)
    for axis in (axes.xaxis, axes.yaxis, axes.zaxis):
        axis.set_pane_color(SURFACE)
        axis.line.set_color(GRID)

    # Spot on the floor of the plot: the 0.5 contour should sit near it, and seeing that
    # it does is the quickest check that the surface is the right way round.
    axes.plot([spot, spot], [dte.min(), dte.max()], [0.0, 0.0], color=SPOT, linewidth=1.4, linestyle=(0, (4, 3)), zorder=10)
    axes.text(spot, dte.max(), 0.0, f"  spot {spot:,.2f}", color=SPOT, fontsize=9)

    label_expirations(axes, contracts, as_of)

    axes.set_xlabel("Strike", labelpad=12)
    axes.set_ylabel("Expiration", labelpad=26)
    axes.set_zlabel("Delta", labelpad=6)
    axes.tick_params(colors=MUTED, length=0)
    axes.view_init(elev=26, azim=-131)

    # Colour repeats what height already says. That redundancy is the point in 3D — it is
    # what lets you read a value where the perspective is ambiguous — but the bar does not
    # need a second "Delta" caption when the z axis is already carrying one.
    bar = figure.colorbar(surface, ax=axes, shrink=0.45, aspect=24, pad=0.02)
    bar.outline.set_edgecolor(GRID)
    bar.ax.tick_params(colors=MUTED, length=0)

    figure.suptitle(f"{payload['underlying']} {payload['type']} delta", x=0.045, y=0.975, ha="left", fontsize=15, weight="bold", color=INK)
    figure.text(
        0.045,
        0.935,
        f"{len(contracts)} contracts, {len({c['expiration'] for c in contracts})} expirations · {as_of:%-d %B %Y} · spot {spot:,.2f}",
        ha="left",
        fontsize=10,
        color=MUTED,
    )

    figure.savefig(OUTPUT, dpi=160, bbox_inches="tight")
    print(f"Wrote {OUTPUT}")
    plt.show()


def days_to(expiration: str, as_of: date) -> int:
    return (date.fromisoformat(expiration) - as_of).days


def label_expirations(axes, contracts, as_of: date) -> None:
    """Ticks at the expirations that exist, labelled with the date rather than the count."""
    expirations = sorted({c["expiration"] for c in contracts})
    days = [days_to(e, as_of) for e in expirations]
    smallest_gap = (max(days) - min(days)) / MAX_DATE_TICKS

    shown = []
    for expiration, day in zip(expirations, days):
        if not shown or day - shown[-1][1] >= smallest_gap:
            shown.append((expiration, day))

    axes.set_yticks([day for _, day in shown])
    axes.set_yticklabels([f"{date.fromisoformat(e):%-d %b}" for e, _ in shown], fontsize=9)


if __name__ == "__main__":
    main()
