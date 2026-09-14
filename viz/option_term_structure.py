"""An option chain as term structures, from the JSON `option-chain.ts` writes.

    npm run option-chain -w @fleece/playground   # fetches, writes data/option-chain.json
    uv run --project viz viz/option_term_structure.py

Two rows and four columns: calls on top, puts below; delta, implied volatility, theta and
the mid of the quote across. Every panel plots days to expiry along x, one line per strike,
coloured by strike on one scale the whole figure shares.

The same data the contour chart draws, sliced the other way: a contour panel shows the
whole surface at once and this shows cross-sections along it, which is the view that
answers how one contract behaves as expiry approaches.

Lines are drawn only for strikes quoted at `MIN_EXPIRATIONS` or more, because a chain
lists fine strikes near the front month that exist nowhere else — a two-point line reads
as a trend it has no standing to claim.
"""

import json
from datetime import date, datetime
from pathlib import Path
from typing import Callable, NamedTuple

import matplotlib.patheffects as effects
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.cm import ScalarMappable
from matplotlib.colors import Normalize
from matplotlib.ticker import FuncFormatter

DATA = Path(__file__).parent / "data" / "option-chain.json"
OUTPUT = Path(__file__).parent / "data" / "option-term-structure.png"

# Text and furniture stay grey; only the lines carry a value.
INK = "#1f2328"
MUTED = "#6b7280"
GRID = "#dcdfe4"
SURFACE = "#ffffff"
SPOT = "#c2410c"

# Strike is an ordered quantity, so its colour is a sequential ramp rather than a set of
# categorical hues — a legend of twenty entries is not a legend.
STRIKES = "viridis"

# At most this many lines. More than this and neighbouring strikes are indistinguishable
# in both colour and position, and there is no room to label them.
MAX_LINES = 10

# A strike needs this many expirations to be drawn at all.
MIN_EXPIRATIONS = 4

# Room kept at the expiry end of the x axis for the strike labels, as a fraction of the
# span, and the least two labels may sit apart as a fraction of the y range.
LABEL_MARGIN = 0.16
MIN_LABEL_GAP = 0.052


class Panel(NamedTuple):
    key: str
    title: str
    format: Callable[[float], str]
    # Whether the call row and the put row share a y range. Worth it where the two overlap,
    # since the comparison is the reason for two rows; delta does not, and a shared -1 to 1
    # would leave each row using half its panel.
    share_rows: bool


def money(value: float) -> str:
    return f"${value:,.0f}" if abs(value) >= 10 else f"${value:,.2f}"


def decay(value: float) -> str:
    return f"{value:.2f}" if abs(value) >= 0.1 else f"{value:.3f}"


PANELS = (
    Panel("delta", "Delta", lambda v: f"{v:.2f}", False),
    Panel("iv", "Implied volatility", lambda v: f"{v * 100:.0f}%", True),
    Panel("theta", "Theta", decay, True),
    Panel("mid", "Mid price", money, True),
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
    strikes = choose_strikes(contracts)
    if not strikes:
        raise SystemExit(f"No strike in {DATA} is quoted at {MIN_EXPIRATIONS} or more expirations.")

    atm = min(strikes, key=lambda k: abs(k - spot))
    colours = Normalize(vmin=min(strikes), vmax=max(strikes))

    apply_style()
    figure, grid = plt.subplots(2, 4, figsize=(18, 9), sharex=True, layout="constrained")
    figure.get_layout_engine().set(rect=(0.006, 0.006, 0.988, 0.9))

    anchors = {}
    for column, panel in enumerate(PANELS):
        for row, (side, _) in enumerate(ROWS):
            anchors[row, column] = draw(grid[row][column], contracts, side, panel, strikes, atm, colours, as_of)
        if panel.share_rows:
            share_y(grid[:, column])
        grid[0][column].set_title(panel.title, fontsize=11, color=INK, pad=8)
        grid[1][column].xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0f}"))

    for row, (_, label) in enumerate(ROWS):
        grid[row][0].set_ylabel(label, fontsize=12, color=INK, weight="bold", labelpad=8)
    grid[1][0].set_xlabel("Days to expiry", fontsize=10, color=MUTED, labelpad=6)

    # High to low, so the axis runs the way the contracts do, with room kept at the expiry
    # end for the labels. Reversed limits rather than `invert_xaxis`, which cannot pad one
    # side. Once is enough — `sharex` carries it to the other seven.
    days = [days_to(c["expiration"], as_of) for c in contracts]
    span = max(max(days) - min(days), 1)
    grid[0][0].set_xlim(max(days) + 0.03 * span, min(days) - LABEL_MARGIN * span)
    for (row, column), anchored in anchors.items():
        label_lines(grid[row][column], anchored)

    bar = figure.colorbar(ScalarMappable(norm=colours, cmap=STRIKES), ax=grid, location="right", shrink=0.6, aspect=30, pad=0.01)
    bar.set_label("Strike", color=MUTED, fontsize=10)
    bar.outline.set_edgecolor(GRID)
    bar.ax.tick_params(colors=MUTED, length=0, labelsize=8)

    title(figure, payload, strikes, atm, as_of, spot)
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
            "grid.color": GRID,
            "grid.linewidth": 0.6,
            "text.color": INK,
            "axes.labelcolor": MUTED,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "font.size": 10,
        }
    )


def choose_strikes(contracts) -> list[float]:
    """Up to `MAX_LINES` strikes, evenly spread over those quoted often enough to draw.

    Spread by rank rather than by price, so a chain that lists half-strikes near the money
    and whole ones in the wings does not spend most of its lines on the middle.
    """
    expirations: dict[float, set[str]] = {}
    for contract in contracts:
        expirations.setdefault(contract["strike"], set()).add(contract["expiration"])

    eligible = sorted(strike for strike, seen in expirations.items() if len(seen) >= MIN_EXPIRATIONS)
    if len(eligible) <= MAX_LINES:
        return eligible

    picks = np.linspace(0, len(eligible) - 1, MAX_LINES).round().astype(int)
    return [eligible[i] for i in sorted(set(picks))]


def draw(axes, contracts, side: str, panel: Panel, strikes, atm: float, colours, as_of: date) -> None:
    axes.tick_params(colors=MUTED, length=0, labelsize=9)
    axes.grid(True, linewidth=0.5, alpha=0.7)
    axes.set_axisbelow(True)
    axes.yaxis.set_major_formatter(FuncFormatter(lambda v, _, write=panel.format: write(v)))

    ramp = plt.get_cmap(STRIKES)
    anchors = []
    for strike in strikes:
        days, values = series(contracts, side, strike, panel.key, as_of)
        if len(days) < 2:
            continue
        # The strike nearest spot in the spot colour, over the top: it is the line a reader
        # looks for first, and one hue out of a sequential ramp cannot be picked out.
        at_money = strike == atm
        axes.plot(
            days,
            values,
            color=SPOT if at_money else ramp(colours(strike)),
            linewidth=2.0 if at_money else 1.1,
            marker="o",
            markersize=2.4 if at_money else 1.8,
            zorder=5 if at_money else 3,
        )
        # `series` is oldest expiry first, so index 0 is the expiry end — the right of a
        # reversed axis, and where a label belongs.
        anchors.append((days[0], values[0], f"{strike:g}", SPOT if at_money else ramp(colours(strike)), at_money))

    if not anchors:
        axes.text(0.5, 0.5, "not enough priced contracts", transform=axes.transAxes, ha="center", va="center", color=MUTED, fontsize=9)
    return anchors


def label_lines(axes, anchors) -> None:
    """A strike written beside each line, nudged apart where the lines converge.

    Nudged rather than dropped: at the expiry end the out-of-the-money contracts run into
    the floor together, and the strikes that collide there are exactly the ones a reader
    cannot tell apart by position.
    """
    low, high = axes.get_ylim()
    span = high - low
    # Enough gap to read, but never more than the panel can hold.
    gap = min(span * MIN_LABEL_GAP, span / max(len(anchors), 1))
    placed = [list(a) for a in sorted(anchors, key=lambda a: a[1])]

    # Up from the bottom, then back down from the top. The second pass is what keeps the
    # stack inside the panel: without it a column whose lines converge near the ceiling —
    # delta at expiry, theta anywhere — pushes its labels out over the title.
    for lower, upper in zip(placed, placed[1:]):
        upper[1] = max(upper[1], lower[1] + gap)
    ceiling = high - gap / 2
    for label in reversed(placed):
        label[1] = min(label[1], ceiling)
        ceiling = label[1] - gap
    floor = low + gap / 2
    for label in placed:
        label[1] = max(label[1], floor)
        floor = label[1] + gap

    for x, y, text, colour, at_money in placed:
        label = axes.annotate(
            text,
            xy=(x, y),
            xytext=(5, 0),
            textcoords="offset points",
            ha="left",
            va="center",
            fontsize=7.5,
            color=colour,
            weight="bold" if at_money else "normal",
            annotation_clip=False,
        )
        label.set_path_effects([effects.withStroke(linewidth=1.6, foreground=SURFACE)])


def series(contracts, side: str, strike: float, key: str, as_of: date):
    """One strike's readings of one measure, oldest expiry first."""
    points = sorted(
        (days_to(c["expiration"], as_of), c[key])
        for c in contracts
        if c["type"] == side and c["strike"] == strike and c.get(key) is not None
    )
    return [d for d, _ in points], [v for _, v in points]


def share_y(column) -> None:
    """One y range down a column, so the call row and the put row can be read against each other."""
    limits = [axes.get_ylim() for axes in column if axes.lines]
    if not limits:
        return
    low, high = min(l for l, _ in limits), max(h for _, h in limits)
    for axes in column:
        axes.set_ylim(low, high)


def days_to(expiration: str, as_of: date) -> int:
    return (date.fromisoformat(expiration) - as_of).days


def title(figure, payload, strikes, atm: float, as_of: date, spot: float) -> None:
    figure.suptitle(f"{payload['underlying']} term structure by strike", x=0.008, y=0.982, ha="left", fontsize=16, weight="bold", color=INK)
    figure.text(
        0.008,
        0.947,
        f"{len(strikes)} strikes from {min(strikes):,.0f} to {max(strikes):,.0f}, quoted at {MIN_EXPIRATIONS}+ expirations · "
        f"{as_of:%-d %B %Y} · spot {spot:,.2f}, nearest strike {atm:,.0f} drawn in orange",
        ha="left",
        fontsize=10,
        color=MUTED,
    )

    seam = payload.get("seam")
    if seam is not None and seam["stale"]:
        figure.text(
            0.008,
            0.917,
            f"Stale quotes: the calls and puts disagree by {seam['disagreement'] * 100:.1f} volatility points at the money. "
            "Re-run during the option session.",
            ha="left",
            fontsize=9,
            color=SPOT,
        )


if __name__ == "__main__":
    main()
